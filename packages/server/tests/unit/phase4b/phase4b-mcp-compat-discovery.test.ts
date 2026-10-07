import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpResourceNotFoundError } from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_METHOD_NOT_ALLOWED_BODY,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_READINESS_PATH,
  MCP_COMPAT_RECOMMENDED_CLIENTS,
  MCP_WELL_KNOWN_COMPAT_CHOOSE_WHEN,
  MCP_WELL_KNOWN_DISCOVERY_SUGGESTED_SCOPES,
  MCP_WELL_KNOWN_STRICT_CHOOSE_WHEN,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH,
  createMcpCompatReadinessDocument,
  createMcpReadManifestCandidate,
  createMcpWellKnownDiscoveryDocument,
  createPhase4bMcpChangeSignalSource,
  type McpWellKnownDiscoveryDocument,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import {
  asMcpCompatJsonRpc,
  parseMcpCompatHttpPayload,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  phase4bMcpConfigBaseEnv as baseEnv,
  phase4bMcpOnEnv as onEnv,
} from '../../support/phase4b-mcp-config-env.js';
import { buildApiApp } from '../../../src/transport/app.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function silent(env: Record<string, string>): Record<string, string> {
  return { ...env, LOG_LEVEL: 'silent' };
}

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

function startApi(env: Record<string, string>): {
  readonly app: FastifyInstance;
  readonly config: ReturnType<typeof loadConfig>;
} {
  const config = loadConfig(silent(env));
  const toolAdapter = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    mcpReadTransport: {
      changeSignalSource: createPhase4bMcpChangeSignalSource(),
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
      dependencyHealth: async () => ({
        oauth: 'ready',
        signalSource: 'ready',
        projection: 'ready',
      }),
    },
    mcpReadResourceProjection: emptyResourceProjection(),
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
  });
  apps.push(app);
  return { app, config };
}

function assertDeepFrozen(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDeepFrozen(item, `${label}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${label}.${key}`);
  }
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return keys;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

function assertPlainMethodNotAllowed(response: {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): void {
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'POST');
  assert.match(String(response.headers['content-type'] ?? ''), /^text\/plain\b/u);
  assert.equal(response.payload, MCP_COMPAT_METHOD_NOT_ALLOWED_BODY);
  assert.doesNotMatch(response.payload, /jsonrpc/u);
  assert.doesNotMatch(response.payload, /"error"/u);
}

const COMPAT_ABSENT_PATHS = [
  MCP_COMPAT_ENDPOINT_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
  MCP_COMPAT_READINESS_PATH,
] as const;

test('flag off leaves well-known on old fields only and does not register compat surfaces', async () => {
  const off = startApi(baseEnv);
  assert.equal(off.config.mcp, undefined);
  for (const path of [
    PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH,
    ...COMPAT_ABSENT_PATHS,
  ]) {
    const response = await off.app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 404, path);
  }

  const readOn = startApi(onEnv());
  assert.equal(readOn.config.mcp?.compat, undefined);
  const discovery = await readOn.app.inject({ method: 'GET', url: PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH });
  assert.equal(discovery.statusCode, 200);
  const body = discovery.json<McpWellKnownDiscoveryDocument>();
  assert.deepEqual(body, createMcpWellKnownDiscoveryDocument(readOn.config.mcp!));
  assert.equal('endpoints' in body, false);
  assert.equal(body.endpoint, readOn.config.mcp!.endpoint);
  assert.equal(body.transport, 'streamable-http');
  assert.equal(body.protocolVersion, '2026-07-28');
  assert.doesNotMatch(JSON.stringify(body), /mcp-compat/u);
  assert.doesNotMatch(JSON.stringify(body), /2025-11-25/u);
  for (const path of COMPAT_ABSENT_PATHS) {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const response = await readOn.app.inject({ method, url: path });
      assert.equal(response.statusCode, 404, `${method} ${path}`);
    }
  }
});

test('flag on adds frozen well-known endpoints without changing top-level strict fields', async () => {
  const offConfig = loadConfig(onEnv()).mcp!;
  const on = startApi(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' }));
  const mcp = on.config.mcp!;
  const offDoc = createMcpWellKnownDiscoveryDocument(offConfig);
  const onDoc = createMcpWellKnownDiscoveryDocument(mcp);
  for (const key of [
    'endpoint',
    'transport',
    'protocolVersion',
    'documentation',
    'oauthProtectedResourceMetadata',
    'anonymous',
  ] as const) {
    assert.deepEqual(onDoc[key], offDoc[key], key);
  }
  assert.equal('endpoints' in offDoc, false);
  assert.ok(onDoc.endpoints);
  assert.equal(onDoc.endpoints.strict.path, '/collections/-/mcp');
  assert.equal(onDoc.endpoints.strict.transport, 'streamable-http');
  assert.deepEqual(onDoc.endpoints.strict.supportedProtocolVersions, ['2026-07-28']);
  assert.deepEqual(onDoc.endpoints.strict.recommendedClients, []);
  assert.equal(onDoc.endpoints.strict.profileClaim, 'mcp-read');
  assert.equal(typeof onDoc.endpoints.strict.chooseWhen, 'string');
  assert.notEqual(onDoc.endpoints.strict.chooseWhen.length, 0);
  assert.equal(onDoc.endpoints.strict.chooseWhen, MCP_WELL_KNOWN_STRICT_CHOOSE_WHEN);
  assert.deepEqual(
    [...onDoc.endpoints.strict.suggestedScopes],
    ['mcp:read:public', 'mcp:read:own', 'nodes:write', 'offline_access'],
  );
  assert.equal(onDoc.endpoints.strict.suggestedScopes, MCP_WELL_KNOWN_DISCOVERY_SUGGESTED_SCOPES);
  assert.equal(onDoc.endpoints.strict.suggestedScopes.includes('access:write'), false);
  assert.equal(onDoc.endpoints.strict.suggestedScopes.includes('changes:commit'), false);
  assert.equal(onDoc.endpoints.compatibility.path, MCP_COMPAT_ENDPOINT_PATH);
  assert.equal(onDoc.endpoints.compatibility.transport, 'streamable-http');
  assert.deepEqual(onDoc.endpoints.compatibility.supportedProtocolVersions, ['2025-11-25']);
  assert.equal(
    onDoc.endpoints.compatibility.supportedProtocolVersions,
    MCP_COMPAT_PROTOCOL_VERSIONS,
  );
  assert.equal(
    (onDoc.endpoints.compatibility.supportedProtocolVersions as readonly string[]).includes('2025-06-18'),
    false,
  );
  assert.deepEqual(onDoc.endpoints.compatibility.recommendedClients, []);
  assert.equal(onDoc.endpoints.compatibility.recommendedClients, MCP_COMPAT_RECOMMENDED_CLIENTS);
  assert.equal(onDoc.endpoints.compatibility.profileClaim, null);
  assert.notEqual(onDoc.endpoints.compatibility.profileClaim, 'mcp-read');
  assert.notEqual(onDoc.endpoints.compatibility.profileClaim, 'mcp-write');
  assert.equal(typeof onDoc.endpoints.compatibility.chooseWhen, 'string');
  assert.notEqual(onDoc.endpoints.compatibility.chooseWhen.length, 0);
  assert.equal(onDoc.endpoints.compatibility.chooseWhen, MCP_WELL_KNOWN_COMPAT_CHOOSE_WHEN);
  assert.deepEqual(
    [...onDoc.endpoints.compatibility.suggestedScopes],
    ['mcp:read:public', 'mcp:read:own', 'nodes:write', 'offline_access'],
  );
  assert.equal(
    onDoc.endpoints.compatibility.suggestedScopes,
    MCP_WELL_KNOWN_DISCOVERY_SUGGESTED_SCOPES,
  );
  assert.equal(onDoc.endpoints.compatibility.suggestedScopes.includes('access:write'), false);
  assert.equal(onDoc.endpoints.compatibility.suggestedScopes.includes('changes:commit'), false);
  assert.doesNotMatch(JSON.stringify(onDoc.endpoints.compatibility), /codex|claude/iu);
  assertDeepFrozen(onDoc, 'well-known discovery');

  const response = await on.app.inject({ method: 'GET', url: PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), onDoc);
});

test('recommendedClients stays empty until a pinned binary actually passes T-09', () => {
  const doc = createMcpWellKnownDiscoveryDocument(
    loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' })).mcp!,
  );
  assert.equal(doc.endpoints?.compatibility.recommendedClients.length, 0);
  assert.deepEqual(doc.endpoints?.strict.recommendedClients, []);
  assert.deepEqual(MCP_COMPAT_RECOMMENDED_CLIENTS, []);
});

test('PRM compat alias resource is the accessed compat URL, not the strict audience', async () => {
  const server = startApi(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' }));
  const mcp = server.config.mcp!;
  const audience = mcp.oauth.audience;
  const issuer = mcp.oauth.issuer;
  const compatResource = `${mcp.origin}${MCP_COMPAT_ENDPOINT_PATH}`;
  const main = await server.app.inject({
    method: 'GET',
    url: PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
  });
  const strictAlias = await server.app.inject({
    method: 'GET',
    url: PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  });
  const compatAlias = await server.app.inject({
    method: 'GET',
    url: PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
    headers: { host: 'attacker.example', origin: 'https://attacker.example' },
  });
  assert.equal(compatAlias.statusCode, 200);
  assert.equal(
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
    '/.well-known/oauth-protected-resource/collections/-/mcp-compat',
  );
  assert.deepEqual(main.json(), strictAlias.json());
  assert.equal(main.json().resource, audience);
  assert.equal(audience, 'https://collections.example.test/collections/-/mcp');
  assert.deepEqual(main.json().authorization_servers, [issuer]);
  assert.notEqual(main.json().authorization_servers[0], mcp.oauth.authorizationServerMetadataUrl);

  const compatBody = compatAlias.json() as {
    readonly resource: string;
    readonly authorization_servers: readonly string[];
  };
  assert.notDeepEqual(compatBody, main.json());
  assert.equal(compatBody.resource, compatResource);
  assert.equal(compatBody.resource, 'https://collections.example.test/collections/-/mcp-compat');
  assert.notEqual(compatBody.resource, audience);
  assert.deepEqual(compatBody.authorization_servers, [issuer]);
  assert.notEqual(compatBody.authorization_servers[0], mcp.oauth.authorizationServerMetadataUrl);
  assert.match(compatBody.resource, /mcp-compat/u);
  assert.doesNotMatch(JSON.stringify(compatBody), /attacker\.example/u);
  assert.doesNotMatch(compatAlias.payload, /attacker\.example/u);
});

test('compat readiness is a frozen identity-free singleton-version document when the flag is on', async () => {
  const built = createMcpCompatReadinessDocument();
  assert.equal(built.capability, 'mcp-compat');
  assert.equal(built.enabled, true);
  assert.equal(built.status, 'ready');
  assert.equal(built.admitting, true);
  assert.deepEqual(built.reasons, []);
  assert.equal(built.counts.activeRequests, 0);
  assert.deepEqual(built.rejectCounts, {
    total: 0,
    admission: 0,
    rate_limited: 0,
    auth: 0,
    unsupported: 0,
  });
  assert.deepEqual(built.supportedProtocolVersions, ['2025-11-25']);
  assert.equal(built.supportedProtocolVersions, MCP_COMPAT_PROTOCOL_VERSIONS);
  const keys = collectKeys(built);
  for (const forbidden of ['principal', 'token', 'clientId', 'client_id', 'userAgent', 'authorization']) {
    assert.equal(keys.has(forbidden), false, forbidden);
  }
  assertDeepFrozen(built, 'compat readiness');

  const server = startApi(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' }));
  const response = await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), built);
  assert.equal(MCP_COMPAT_READINESS_PATH, '/ready/features/mcp-compat');
});

test('GET and DELETE on the compat path are 405 text/plain without JSON-RPC, including empty JSON DELETE', async () => {
  const server = startApi(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' }));
  const get = await server.app.inject({
    method: 'GET',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: { accept: 'text/event-stream, application/json' },
  });
  assertPlainMethodNotAllowed(get);

  const del = await server.app.inject({
    method: 'DELETE',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: '',
  });
  assertPlainMethodNotAllowed(del);
  assert.notEqual(del.statusCode, 400);
});

test('compat POST is registered and tools/list is served by the SDK handler, not a 501 stub', async () => {
  const server = startApi(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' }));
  const post = await server.app.inject({
    method: 'POST',
    url: MCP_COMPAT_ENDPOINT_PATH,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      host: 'collections.example.test',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    },
  });
  assert.notEqual(post.statusCode, 404);
  assert.notEqual(post.statusCode, 501);
  assert.equal(post.statusCode, 200);
  assert.equal(post.headers['mcp-protocol-version'], '2025-11-25');
  assert.notEqual(post.headers['mcp-protocol-version'], '2025-06-18');
  const rpc = asMcpCompatJsonRpc(
    parseMcpCompatHttpPayload(String(post.headers['content-type'] ?? ''), post.payload),
  );
  assert.ok(Array.isArray(rpc.result?.tools));
  assert.equal(rpc.error, undefined);
});

test('compat on does not add the compatibility path to the COLP Manifest candidate', () => {
  const mcp = loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' })).mcp!;
  const candidate = createMcpReadManifestCandidate(mcp);
  const serialized = JSON.stringify(candidate.manifest);
  assert.doesNotMatch(serialized, /mcp-compat/u);
  assert.equal(candidate.endpoint, mcp.endpoint);
  const mount = candidate.manifest.mounts[0];
  assert.ok(mount);
  assert.equal(mount.endpoints.mcp, mcp.endpoint);
});
