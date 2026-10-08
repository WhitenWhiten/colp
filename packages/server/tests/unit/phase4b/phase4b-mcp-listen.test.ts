import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  createMcp20260728RequestContext,
  createMcp20260728SubscriptionsListenAdapter,
  mapOAuthEvidenceToAuthenticatedBinding,
  type Mcp20260728ListenNotification,
  type Mcp20260728RequestContextInput,
  type McpChangeSignal,
  type McpChangeSignalSourcePort,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_DISCOVERY_CAPABILITIES,
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_SERVER_INFO,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpResourceIdentity,
  type Phase4bMcpChangeSignalSource,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  RecordingDurableProjectionSink,
  createPostgresMcpChangeSignalSource,
} from '../../../src/infrastructure/outbox/index.js';
import type { McpReadTransportDependencies } from '../../../src/transport/mcp/mcp-read-routes.js';
import { mcpHttpPost, withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = 'https://issuer.example.test/realms/known';
const CLIENT_ID = 'known-mcp-oauth-client';
const SCOPES = ['mcp:read:public', 'mcp:read:own'];
const SUBJECT = 'urn:known:subject:alice';

class FakeListenClient extends EventEmitter {
  readonly queries: string[] = [];
  readonly releases: boolean[] = [];

  async query(statement: string): Promise<Readonly<{ rows: readonly unknown[] }>> {
    this.queries.push(statement);
    return Object.freeze({ rows: Object.freeze([]) });
  }

  release(destroy = false): void {
    this.releases.push(destroy);
  }
}

test('PostgreSQL change signals reconnect with bounded backoff after a live LISTEN connection fails', async () => {
  const first = new FakeListenClient();
  const replacement = new FakeListenClient();
  let connectCalls = 0;
  const pool = Object.freeze({
    async connect() {
      connectCalls += 1;
      if (connectCalls === 1) return first;
      if (connectCalls === 2) throw new Error('transient reconnect failure');
      return replacement;
    },
    async query() {
      return Object.freeze({ rows: Object.freeze([]) });
    },
  }) as unknown as Pool;
  const errors: unknown[] = [];
  const source = createPostgresMcpChangeSignalSource({
    pool,
    channel: 'mcp_sig_reconnect_test',
    reconnectInitialDelayMs: 1,
    reconnectMaxDelayMs: 2,
    onError(error) {
      errors.push(error);
    },
  });
  const received: McpChangeSignal[] = [];
  const subscription = source.subscribe((signal) => received.push(signal));
  await source.start();

  first.emit('error', new Error('connection lost'));
  await waitForCondition(
    () => replacement.queries.includes('LISTEN mcp_sig_reconnect_test'),
    { timeoutMs: 1_000, description: 'the MCP LISTEN connection to reconnect' },
  );
  replacement.emit('notification', {
    channel: 'mcp_sig_reconnect_test',
    payload: JSON.stringify({ type: 'resource-list-changed' }),
  });

  assert.equal(connectCalls, 3);
  assert.deepEqual(first.releases, [true]);
  assert.equal(errors.length, 2);
  assert.equal(received.at(-1)?.type, 'resource-list-changed');
  subscription.unsubscribe();
  await source.close();
  assert.ok(replacement.queries.includes('UNLISTEN mcp_sig_reconnect_test'));
  assert.deepEqual(replacement.releases, [false]);
});

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: ISSUER,
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: SCOPES.join(','),
    ...overrides,
  } as Record<string, string>;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function emptyResourceProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptySnapshotResourceProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptyNodeResourceProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function visibleResourceProjectionBundle(
  privateCollections: ReadonlySet<string> = new Set(),
  privateNodes: ReadonlySet<string> = new Set(),
): {
  readonly resourceProjection: Phase4bMcpCollectionResourceProjection;
  readonly snapshotResourceProjection: Phase4bMcpSnapshotResourceProjection;
  readonly nodeResourceProjection: Phase4bMcpNodeResourceProjection;
} {
  const resourceProjection: Phase4bMcpCollectionResourceProjection = Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource(input) {
      if (privateCollections.has(input.resource.collectionId)) {
        throw new McpResourceNotFoundError();
      }
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
            text: JSON.stringify({
              collection: Object.freeze({
                id: input.resource.collectionId,
                visibility: 'public',
              }),
            }),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
  const snapshotResourceProjection: Phase4bMcpSnapshotResourceProjection = Object.freeze({
    async readResource(input) {
      if (privateCollections.has(input.resource.collectionId)) {
        throw new McpResourceNotFoundError();
      }
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
            text: JSON.stringify({
              type: 'collection_snapshot_summary',
              collection: Object.freeze({ id: input.resource.collectionId }),
            }),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
  const nodeResourceProjection: Phase4bMcpNodeResourceProjection = Object.freeze({
    async readResource(input) {
      if (
        privateCollections.has(input.resource.collectionId)
        || privateNodes.has(input.resource.nodeId)
      ) {
        throw new McpResourceNotFoundError();
      }
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
            text: JSON.stringify({
              id: input.resource.nodeId,
              collectionId: input.resource.collectionId,
            }),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
  return Object.freeze({
    resourceProjection,
    snapshotResourceProjection,
    nodeResourceProjection,
  });
}

interface TestServer {
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
  readonly source: Phase4bMcpChangeSignalSource;
  readonly origin: string;
}

async function startApi(
  env: Record<string, string>,
  dependencies: McpReadTransportDependencies = {},
): Promise<TestServer> {
  const config = loadConfig(env);
  const source = dependencies.changeSignalSource ?? createPhase4bMcpChangeSignalSource();
  const toolAdapter = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    mcpReadTransport: {
      ...dependencies,
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
      changeSignalSource: source,
    },
    mcpReadResourceProjection: dependencies.resourceProjection ?? emptyResourceProjection(),
    mcpNodeResourceProjection: dependencies.nodeResourceProjection ?? emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: dependencies.snapshotResourceProjection ?? emptySnapshotResourceProjection(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, source, origin: `http://127.0.0.1:${address.port}` };
}

function modernBody(
  method: string,
  id: number | string | null,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': {
          name: 'known-r11-test',
          version: '1.0.0',
        },
      },
      ...params,
    },
  });
}

interface SseEvent {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: string;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface SseReader {
  next(timeoutMs?: number): Promise<SseEvent | null>;
  close(): void;
}

function createSseReader(response: Response): SseReader {
  const body = response.body;
  if (!body) throw new Error('SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let pendingRead: Promise<void> | null = null;

  function readChunk(): Promise<void> {
    if (pendingRead !== null) return pendingRead;
    pendingRead = reader.read()
      .then((result) => {
        if (result.done) {
          done = true;
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
      })
      .finally(() => {
        pendingRead = null;
      });
    return pendingRead;
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for SSE event'));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  return {
    async next(timeoutMs = 2_000): Promise<SseEvent | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const separator = buffer.indexOf('\n\n');
        if (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const dataLine = block
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (dataLine !== undefined) {
            return JSON.parse(dataLine.slice('data: '.length)) as SseEvent;
          }
          continue;
        }
        if (done) return null;
        await withTimeout(readChunk(), deadline - Date.now());
      }
      throw new Error('timed out waiting for SSE event');
    },
    close() {
      void reader.cancel().catch(() => undefined);
    },
  };
}

async function postListen(
  server: TestServer,
  notifications: Readonly<Record<string, unknown>>,
  id: number | string = 1,
  headers: Record<string, string> = {},
): Promise<{ readonly response: Response; readonly reader: SseReader }> {
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json, text/event-stream',
      ...headers,
    }, server.config.publication.origin),
    modernBody('subscriptions/listen', id, { notifications }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u);
  return { response, reader: createSseReader(response) };
}

function uris(config: ReturnType<typeof loadConfig>): {
  readonly metadata: string;
  readonly snapshot: string;
  readonly node: string;
} {
  const identity = createPhase4bMcpResourceIdentity(config.mcp!);
  return {
    metadata: identity.collectionMetadata('collection-a'),
    snapshot: identity.collectionSnapshot('collection-a'),
    node: identity.collectionNode('collection-a', 'node-1'),
  };
}

test('discovery declares only R11-implemented resource listen capabilities', () => {
  assert.deepEqual(PHASE4B_MCP_DISCOVERY_CAPABILITIES, {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
  });
  assert.equal(
    (PHASE4B_MCP_DISCOVERY_CAPABILITIES as { tools?: { readonly listChanged?: boolean } }).tools
      ?.listChanged,
    true,
  );
  assert.equal(
    (PHASE4B_MCP_DISCOVERY_CAPABILITIES as { prompts?: unknown }).prompts,
    undefined,
  );
});

test('subscriptions/listen opens an SSE stream, acknowledges, and maps resource-updated hints', async () => {
  const server = await startApi(mcpEnv(), visibleResourceProjectionBundle());
  const ids = uris(server.config);
  const { reader } = await postListen(server, {
    resourceSubscriptions: [ids.metadata, ids.snapshot, ids.node],
    resourcesListChanged: true,
  }, 'listen-1');
  try {
    const ack = await reader.next();
    assert.equal(ack?.method, 'notifications/subscriptions/acknowledged');
    assert.deepEqual(ack?.params?.notifications, {
      resourceSubscriptions: [ids.metadata, ids.snapshot, ids.node],
      resourcesListChanged: true,
    });
    assert.equal(
      (ack?.params?._meta as { readonly 'io.modelcontextprotocol/subscriptionId'?: unknown })
        ?.['io.modelcontextprotocol/subscriptionId'],
      'listen-1',
    );

    server.source.publish({ type: 'resource-updated', resourceUri: ids.metadata });
    server.source.publish({ type: 'resource-updated', resourceUri: ids.snapshot });
    server.source.publish({ type: 'resource-updated', resourceUri: ids.node });
    const first = await reader.next();
    const second = await reader.next();
    const third = await reader.next();
    const methods = [first?.method, second?.method, third?.method];
    assert.deepEqual(methods, [
      'notifications/resources/updated',
      'notifications/resources/updated',
      'notifications/resources/updated',
    ]);
    assert.deepEqual(
      [first?.params?.uri, second?.params?.uri, third?.params?.uri],
      [ids.metadata, ids.snapshot, ids.node],
    );
    for (const event of [first, second, third]) {
      assert.equal(
        (event?.params as { readonly contents?: unknown }).contents,
        undefined,
      );
      assert.equal(
        (event?.params as { readonly text?: unknown }).text,
        undefined,
      );
      assert.equal(
        (event?.params?._meta as { readonly 'io.modelcontextprotocol/subscriptionId'?: unknown })
          ?.['io.modelcontextprotocol/subscriptionId'],
        'listen-1',
      );
    }
  } finally {
    reader.close();
  }
});

test('resource-updated revalidates collection, snapshot, and node visibility before SSE delivery', async () => {
  const server = await startApi(mcpEnv(), visibleResourceProjectionBundle(
    new Set(['private-collection']),
    new Set(['private-node']),
  ));
  const identity = createPhase4bMcpResourceIdentity(server.config.mcp!);
  const visible = uris(server.config);
  const privateMetadata = identity.collectionMetadata('private-collection');
  const privateSnapshot = identity.collectionSnapshot('private-collection');
  const privateNode = identity.collectionNode('public-collection', 'private-node');
  const { reader } = await postListen(server, {
    resourceSubscriptions: [
      privateMetadata,
      privateSnapshot,
      privateNode,
      visible.metadata,
    ],
  }, 'visibility-recheck');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-updated', resourceUri: privateMetadata });
    server.source.publish({ type: 'resource-updated', resourceUri: privateSnapshot });
    server.source.publish({ type: 'resource-updated', resourceUri: privateNode });
    server.source.publish({ type: 'resource-updated', resourceUri: visible.metadata });

    const event = await reader.next();
    assert.equal(event?.method, 'notifications/resources/updated');
    assert.equal(event?.params?.uri, visible.metadata);
    await assert.rejects(() => reader.next(150), /timed out/);
  } finally {
    reader.close();
  }
});

test('dropped hidden resource-updated does not close listen and later visible hints still arrive', async () => {
  const server = await startApi(mcpEnv(), visibleResourceProjectionBundle(
    new Set(['private-collection']),
  ));
  const identity = createPhase4bMcpResourceIdentity(server.config.mcp!);
  const ids = uris(server.config);
  const privateMetadata = identity.collectionMetadata('private-collection');
  const { reader } = await postListen(server, {
    resourceSubscriptions: [privateMetadata, ids.metadata, ids.snapshot],
  }, 'continue-after-drop');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-updated', resourceUri: privateMetadata });
    server.source.publish({ type: 'resource-updated', resourceUri: ids.metadata });
    const first = await reader.next();
    assert.equal(first?.method, 'notifications/resources/updated');
    assert.equal(first?.params?.uri, ids.metadata);

    server.source.publish({ type: 'resource-updated', resourceUri: ids.snapshot });
    const second = await reader.next();
    assert.equal(second?.method, 'notifications/resources/updated');
    assert.equal(second?.params?.uri, ids.snapshot);
  } finally {
    reader.close();
  }
});

test('resource-updated probe failures are dropped without closing the stream', async () => {
  const bundle = visibleResourceProjectionBundle();
  const server = await startApi(mcpEnv(), {
    ...bundle,
    resourceProjection: Object.freeze({
      ...bundle.resourceProjection,
      async readResource() {
        throw new Error('projection probe failed');
      },
    }),
  });
  const { reader } = await postListen(server, {
    resourceSubscriptions: [uris(server.config).metadata],
  }, 'probe-failure');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-updated', resourceUri: uris(server.config).metadata });
    await assert.rejects(() => reader.next(150), /timed out/);
    assert.equal(server.source.listenerCount(), 1);
  } finally {
    reader.close();
  }
});

test('resource list changes deliver a list_changed hint without a Resource body', async () => {
  const server = await startApi(mcpEnv());
  const { reader } = await postListen(server, { resourcesListChanged: true }, 'listen-list');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-list-changed' });
    const event = await reader.next();
    assert.equal(event?.method, 'notifications/resources/list_changed');
    assert.deepEqual(
      Object.keys(event?.params ?? {}).filter((key) => key !== '_meta'),
      [],
    );
  } finally {
    reader.close();
  }
});

test('duplicate and late resource signals are bounded hints that never replay old state', async () => {
  const server = await startApi(mcpEnv(), visibleResourceProjectionBundle());
  const ids = uris(server.config);
  server.source.publish({ type: 'resource-updated', resourceUri: ids.metadata });
  const { reader } = await postListen(server, {
    resourceSubscriptions: [ids.metadata],
  }, 'duplicate-listen');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-updated', resourceUri: ids.metadata });
    server.source.publish({ type: 'resource-updated', resourceUri: ids.metadata });
    const first = await reader.next();
    const second = await reader.next();
    assert.equal(first?.method, 'notifications/resources/updated');
    assert.equal(second?.method, 'notifications/resources/updated');
    assert.equal(first?.params?.uri, ids.metadata);
    assert.equal(second?.params?.uri, ids.metadata);
    assert.equal((first?.params as { readonly contents?: unknown }).contents, undefined);
    assert.equal((second?.params as { readonly contents?: unknown }).contents, undefined);
  } finally {
    reader.close();
  }
});

test('dropped and late hints never gate or corrupt authoritative re-reads', async () => {
  let reads = 0;
  const resourceProjection: Phase4bMcpCollectionResourceProjection = Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      reads += 1;
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
            text: '{"collection":{"id":"collection-a"}}',
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
  const server = await startApi(mcpEnv(), { resourceProjection });
  const uri = uris(server.config).metadata;
  server.source.publish({ type: 'resource-updated', resourceUri: uri });
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'resources/read',
      'mcp-name': uri,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
    }, server.config.publication.origin),
    modernBody('resources/read', 're-read-after-drop', { uri }),
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(await response.text()) as {
    readonly result?: { readonly resultType?: unknown };
  };
  assert.equal(payload.result?.resultType, 'complete');
  assert.equal(reads, 1);
});

test('toolsListChanged is accepted and delivers a bounded tools list change hint', async () => {
  const server = await startApi(mcpEnv());
  const { reader } = await postListen(server, { toolsListChanged: true }, 'tools-list');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'tool-list-changed' });
    const event = await reader.next();
    assert.equal(event?.method, 'notifications/tools/list_changed');
    assert.deepEqual(
      Object.keys(event?.params ?? {}).filter((key) => key !== '_meta'),
      [],
    );
  } finally {
    reader.close();
  }
});

test('promptsListChanged is rejected because prompts listChanged is not declared', async () => {
  const server = await startApi(mcpEnv());
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json, text/event-stream',
    }, server.config.publication.origin),
    modernBody('subscriptions/listen', 'reject-prompts', {
      notifications: { promptsListChanged: true },
    }),
  );
  assert.equal(response.status, 200);
  const reader = createSseReader(response);
  try {
    const event = await reader.next();
    assert.equal(event?.error?.code, -32602);
    assert.match(String(event?.error?.message ?? ''), /promptsListChanged/iu);
  } finally {
    reader.close();
  }
});

test('resourceSubscriptions accepts only host-stable logical URIs', async () => {
  const server = await startApi(mcpEnv());
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json, text/event-stream',
    }, server.config.publication.origin),
    modernBody('subscriptions/listen', 'invalid-uri', {
      notifications: {
        resourceSubscriptions: ['https://attacker.example/collections/a'],
      },
    }),
  );
  assert.equal(response.status, 200);
  const reader = createSseReader(response);
  try {
    const event = await reader.next();
    assert.equal(event?.error?.code, -32602);
    assert.match(String(event?.error?.message ?? ''), /Resource URI/iu);
  } finally {
    reader.close();
  }
});

test('two listeners are isolated by filter and subscription id', async () => {
  const server = await startApi(mcpEnv(), visibleResourceProjectionBundle());
  const ids = uris(server.config);
  const first = await postListen(server, { resourceSubscriptions: [ids.metadata] }, 'first');
  const second = await postListen(server, { resourceSubscriptions: [ids.node] }, 'second');
  try {
    await first.reader.next();
    await second.reader.next();
    server.source.publish({ type: 'resource-updated', resourceUri: ids.metadata });
    server.source.publish({ type: 'resource-updated', resourceUri: ids.node });
    const firstEvent = await first.reader.next();
    const secondEvent = await second.reader.next();
    assert.equal(firstEvent?.params?.uri, ids.metadata);
    assert.equal(secondEvent?.params?.uri, ids.node);
    assert.equal(
      (firstEvent?.params?._meta as { readonly 'io.modelcontextprotocol/subscriptionId'?: unknown })
        ?.['io.modelcontextprotocol/subscriptionId'],
      'first',
    );
    assert.equal(
      (secondEvent?.params?._meta as { readonly 'io.modelcontextprotocol/subscriptionId'?: unknown })
        ?.['io.modelcontextprotocol/subscriptionId'],
      'second',
    );
  } finally {
    first.reader.close();
    second.reader.close();
  }
});

test('disconnect does not replay old signals and a reconnect only receives new hints', async () => {
  const server = await startApi(mcpEnv());
  const first = await postListen(server, { resourcesListChanged: true }, 'disconnect-first');
  await first.reader.next();
  first.reader.close();
  await waitForCondition(
    () => server.source.listenerCount() === 0,
    { timeoutMs: 1_000, description: 'the disconnected MCP listener to be removed' },
  );
  assert.equal(server.source.listenerCount(), 0);

  server.source.publish({ type: 'resource-list-changed' });
  const second = await postListen(server, { resourcesListChanged: true }, 'disconnect-second');
  try {
    const ack = await second.reader.next();
    assert.equal(ack?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-list-changed' });
    const event = await second.reader.next();
    assert.equal(event?.method, 'notifications/resources/list_changed');
    assert.equal(
      (event?.params?._meta as { readonly 'io.modelcontextprotocol/subscriptionId'?: unknown })
        ?.['io.modelcontextprotocol/subscriptionId'],
      'disconnect-second',
    );
  } finally {
    second.reader.close();
  }
});

test('anonymous security epoch revocation ends the stream before the next send', async () => {
  let epoch = 'epoch-1';
  const server = await startApi(mcpEnv(), {
    securityEpoch: () => epoch,
  });
  const { reader } = await postListen(server, { resourcesListChanged: true }, 'revoke-1');
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-list-changed' });
    assert.equal((await reader.next())?.method, 'notifications/resources/list_changed');
    epoch = 'epoch-2';
    server.source.publish({ type: 'resource-list-changed' });
    assert.equal(await reader.next(), null);
    assert.equal(server.source.listenerCount(), 0);
  } finally {
    reader.close();
  }
});

test('authenticated credential/scope revocation ends the stream before the next send', async () => {
  const binding = mapOAuthEvidenceToAuthenticatedBinding(Object.freeze({
    credentialKind: 'oauth',
    principalId: SUBJECT,
    clientId: CLIENT_ID,
    credentialBindingId: 'credential-1',
    resourceAudience: AUDIENCE,
    securityEpoch: 'epoch-1',
  }));
  let authorized = true;
  const verifier = {
    async verify(input: { readonly authorization?: string | readonly string[] | undefined }) {
      if (!authorized || input.authorization !== 'Bearer valid-token') {
        throw new Error('revoked');
      }
      return { binding } as never;
    },
  };
  const server = await startApi(mcpEnv(), {
    oauthVerifier: verifier,
  });
  const { reader } = await postListen(
    server,
    { resourcesListChanged: true },
    'auth-revoke',
    { authorization: 'Bearer valid-token' },
  );
  try {
    assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
    server.source.publish({ type: 'resource-list-changed' });
    assert.equal((await reader.next())?.method, 'notifications/resources/list_changed');
    authorized = false;
    server.source.publish({ type: 'resource-list-changed' });
    assert.equal(await reader.next(), null);
    assert.equal(server.source.listenerCount(), 0);
  } finally {
    reader.close();
  }
});

test('the listen stream never mixes request-scoped log notifications into signal delivery', async () => {
  const server = await startApi(mcpEnv());
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'log-isolation',
    method: 'subscriptions/listen',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'known-r11-test', version: '1.0.0' },
        'io.modelcontextprotocol/logLevel': 'debug',
      },
      notifications: { resourcesListChanged: true },
    },
  });
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json, text/event-stream',
    }, server.config.publication.origin),
    body,
  );
  const reader = createSseReader(response);
  try {
    server.source.publish({ type: 'resource-list-changed' });
    const events = [await reader.next(), await reader.next()];
    assert.deepEqual(
      events.map((event) => event?.method),
      [
        'notifications/subscriptions/acknowledged',
        'notifications/resources/list_changed',
      ],
    );
  } finally {
    reader.close();
  }
});

test('host signal source provides monotonic frozen signals and bounded overflow is not delivered', async () => {
  const source = createPhase4bMcpChangeSignalSource({
    now: () => NOW.getTime(),
  });
  const received: McpChangeSignal[] = [];
  const subscription = source.subscribe((signal) => {
    received.push(signal);
  });
  source.publish({ type: 'resource-updated', resourceUri: 'colp://server/collections/a' });
  source.publish({ type: 'resource-list-changed' });
  assert.equal(received.length, 2);
  assert.equal(received[0]?.sequence, 1);
  assert.equal(received[1]?.sequence, 2);
  assert.equal(received[0]?.timestamp, NOW.getTime());
  assert.ok(Object.isFrozen(received[0]));
  subscription.unsubscribe();
  subscription.unsubscribe();
  assert.equal(source.listenerCount(), 0);

  const adapter = createMcp20260728SubscriptionsListenAdapter({
    signalSource: source as McpChangeSignalSourcePort,
    // @know-n/colp 0.1.1 denies listen when no authorization is configured.
    authorization: { isAuthorized: () => true },
    capabilities: PHASE4B_MCP_DISCOVERY_CAPABILITIES,
    maxQueueSize: 2,
    maxRatePerWindow: 10,
    maxNotifications: 10,
    maxLifetimeMs: 10_000,
  });
  const context = createMcp20260728RequestContext({
    headers: Object.freeze([
      { name: 'mcp-protocol-version', value: '2026-07-28' },
      { name: 'mcp-method', value: 'subscriptions/listen' },
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'subscriptions/listen',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        }),
        notifications: { resourcesListChanged: true },
      }),
    }),
    binding: Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze([]),
    budget: Object.freeze({
      maxBytes: 1_048_576,
      maxDepth: 16,
      maxNodes: 10_000,
      maxOperations: 10_000,
      maxListItems: 10_000,
      maxReadContents: 10_000,
      maxTextBytes: 1_048_576,
      maxCursorLength: 1_024,
    }),
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
  } as Mcp20260728RequestContextInput);
  const session = adapter.listen(
    context,
    { notifications: { resourcesListChanged: true } },
    'overflow-session',
  );
  for (let index = 0; index < 10; index += 1) {
    source.publish({ type: 'resource-list-changed' });
  }
  session.close();
  const teardown = await session.closed;
  assert.equal(teardown.received, 10);
  assert.equal(teardown.delivered, 2);
  assert.equal(teardown.overflow, 8);
  const notifications: Mcp20260728ListenNotification[] = [];
  for await (const notification of session.notifications) notifications.push(notification);
  assert.equal(notifications.length, 2);
});

test('discovery result carries the fixed server info with resource listen capabilities', async () => {
  const server = await startApi(mcpEnv());
  const response = await mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'server/discover',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
    }, server.config.publication.origin),
    modernBody('server/discover', 99),
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(await response.text()) as {
    readonly result?: {
      readonly capabilities?: unknown;
      readonly _meta?: { readonly 'io.modelcontextprotocol/serverInfo'?: unknown };
    };
  };
  assert.deepEqual(payload.result?.capabilities, PHASE4B_MCP_DISCOVERY_CAPABILITIES);
  assert.deepEqual(
    payload.result?._meta?.['io.modelcontextprotocol/serverInfo'],
    PHASE4B_MCP_SERVER_INFO,
  );
});

test('enabled MCP composition fails closed when the change signal source is absent', () => {
  const config = loadConfig(mcpEnv());
  const toolAdapter = emptyReadToolAdapterBundle();
  assert.throws(
    () => buildApiApp({
      config,
      mcpReadTransport: {
        readToolAdapter: toolAdapter.adapter,
        readToolParamDeclarations: toolAdapter.paramDeclarations,
      },
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpNodeResourceProjection: emptyNodeResourceProjection(),
      mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    }),
    /MCP read change signal source is required/u,
  );
});

test('enabled MCP worker composition fails closed without an explicit signal source', () => {
  const config = loadConfig(mcpEnv());
  assert.throws(
    () => buildWorker(config, undefined, undefined, {
      projectionSink: new RecordingDurableProjectionSink(),
    }),
    /MCP Read enabled requires an MCP change signal source/u,
  );
});
