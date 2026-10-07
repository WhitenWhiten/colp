import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import {
  createMcpResourceTemplates,
  createMcpResourceUriCodec,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_SERVER_INFO,
  createMcpReadManifestCandidate,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpResourceIdentity,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type Phase4bMcpResourceIdentity,
} from '../../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { mcpHttpPost, withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const OTHER_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77df';

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
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    ...overrides,
  } as Record<string, string>;
}

function identityFor(serverUuid = SERVER_UUID): Phase4bMcpResourceIdentity {
  return createPhase4bMcpResourceIdentity(loadConfig(mcpEnv({
    MCP_SERVER_UUID: serverUuid,
  })).mcp!);
}

const apps: FastifyInstance[] = [];

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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function startApi(): Promise<{
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
  readonly origin: string;
}> {
  const config = loadConfig(mcpEnv());
  const toolAdapter = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    mcpReadTransport: {
      changeSignalSource: createPhase4bMcpChangeSignalSource(),
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
    },
    mcpReadResourceProjection: emptyResourceProjection(),
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, origin: `http://127.0.0.1:${address.port}` };
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
          name: 'known-r07-test',
          version: '1.0.0',
        },
      },
      ...params,
    },
  });
}

async function postJson(
  server: { readonly origin: string },
  method: string,
  id: number | string | null,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=1, text/event-stream;q=0.5',
      ...headers,
    }),
    modernBody(method, id, params),
  );
}

function parseJsonRpc(body: string): {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: number; readonly message?: string };
} {
  return JSON.parse(body) as {
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  };
}

const expectedTemplates = [
  {
    uriTemplate: `colp://${SERVER_UUID}/collections/{collectionId}`,
    name: 'collection',
    title: 'Collection metadata',
    mimeType: 'application/vnd.collection-protocol.collection+json',
  },
  {
    uriTemplate: `colp://${SERVER_UUID}/collections/{collectionId}/nodes/{nodeId}`,
    name: 'collection-node',
    title: 'Collection node',
    mimeType: 'application/vnd.collection-protocol.node+json',
  },
] as const;

describe('P4B-R07 MCP resource identity service', () => {
  it('binds the COLP codec and templates to the frozen config serverUuid', () => {
    const identity = identityFor();

    assert.equal(identity.serverUuid, SERVER_UUID);
    assert.equal(identity.codec.serverUuid, SERVER_UUID);
    assert.equal(
      identity.codec.collectionMetadata('collection-1'),
      createMcpResourceUriCodec({ serverUuid: SERVER_UUID }).collectionMetadata('collection-1'),
    );
    assert.deepEqual(identity.templates, createMcpResourceTemplates({ serverUuid: SERVER_UUID }));
    assert.deepEqual(identity.templates, expectedTemplates);
    assert.ok(Object.isFrozen(identity));
    assert.ok(Object.isFrozen(identity.templates));
  });

  it('round-trips metadata, snapshot, and node identities through one service', () => {
    const identity = identityFor();
    const metadata = identity.collectionMetadata('collection-1');
    const snapshot = identity.collectionSnapshot('collection-1');
    const node = identity.collectionNode('collection-1', 'node-1');

    assert.equal(metadata, `colp://${SERVER_UUID}/collections/collection-1`);
    assert.equal(snapshot, `colp://${SERVER_UUID}/collections/collection-1/snapshot`);
    assert.equal(node, `colp://${SERVER_UUID}/collections/collection-1/nodes/node-1`);
    assert.deepEqual(identity.parse(metadata), {
      kind: 'collection-metadata',
      collectionId: 'collection-1',
    });
    assert.deepEqual(identity.parse(snapshot), {
      kind: 'collection-snapshot',
      collectionId: 'collection-1',
    });
    assert.deepEqual(identity.parse(node), {
      kind: 'collection-node',
      collectionId: 'collection-1',
      nodeId: 'node-1',
    });
    assert.equal(new Set([metadata, snapshot, node]).size, 3);
  });

  it('is deterministic across repeated construction and restart-like calls', () => {
    const first = identityFor();
    const second = identityFor();

    assert.deepEqual(first.templates, second.templates);
    assert.equal(first.collectionSnapshot('collection-1'), second.collectionSnapshot('collection-1'));
    assert.deepEqual(first.parse(first.collectionNode('collection-1', 'node-1')), {
      kind: 'collection-node',
      collectionId: 'collection-1',
      nodeId: 'node-1',
    });
    assert.notStrictEqual(first, second);
  });

  it('rejects wrong authority, type, id, and non-logical URI shapes', () => {
    const identity = identityFor();
    const invalidUris = [
      `colp://${OTHER_SERVER_UUID}/collections/collection-1`,
      `colp://${SERVER_UUID}`,
      `colp://${SERVER_UUID}/collections`,
      `colp://${SERVER_UUID}/collections/collection-1/nodes`,
      `colp://${SERVER_UUID}/Collections/collection-1`,
      `colp://${SERVER_UUID}/collections/collection-1/unknown`,
      `colp://${SERVER_UUID}/collections/collection-1/snapshot/extra`,
      `colp://${SERVER_UUID}/collections/collection-1/nodes/node-1/extra`,
      `colp://${SERVER_UUID}/collections/collection-1/write`,
      `https://${SERVER_UUID}/collections/collection-1`,
      `colp:/resources/~${SERVER_UUID}/collection/~collection-1`,
      `colp://${SERVER_UUID}/collections/My Collection`,
    ];

    for (const uri of invalidUris) {
      assert.throws(() => identity.parse(uri), TypeError, uri);
    }
  });

  it('rejects percent encoding, query, fragment, backslash, and Unicode', () => {
    const identity = identityFor();
    const invalidUris = [
      `colp://${SERVER_UUID}/collections/collection%2Fchild`,
      `colp://${SERVER_UUID}/collections/%2e%2e/snapshot`,
      `colp://${SERVER_UUID}/collections/collection-1?cursor=x`,
      `colp://${SERVER_UUID}/collections/collection-1#snapshot`,
      `colp://${SERVER_UUID}/collections/collection-1\\nodes\\node-1`,
      `colp://${SERVER_UUID}/collections/collection-\u00e9`,
    ];

    for (const uri of invalidUris) {
      assert.throws(() => identity.parse(uri), TypeError, uri);
    }

    const invalidIds = ['', 'x'.repeat(129), '.', '..', 'a/b', 'a?b', 'a#b', 'a%b', 'a b', '\u00e9'];
    for (const id of invalidIds) {
      assert.throws(() => identity.collectionMetadata(id), TypeError, id);
      assert.throws(() => identity.collectionSnapshot(id), TypeError, id);
      assert.throws(() => identity.collectionNode('collection-1', id), TypeError, id);
    }
  });

  it('rejects cross-binding and explicit serverUuid mismatch', () => {
    const identity = identityFor();
    assert.throws(
      () => identity.parse(`colp://${OTHER_SERVER_UUID}/collections/collection-1`),
      TypeError,
    );
    assert.throws(
      () => createPhase4bMcpResourceIdentity(loadConfig(mcpEnv()).mcp!, {
        expectedServerUuid: OTHER_SERVER_UUID,
      }),
      /serverUuid drift/u,
    );
  });

  it('binds to the same serverUuid as the read Manifest candidate', () => {
    const config = loadConfig(mcpEnv()).mcp!;
    const identity = createPhase4bMcpResourceIdentity(config);
    const candidate = createMcpReadManifestCandidate(config);

    assert.equal(identity.serverUuid, candidate.manifest.serverUuid);
  });
});

describe('P4B-R07 MCP resource transport shell', () => {
  it('serves bound Modern Resource templates with resultType and cache metadata', async () => {
    const server = await startApi();
    const response = await postJson(server, 'resources/templates/list', 1);

    assert.equal(response.status, 200);
    const payload = parseJsonRpc(await response.text());
    assert.equal(payload.result?.resultType, 'complete');
    assert.equal(payload.result?.ttlMs, 0);
    assert.equal(payload.result?.cacheScope, 'public');
    assert.deepEqual(payload.result?.resourceTemplates, expectedTemplates);
    assert.deepEqual(
      (payload.result?._meta as { readonly 'io.modelcontextprotocol/serverInfo'?: unknown })
        ?.['io.modelcontextprotocol/serverInfo'],
      PHASE4B_MCP_SERVER_INFO,
    );
  });

  it('keeps the empty Resource list honest and cacheable', async () => {
    const server = await startApi();
    const response = await postJson(server, 'resources/list', 2);

    assert.equal(response.status, 200);
    const payload = parseJsonRpc(await response.text());
    assert.equal(payload.result?.resultType, 'complete');
    assert.equal(payload.result?.ttlMs, 0);
    assert.equal(payload.result?.cacheScope, 'private');
    assert.deepEqual(payload.result?.resources, []);
  });

  it('returns stable invalid_params for resources/read without faking a body', async () => {
    const server = await startApi();
    const identity = createPhase4bMcpResourceIdentity(server.config.mcp!);
    const uris = [
      identity.collectionMetadata('collection-1'),
      identity.collectionSnapshot('collection-1'),
      identity.collectionNode('collection-1', 'node-1'),
      `colp://${OTHER_SERVER_UUID}/collections/collection-1`,
      `colp://${SERVER_UUID}/Collections/collection-1`,
      `colp://${SERVER_UUID}/collections/collection-1/unknown`,
      `colp://${SERVER_UUID}/collections/collection%2Fchild`,
      `colp://${SERVER_UUID}/collections/collection-1?cursor=x`,
      `colp://${SERVER_UUID}/collections/collection-1#snapshot`,
      `colp://${SERVER_UUID}/collections/collection-1\\nodes\\node-1`,
    ];

    let id = 10;
    for (const uri of uris) {
      const response = await postJson(server, 'resources/read', id, { uri }, { 'mcp-name': uri });
      const text = await response.text();
      assert.equal(response.status, 400, uri);
      assert.equal(parseJsonRpc(text).error?.code, -32602, uri);
      assert.doesNotMatch(text, /contents|Collection metadata/iu);
      id += 1;
    }

    const missing = await postJson(server, 'resources/read', id);
    assert.equal(missing.status, 400);
    assert.equal(parseJsonRpc(await missing.text()).error?.code, -32602);
  });

  it('keeps template identities stable across real Fastify restarts', async () => {
    const first = await startApi();
    const second = await startApi();

    const firstPayload = parseJsonRpc(
      await (await postJson(first, 'resources/templates/list', 30)).text(),
    );
    const secondPayload = parseJsonRpc(
      await (await postJson(second, 'resources/templates/list', 31)).text(),
    );

    assert.deepEqual(firstPayload.result?.resourceTemplates, expectedTemplates);
    assert.deepEqual(secondPayload.result?.resourceTemplates, expectedTemplates);
    assert.deepEqual(firstPayload.result, secondPayload.result);
  });
});
