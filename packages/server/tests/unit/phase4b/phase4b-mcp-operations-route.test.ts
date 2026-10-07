import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  McpResourceNotFoundError,
} from '@know-n/colp/mcp';
import {
  createPhase4bMcpChangeSignalSource,
  McpOauthVerificationError,
  createPhase4bMcpReadOperations,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpReadOperations,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { InMemoryMetrics, type Metrics } from '../../../src/infrastructure/telemetry/index.js';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import type { McpReadTransportDependencies } from '../../../src/transport/mcp/mcp-read-routes.js';
import { mcpHttpPost, withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';

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
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
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
        'io.modelcontextprotocol/clientInfo': { name: 'known-r13-route-test', version: '1.0.0' },
      },
      ...params,
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

interface TestServer {
  readonly app: FastifyInstance;
  readonly origin: string;
  readonly operations: Phase4bMcpReadOperations;
  readonly metrics: Metrics;
  readonly source: ReturnType<typeof createPhase4bMcpChangeSignalSource>;
}

async function startApi(
  env: Record<string, string>,
  dependencies: McpReadTransportDependencies = {},
  options: {
    readonly operations?: Phase4bMcpReadOperations;
    readonly metrics?: Metrics;
  } = {},
): Promise<TestServer> {
  const config = loadConfig(env);
  const source = dependencies.changeSignalSource ?? createPhase4bMcpChangeSignalSource();
  const toolAdapter = emptyReadToolAdapterBundle();
  const metrics = options.metrics ?? new InMemoryMetrics();
  const operations = options.operations ?? createPhase4bMcpReadOperations({
    metrics,
    maxConcurrentRequests: config.mcp?.budgets.request.maxConcurrent ?? 1,
    maxQueuedRequests: config.mcp?.budgets.request.maxQueue ?? 0,
    maxListeners: config.mcp?.budgets.listen.maxConnections ?? 1,
    ...(dependencies.dependencyHealth === undefined
      ? {}
      : { dependencyHealth: dependencies.dependencyHealth }),
  });
  const app = buildApiApp({
    config,
    metrics,
    mcpReadOperations: operations,
    mcpReadTransport: {
      ...dependencies,
      changeSignalSource: source,
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
    },
    mcpReadResourceProjection: dependencies.resourceProjection ?? emptyResourceProjection(),
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, origin: `http://127.0.0.1:${address.port}`, operations, metrics, source };
}

async function postJson(
  server: TestServer,
  method: string,
  id: number | string | null,
  init: RequestInit = {},
): Promise<Response> {
  return mcpHttpPost(
    `${server.origin}/collections/-/mcp`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      ...(init.headers as Record<string, string> | undefined),
    }),
    (init.body as string | Uint8Array | undefined) ?? modernBody(method, id),
    init.signal ?? undefined,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  await waitForCondition(predicate, { timeoutMs, description: 'the MCP operation state transition' });
}

test('normal MCP Read requests report success metrics and leave the operation registry empty', async () => {
  const server = await startApi(mcpEnv());
  const response = await postJson(server, 'server/discover', 1);
  assert.equal(response.status, 200);
  await waitFor(() => server.operations.inspect().activeRequests.length === 0);
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.requests.success'), 1);
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.requests.active'), 0);
});

test('over-limit and slow MCP requests are observable without exposing sensitive details', { timeout: 30_000 }, async () => {
  const started = deferred();
  const release = deferred();
  let epoch = 'epoch-1';
  const server = await startApi(mcpEnv({
    MCP_REQUEST_MAX_CONCURRENT: '1',
    MCP_REQUEST_MAX_QUEUE: '1',
  }), {
    securityEpoch: async () => {
      started.resolve();
      await release.promise;
      return epoch;
    },
  });

  // Undici connection-pool warm-up: the first admitted request must be the
  // first to reach the server handler (a fresh TCP connection can otherwise
  // race the pooled connection of the subsequently issued requests).
  await fetch(server.origin + '/').then((r) => r.text()).catch(() => undefined);
  const held = postJson(server, 'server/discover', 2);
  await started.promise;
  const queued = postJson(server, 'server/discover', 3);
  await waitFor(() => server.operations.inspect().counts.queuedRequests >= 1);
  const overflow = await postJson(server, 'server/discover', 4);
  assert.equal(overflow.status, 503);

  const snapshot = server.operations.inspect();
  assert.equal(snapshot.activeRequests.length, 2);
  assert.deepEqual(
    new Set(snapshot.activeRequests.map((entry) => entry.method)),
    new Set(['server/discover']),
  );
  for (const entry of snapshot.activeRequests) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['elapsedMs', 'kind', 'method', 'resourceKind'],
    );
  }
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.budget.overflow.request_queue'), 1);
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.queue.overflow'), 1);
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.requests.error.backpressure'), 1);

  release.resolve();
  const [heldResponse, queuedResponse] = await Promise.all([
    withTimeout(held, 5_000, 'held request did not complete'),
    withTimeout(queued, 5_000, 'queued request did not complete'),
  ]);
  assert.equal(heldResponse.status, 200);
  assert.equal(queuedResponse.status, 200);
});

test('OAuth/JWKS outage is classified as auth and never echoes the credential', async () => {
  const server = await startApi(mcpEnv(), {
    oauthVerifier: {
      async verify() {
        throw new McpOauthVerificationError('jwks_fetch_failed');
      },
    },
  });
  const response = await postJson(server, 'server/discover', 5, {
    headers: { authorization: 'Bearer should-not-leak' },
  });
  const text = await response.text();
  assert.equal(response.status, 401);
  assert.match(text, /authentication_required/u);
  assert.doesNotMatch(text, /should-not-leak|Bearer /u);
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.requests.error.auth'), 1);
});

test('feature readiness reports OAuth dependency degradation without affecting global readiness', async () => {
  const server = await startApi(mcpEnv(), {
    dependencyHealth: async () => ({
      oauth: 'degraded',
      signalSource: 'ready',
      projection: 'ready',
    }),
  });
  const response = await fetch(`${server.origin}/ready/features/mcp`);
  assert.equal(response.status, 503);
  const payload = await response.json() as { readonly status?: string; readonly reasons?: readonly string[] };
  assert.equal(payload.status, 'degraded');
  assert.ok(payload.reasons?.includes('mcp_read_dependency_degraded'));
  assert.equal((await fetch(`${server.origin}/ready`)).status, 200);
});

test('GET/DELETE and legacy request inputs emit bounded rejection telemetry', async () => {
  const server = await startApi(mcpEnv());
  const metrics = server.metrics as InMemoryMetrics;
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await fetch(`${server.origin}/collections/-/mcp`, { method });
    assert.equal(response.status, 405, method);
  }
  assert.equal(metrics.get('mcp.read.legacy.rejected.http_method'), 2);

  await postJson(server, 'initialize', 8);
  await postJson(server, 'server/discover', 9, {
    headers: { 'mcp-session-id': 'legacy-session' },
  });
  await postJson(server, 'resources/subscribe', 10);
  assert.equal(metrics.get('mcp.read.legacy.rejected.initialize'), 1);
  assert.equal(metrics.get('mcp.read.legacy.rejected.session_header'), 1);
  assert.equal(metrics.get('mcp.read.legacy.rejected.legacy_method'), 1);
});

test('projection timeout returns a stable timeout and is counted as timeout', async () => {
  const server = await startApi(mcpEnv(), {
    requestTimeoutMs: 50,
    resourceProjection: Object.freeze({
      async listResources() {
        return Object.freeze({ resources: Object.freeze([]) });
      },
      async readResource() {
        return new Promise<never>(() => {});
      },
      async cacheForList() {
        return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
      },
      async cacheForRead() {
        return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
      },
    }),
  });
  const uri = `colp://${SERVER_UUID}/collections/collection-a`;
  const response = await postJson(server, 'resources/read', 6, {
    headers: { 'mcp-name': uri },
    body: modernBody('resources/read', 6, { uri }),
  });
  assert.equal(response.status, 408);
  assert.equal((server.metrics as InMemoryMetrics).get('mcp.read.requests.error.timeout'), 1);
  assert.equal(server.operations.inspect().activeRequests.length, 0);
});

test('listener lag increments bounded overflow metrics and degrades MCP readiness', async () => {
  const server = await startApi(mcpEnv({ MCP_LISTEN_MAX_QUEUE_BYTES: '2048' }));
  const response = await mcpHttpPost(
    `${server.origin}/collections/-/mcp`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json, text/event-stream',
    }),
    modernBody('subscriptions/listen', 'lag-listen', {
      notifications: { resourcesListChanged: true },
    }),
  );
  assert.equal(response.status, 200);
  await waitFor(() => server.operations.inspect().activeListeners.length === 1);
  for (let index = 0; index < 12; index += 1) {
    server.source.publish({ type: 'resource-list-changed' });
  }
  server.operations.drain();
  await waitFor(() => server.operations.inspect().activeListeners.length === 0);
  await waitFor(() => (server.metrics as InMemoryMetrics).get('mcp.read.listen.overflow') >= 1);
  assert.ok((server.metrics as InMemoryMetrics).get('mcp.read.listen.overflow') >= 1);
  const readiness = await server.operations.readiness();
  assert.ok(readiness.reasons.includes('mcp_read_listener_lag'));
});

test('forced drain closes MCP work while /health and /ready remain available', async () => {
  const started = deferred();
  const release = deferred();
  const server = await startApi(mcpEnv(), {
    securityEpoch: async () => {
      started.resolve();
      await release.promise;
      return 'epoch-1';
    },
  });
  const pending = postJson(server, 'server/discover', 7);
  await started.promise;
  server.operations.drain();
  await assert.rejects(() => pending);
  assert.equal((await fetch(`${server.origin}/health`)).status, 200);
  assert.equal((await fetch(`${server.origin}/ready`)).status, 200);
  assert.equal((await fetch(`${server.origin}/ready/features/mcp`)).status, 503);
  release.resolve();
});

test('flag off keeps /health and /ready healthy and returns 404 for the MCP feature probe', async () => {
  const server = await startApi(baseEnv);
  assert.equal((await fetch(`${server.origin}/health`)).status, 200);
  assert.equal((await fetch(`${server.origin}/ready`)).status, 200);
  assert.equal((await fetch(`${server.origin}/ready/features/mcp`)).status, 404);
  assert.equal((await fetch(`${server.origin}/collections/-/mcp`)).status, 404);
});
