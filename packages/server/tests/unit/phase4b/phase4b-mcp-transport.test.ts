import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';
import Fastify from 'fastify';
import {
  McpResourceNotFoundError,
  encodeMcp20260728ParamValue,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  assertMcpWriteOAuthRequirement,
  createMcpReadOAuthTransportDependencies,
} from '../../../src/bootstrap/api.js';
import {
  PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_SERVER_INFO,
  createInMemoryMcpOauthRevocationStore,
  createPhase4bMcpChangeSignalSource,
  createMcpOauthVerifier,
  McpOauthVerificationError,
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type McpOauthRevocationStore,
} from '../../../src/modules/mcp/index.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { readApiCompositionSource } from '../../support/api-composition-source.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { installProductAdmission } from '../../../src/transport/product-admission.js';
import { writeSseMessage } from '../../../src/transport/mcp/mcp-read-routes.js';
import {
  ACCOUNT_ID,
  CLIENT_ID,
  ISSUER,
  SERVER_UUID,
  SUBJECT,
  apps,
  assertInvalidJsonResponse,
  authFixture,
  baseEnv,
  createKeyFixture,
  emptyNodeResourceProjection,
  emptyResourceProjection,
  emptySnapshotResourceProjection,
  gatedAuthFixture,
  gatedToolSurface,
  hostToolSurface,
  mcpEnv,
  mintCredential,
  mcpHttpPost,
  withMcpTestHost,
  modernBody,
  parseJsonRpc,
  postJson,
  postRaw,
  prodEnv,
  rawHttpPost,
  requestBudgetOperations,
  sha256,
  startApi,
  staticJwksProvider,
  verifierOptions,
  waitForQueueSlot,
  withTimeout,
  writeOnlyAuthFixture,
} from '../../support/phase4b-mcp-transport-scaffold.js';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

test('enabled composition mounts the unique POST endpoint and serves anonymous server/discover as JSON', async () => {
  const server = await startApi(mcpEnv());
  const response = await postJson(server, 'server/discover', 1);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const vary = response.headers.get('vary') ?? '';
  assert.match(vary, /\bAuthorization\b/u);
  assert.match(vary, /\bOrigin\b/u);
  assert.ok(response.headers.get('x-request-id'));

  const payload = parseJsonRpc(await response.text());
  assert.ok(payload.result);
  assert.equal(payload.result?.resultType, 'complete');
  assert.deepEqual(payload.result?.supportedVersions, ['2026-07-28']);
  assert.deepEqual(payload.result?.capabilities, {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
  });
  assert.deepEqual(
    (payload.result?._meta as { readonly 'io.modelcontextprotocol/serverInfo'?: unknown })
      ?.['io.modelcontextprotocol/serverInfo'],
    PHASE4B_MCP_SERVER_INFO,
  );
});

test('empty resource and tool list ports return complete cacheable Modern results', async () => {
  const server = await startApi(mcpEnv());

  for (const method of ['resources/list', 'resources/templates/list', 'tools/list'] as const) {
    const response = await postJson(server, method, 10);
    assert.equal(response.status, 200, method);
    const payload = parseJsonRpc(await response.text());
    assert.equal(payload.result?.resultType, 'complete', method);
    assert.equal(payload.result?.ttlMs, 0, method);
  }

  const resources = parseJsonRpc(await (await postJson(server, 'resources/list', 11)).text());
  assert.equal(resources.result?.cacheScope, 'private');
  assert.deepEqual(resources.result?.resources, []);
  const templates = parseJsonRpc(await (await postJson(server, 'resources/templates/list', 12)).text());
  assert.equal(templates.result?.cacheScope, 'public');
  assert.deepEqual(templates.result?.resourceTemplates, [
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
  ]);
  const tools = parseJsonRpc(await (await postJson(server, 'tools/list', 13)).text());
  assert.deepEqual(tools.result?.tools, []);
});

test('JSON/SSE negotiation requires both media types and rejects single-type or wildcard Accept', async () => {
  const server = await startApi(mcpEnv());

  const noAccept = await postRaw(server, modernBody('server/discover', 20), {
    'content-type': 'application/json',
    'mcp-method': 'server/discover',
    'mcp-protocol-version': '2026-07-28',
  });
  assert.equal(noAccept.status, 406);
  assert.deepEqual(await noAccept.json(), { error: 'mcp_unsupported_accept' });

  const jsonOnly = await postJson(server, 'server/discover', 21, {
    headers: { accept: 'application/json' },
  });
  assert.equal(jsonOnly.status, 406);
  assert.deepEqual(await jsonOnly.json(), { error: 'mcp_unsupported_accept' });

  const sseOnly = await postJson(server, 'server/discover', 22, {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(sseOnly.status, 406);
  assert.deepEqual(await sseOnly.json(), { error: 'mcp_unsupported_accept' });

  const wildcard = await postJson(server, 'server/discover', 23, {
    headers: { accept: '*/*' },
  });
  assert.equal(wildcard.status, 406);

  const rejected = await postJson(server, 'server/discover', 24, {
    headers: { accept: 'text/html' },
  });
  assert.equal(rejected.status, 406);

  const zeroWildcard = await postJson(server, 'server/discover', 25, {
    headers: { accept: '*/*;q=0' },
  });
  assert.equal(zeroWildcard.status, 406);

  const zeroBoth = await postJson(server, 'server/discover', 26, {
    headers: { accept: 'application/json;q=0, text/event-stream;q=0' },
  });
  assert.equal(zeroBoth.status, 406);

  // MCP-U-09: an exact quality tie prefers the JSON body a request/response
  // client expects; SSE requires an explicitly higher q.
  const both = await postJson(server, 'server/discover', 27, {
    headers: { accept: 'application/json, text/event-stream' },
  });
  assert.equal(both.status, 200);
  assert.match(both.headers.get('content-type') ?? '', /^application\/json/u);
  const tiePayload = parseJsonRpc(await both.text());
  assert.deepEqual(tiePayload.result?.supportedVersions, ['2026-07-28']);

  const jsonPreferred = await postJson(server, 'server/discover', 28, {
    headers: { accept: 'application/json;q=1, text/event-stream;q=0.5' },
  });
  assert.equal(jsonPreferred.status, 200);
  assert.match(jsonPreferred.headers.get('content-type') ?? '', /^application\/json/u);

  const ssePreferred = await postJson(server, 'server/discover', 29, {
    headers: { accept: 'application/json;q=0.5, text/event-stream;q=1' },
  });
  assert.equal(ssePreferred.status, 200);
  assert.match(ssePreferred.headers.get('content-type') ?? '', /^text\/event-stream/u);
});

test('non-tools/call methods reject undeclared Mcp-Param-* headers', async () => {
  const server = await startApi(mcpEnv());
  const response = await postJson(server, 'resources/list', 30, {
    headers: { 'mcp-param-x-request-id': 'abc' },
  });
  assert.equal(response.status, 400);
  assert.equal(parseJsonRpc(await response.text()).error?.code, -32020);
});

test('SSE writes await drain when the response socket applies backpressure', async () => {
  const raw = new EventEmitter() as unknown as ServerResponse;
  const writes: Buffer[] = [];
  let allowWrite = false;
  Object.assign(raw, {
    destroyed: false,
    write(chunk: Buffer) {
      writes.push(Buffer.from(chunk));
      return allowWrite;
    },
  });

  let resolved = false;
  const pending = writeSseMessage(raw, { ok: true }).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.equal(resolved, false);

  allowWrite = true;
  raw.emit('drain');
  await pending;
  assert.equal(resolved, true);
});

test('SSE backpressure wait aborts with the per-request signal (MCP-U-10)', async () => {
  const raw = new EventEmitter() as unknown as ServerResponse;
  let destroyed = false;
  Object.assign(raw, {
    destroyed: false,
    write() {
      return false;
    },
    destroy() {
      destroyed = true;
    },
  });
  const controller = new AbortController();
  const outcome = writeSseMessage(raw, { ok: true }, controller.signal).then(
    () => 'resolved',
    (error: Error) => error.message,
  );
  await Promise.resolve();
  controller.abort(new DOMException('MCP request timed out', 'TimeoutError'));
  assert.equal(await outcome, 'MCP response aborted during backpressure');
  assert.equal(destroyed, true, 'the stalled socket must be destroyed on abort');
});

test('protocol errors answer as HTTP 400 JSON even when Accept prefers SSE (MCP-U-08)', async () => {
  const server = await startApi(mcpEnv());
  const missingMeta = await postRaw(
    server,
    JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'resources/list', params: {} }),
    {
      'content-type': 'application/json',
      'mcp-method': 'resources/list',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=0.5, text/event-stream;q=1',
    },
  );
  assert.equal(missingMeta.status, 400, 'envelope errors must not open a 200 SSE stream');
  assert.match(missingMeta.headers.get('content-type') ?? '', /^application\/json/u);
  const payload = parseJsonRpc(await missingMeta.text());
  assert.match(payload.error?.message ?? '', /_meta/u);
});

test('Origin allowlist accepts configured browser origins and rejects disallowed origins', async () => {
  const server = await startApi(mcpEnv());

  const allowed = await postJson(server, 'server/discover', 30, {
    headers: { origin: 'https://app.example.test' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');

  const rejected = await postJson(server, 'server/discover', 31, {
    headers: { origin: 'https://attacker.example.test' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  const body = await rejected.json() as { readonly error?: { readonly code?: string } };
  assert.equal(body.error?.code, 'csrf_failed');

  const absent = await postJson(server, 'server/discover', 32);
  assert.equal(absent.status, 200);
});

test('anonymous and real signed OAuth authenticated discovery both succeed without leaking the raw token', async () => {
  const fixture = await authFixture();
  const server = await startApi(mcpEnv(), { oauthVerifier: fixture.verifier });

  const authenticated = await postJson(server, 'server/discover', 40, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(authenticated.status, 200);
  const text = await authenticated.text();
  const payload = parseJsonRpc(text);
  assert.ok(payload.result?.supportedVersions);
  assert.equal(text.includes(fixture.token), false);
  assert.doesNotMatch(text, /Bearer |eyJ/u);

  const invalid = await postJson(server, 'server/discover', 41, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('www-authenticate') ?? '', /Bearer error="invalid_token"/u);
  const invalidBody = await invalid.json() as { readonly error?: { readonly code?: string } };
  assert.equal(invalidBody.error?.code, 'authentication_required');
});

test('collection-snapshot resources/read routes through the R09 projection and cache metadata', async () => {
  const snapshotProjection: Phase4bMcpSnapshotResourceProjection = Object.freeze({
    async readResource() {
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
            text: '{"complete":true,"nodes":[]}',
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async readPage() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'public' });
    },
  });
  const server = await startApi(mcpEnv(), { snapshotResourceProjection: snapshotProjection });
  const uri = `colp://${SERVER_UUID}/collections/sample-collection/snapshot`;
  const response = await postJson(server, 'resources/read', 130, {
    headers: { 'mcp-name': uri },
    body: modernBody('resources/read', 130, { uri }),
  });
  assert.equal(response.status, 200);
  const payload = parseJsonRpc(await response.text());
  assert.equal(payload.result?.resultType, 'complete');
  assert.equal(payload.result?.ttlMs, 0);
  assert.equal(payload.result?.cacheScope, 'public');
  assert.equal(payload.result?.contents?.[0]?.uri, uri);
  assert.equal(payload.result?.contents?.[0]?.text, '{"complete":true,"nodes":[]}');
});

test('collection-node resources/read routes through the R10 projection and cache metadata', async () => {
  const nodeProjection: Phase4bMcpNodeResourceProjection = Object.freeze({
    async readResource() {
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
            text: '{"kind":"bookmark","id":"sample-node"}',
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'public' });
    },
  });
  const server = await startApi(mcpEnv(), { nodeResourceProjection: nodeProjection });
  const uri = `colp://${SERVER_UUID}/collections/sample-collection/nodes/sample-node`;
  const response = await postJson(server, 'resources/read', 131, {
    headers: { 'mcp-name': uri },
    body: modernBody('resources/read', 131, { uri }),
  });
  assert.equal(response.status, 200);
  const payload = parseJsonRpc(await response.text());
  assert.equal(payload.result?.resultType, 'complete');
  assert.equal(payload.result?.ttlMs, 0);
  assert.equal(payload.result?.cacheScope, 'public');
  assert.equal(payload.result?.contents?.[0]?.uri, uri);
  assert.equal(payload.result?.contents?.[0]?.mimeType, PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE);
  assert.equal(payload.result?.contents?.[0]?.text, '{"kind":"bookmark","id":"sample-node"}');
});

test('authenticated requests fail closed when the R06 OAuth verifier seam is not wired', async () => {
  const server = await startApi(mcpEnv());
  const response = await postJson(server, 'server/discover', 50, {
    headers: { authorization: 'Bearer should-not-be-trusted-without-verifier' },
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /Bearer |should-not-be-trusted/u);
});

test('production MCP OAuth composition verifies real Bearer credentials through the transport', async () => {
  const config = loadConfig(mcpEnv());
  const key = await createKeyFixture('key-production');
  const production = createMcpReadOAuthTransportDependencies(config, {
    jwksProvider: staticJwksProvider([key.jwk]),
    resolveAccountBySubject: async (sub) => (
      sub === SUBJECT
        ? { id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active' }
        : null
    ),
  });
  assert.ok(production.oauthVerifier);
  assert.ok(production.dependencyHealth);

  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    now: new Date(),
  });
  const result = await production.oauthVerifier!.verify({ authorization: `Bearer ${token}` });
  assert.equal(result.binding.kind, 'authenticated');

  const server = await startApi(mcpEnv(), {
    oauthVerifier: production.oauthVerifier,
    dependencyHealth: production.dependencyHealth,
  });
  const response = await postJson(server, 'server/discover', 42, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
});

test('production MCP OAuth composition fails closed without a revocation store', async () => {
  const config = loadConfig(prodEnv());
  const deps = createMcpReadOAuthTransportDependencies(config);
  assert.equal(
    deps.oauthVerifier,
    undefined,
    'production without a revocation store must not pretend revocation is checked',
  );
  assert.ok(deps.dependencyHealth);
  assert.deepEqual(await deps.dependencyHealth!(), {
    oauth: 'unavailable',
    signalSource: 'ready',
    projection: 'ready',
  });

  const withStoreConfig = loadConfig(prodEnv({ MCP_OAUTH_REVOCATION_STORE: 'postgres' }));
  const missingPort = createMcpReadOAuthTransportDependencies(withStoreConfig);
  assert.equal(missingPort.oauthVerifier, undefined);
  assert.deepEqual(await missingPort.dependencyHealth!(), {
    oauth: 'unavailable',
    signalSource: 'ready',
    projection: 'ready',
  });
});

test('production MCP OAuth composition with a revocation store verifies, revokes and rotates epoch', async () => {
  const config = loadConfig(prodEnv({ MCP_OAUTH_REVOCATION_STORE: 'postgres' }));
  let storeNow = Date.now() - 3_600_000;
  const store: McpOauthRevocationStore = createInMemoryMcpOauthRevocationStore({
    now: () => new Date(storeNow),
  });
  const key = await createKeyFixture('key-prod-store');
  const deps = createMcpReadOAuthTransportDependencies(config, {
    jwksProvider: staticJwksProvider([key.jwk]),
    revocationStore: store,
    resolveAccountBySubject: async (sub) => (
      sub === SUBJECT
        ? { id: ACCOUNT_ID, subjectId: SUBJECT, status: 'active' }
        : null
    ),
  });
  assert.ok(deps.oauthVerifier);
  assert.ok(deps.dependencyHealth);
  assert.deepEqual(await deps.dependencyHealth!(), {
    oauth: 'ready',
    signalSource: 'ready',
    projection: 'ready',
  });

  const token = await mintCredential({ key: key.privateKey, kid: key.kid, now: new Date() });
  const result = await deps.oauthVerifier!.verify({ authorization: `Bearer ${token}` });
  assert.equal(result.binding.kind, 'authenticated');
  assert.equal(result.evidence.securityEpoch, 'known.mcp.oauth.v1');

  await store.revoke({
    issuer: ISSUER,
    subject: SUBJECT,
    clientId: CLIENT_ID,
    tokenId: 'r06-credential-jti-1',
    credentialDigest: sha256(token),
  });
  await assert.rejects(
    () => deps.oauthVerifier!.verify({ authorization: `Bearer ${token}` }),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
  );

  storeNow = Date.now();
  await store.bumpSecurityEpoch('epoch-bumped-4');
  await assert.rejects(
    () => deps.oauthVerifier!.verify({ authorization: `Bearer ${token}` }),
    (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
  );
  const fresh = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    now: new Date(Date.now() + 120_000),
  });
  const rotated = await deps.oauthVerifier!.verify({ authorization: `Bearer ${fresh}` });
  assert.equal(rotated.evidence.securityEpoch, 'epoch-bumped-4');
  assert.equal(rotated.binding.securityEpoch, 'epoch-bumped-4');
});

test('production startApi injects the OAuth transport dependencies into mcpReadTransport', () => {
  const source = readApiCompositionSource(fileURLToPath(new URL('../../..', import.meta.url)));
  assert.match(
    source,
    /mcpReadTransport:[\s\S]*?oauthVerifier:\s*mcpReadOAuthDependencies\.oauthVerifier/u,
  );
  assert.match(
    source,
    /mcpReadTransport:[\s\S]*?dependencyHealth:\s*mcpReadOAuthDependencies\.dependencyHealth/u,
  );
  assert.match(source, /assertMcpWriteOAuthRequirement\(config\)/u);
});

test('production startApi injects the unified MCP rate limiter for request and commit', () => {
  const source = readApiCompositionSource(fileURLToPath(new URL('../../..', import.meta.url)));
  assert.match(source, /requestRateLimiter:\s*mcpRateLimiter/u);
  assert.match(source, /rateLimit:\s*createMcpChangePlanCommitPort\(mcpRateLimiter\)/u);
  assert.match(source, /createRedisMcpRateLimitStore/u);
  assert.match(source, /createMemoryMcpRateLimiter/u);
});

test('production bootstrap OAuth composition does not import from the transport layer', () => {
  const source = readApiCompositionSource(fileURLToPath(new URL('../../..', import.meta.url)));
  assert.doesNotMatch(source, /from\s+['"]\.\.\/transport\/mcp\/mcp-read-routes\.js['"]/u);
});

test('production MCP Write composition rejects a missing OAuth JWKS verifier', () => {
  const writeConfig = {
    KNOWN_FEATURE_MCP_WRITE: 'true',
    PRODUCT_ORIGIN: 'https://app.example.test',
    MCP_WRITE_REQUEST_STATE_KEY: Buffer.alloc(32, 77).toString('base64'),
    MCP_WRITE_PLAN_TTL_MS: '600000',
  };
  const missing = loadConfig(mcpEnv({ ...writeConfig, MCP_OAUTH_JWKS_URI: undefined }));
  assert.throws(
    () => assertMcpWriteOAuthRequirement(missing),
    /KNOWN_FEATURE_MCP_WRITE requires MCP OAuth JWKS/u,
  );

  const flagOnly = loadConfig({ ...baseEnv, KNOWN_FEATURE_MCP_WRITE: 'true' });
  assert.throws(
    () => assertMcpWriteOAuthRequirement(flagOnly),
    /KNOWN_FEATURE_MCP_WRITE requires MCP OAuth JWKS/u,
  );

  const ready = loadConfig(mcpEnv(writeConfig));
  assert.doesNotThrow(() => assertMcpWriteOAuthRequirement(ready));
});

test('production OAuth composition stays unwired for disabled or anonymous-only MCP', async () => {
  const disabled = createMcpReadOAuthTransportDependencies(loadConfig(baseEnv));
  assert.equal(disabled.oauthVerifier, undefined);
  assert.equal(disabled.dependencyHealth, undefined);

  const anonymousOnly = createMcpReadOAuthTransportDependencies(
    loadConfig(mcpEnv({ MCP_OAUTH_JWKS_URI: undefined })),
  );
  assert.equal(anonymousOnly.oauthVerifier, undefined);
  assert.ok(anonymousOnly.dependencyHealth);
  assert.deepEqual(await anonymousOnly.dependencyHealth!(), {
    oauth: 'unavailable',
    signalSource: 'ready',
    projection: 'ready',
  });
});

test('enabled MCP composition fails closed when the Snapshot projection seam is absent', () => {
  const config = loadConfig(mcpEnv());
  assert.throws(
    () => buildApiApp({
      config,
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpNodeResourceProjection: emptyNodeResourceProjection(),
    }),
    /MCP snapshot resource projection is required/u,
  );
});

test('enabled MCP composition fails closed when the Node projection seam is absent', () => {
  const config = loadConfig(mcpEnv());
  assert.throws(
    () => buildApiApp({
      config,
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    }),
    /MCP node resource projection is required/u,
  );
});

test('enabled MCP composition fails closed when the read Tool adapter or declarations seam is absent', () => {
  const config = loadConfig(mcpEnv());
  const projections = {
    mcpReadResourceProjection: emptyResourceProjection(),
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
  };
  assert.throws(
    () => buildApiApp({
      config,
      ...projections,
      mcpReadTransport: { changeSignalSource: createPhase4bMcpChangeSignalSource() },
    }),
    /MCP read tool adapter is required/u,
  );

  const toolAdapter = emptyReadToolAdapterBundle();
  assert.throws(
    () => buildApiApp({
      config,
      ...projections,
      mcpReadTransport: {
        changeSignalSource: createPhase4bMcpChangeSignalSource(),
        readToolAdapter: toolAdapter.adapter,
      },
    }),
    /MCP read tool param declarations are required/u,
  );
});

test('GET, DELETE and other non-POST verbs fail closed with Allow POST; flag omission exposes no endpoint', async () => {
  const server = await startApi(mcpEnv());
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'] as const) {
    const response = await fetch(`${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'POST', method);
  }

  const disabled = await startApi(baseEnv);
  const get = await fetch(`${disabled.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`);
  assert.equal(get.status, 404);
  const post = await postJson(disabled, 'server/discover', 51);
  assert.equal(post.status, 404);
});

test('legacy initialize, Session, Last-Event-ID and deleted methods fail closed', async () => {
  const server = await startApi(mcpEnv());

  const initialize = await postRaw(server, JSON.stringify({
    jsonrpc: '2.0',
    id: 60,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {} },
  }), {
    'content-type': 'application/json',
    'mcp-method': 'initialize',
    'mcp-protocol-version': '2026-07-28',
    accept: 'application/json;q=1, text/event-stream;q=0.5',
  });
  assert.equal(initialize.status, 400);
  assert.equal(parseJsonRpc(await initialize.text()).error?.code, -32022);

  for (const header of ['Mcp-Session-Id', 'Last-Event-ID'] as const) {
    const response = await postJson(server, 'server/discover', 61, {
      headers: { [header]: 'legacy-value' },
    });
    assert.equal(response.status, 400, header);
    assert.equal(parseJsonRpc(await response.text()).error?.code, -32022, header);
  }

  for (const method of ['resources/subscribe', 'resources/unsubscribe', 'ping', 'logging/setLevel'] as const) {
    const response = await postJson(server, method, 62);
    assert.equal(response.status, 400, method);
    assert.equal(parseJsonRpc(await response.text()).error?.code, -32022, method);
  }
});

test('empty tool surface rejects unknown tool calls with stable -32602 without SDK stack traces', async () => {
  const server = await startApi(mcpEnv());
  const response = await postJson(server, 'tools/call', 70, {
    headers: { 'mcp-name': 'collections.get' },
    body: modernBody('tools/call', 70, {
      name: 'collections.get',
      arguments: { collectionId: 'collection-1' },
    }),
  });
  assert.equal(response.status, 200);
  const payload = parseJsonRpc(await response.text());
  assert.equal(payload.error?.code, -32602);
  assert.doesNotMatch(payload.error?.message ?? '', /at |stack|Error/u);
});

test('anonymous tools/list returns the public read tools', async () => {
  const server = await startApi(mcpEnv(), {}, hostToolSurface());

  const list = await postJson(server, 'tools/list', 201);
  assert.equal(list.status, 200);
  const tools = parseJsonRpc(await list.text()).result?.tools as ReadonlyArray<{ readonly name: string }>;
  assert.deepEqual(tools.map((tool) => tool.name), ['collections.get', 'collections.get_snapshot', 'nodes.get']);
  assert.equal(tools.some((tool) => /write|plan|commit|cancel/iu.test(tool.name)), false);
});

test('authenticated Modern clients discover and call bounded read Tools with encoded custom headers', async () => {
  const fixture = await authFixture();
  const server = await startApi(mcpEnv(), { oauthVerifier: fixture.verifier }, hostToolSurface());
  const authorization = `Bearer ${fixture.token}`;

  const list = await postJson(server, 'tools/list', 203, { headers: { authorization } });
  assert.equal(list.status, 200);
  const listPayload = parseJsonRpc(await list.text());
  const tools = listPayload.result?.tools as ReadonlyArray<{ readonly name: string }>;
  assert.deepEqual(tools.map((tool) => tool.name), ['collections.get', 'collections.get_snapshot', 'nodes.get']);
  assert.equal(tools.some((tool) => /write|plan|commit|feed|sync|audit|search/iu.test(tool.name)), false);

  const collectionId = 'collection-1 公共';
  const encodedParam = encodeMcp20260728ParamValue(collectionId);
  const call = await postJson(server, 'tools/call', 204, {
    headers: {
      authorization,
      'mcp-name': '=?base64?Y29sbGVjdGlvbnMuZ2V0?=',
      [`mcp-param-${PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER}`]: encodedParam,
    },
    body: modernBody('tools/call', 204, {
      name: 'collections.get',
      arguments: { collectionId },
    }),
  });
  assert.equal(call.status, 200);
  const callText = await call.text();
  const callPayload = parseJsonRpc(callText);
  assert.equal(callPayload.result?.resultType, 'complete');
  assert.equal(
    (callPayload.result?.structuredContent as { collection?: { id?: string } }).collection?.id,
    collectionId,
  );
  assert.doesNotMatch(callText, /Bearer |eyJ/iu);
});

test('write-only authenticated clients do not discover or call Read Tools', async () => {
  const fixture = await writeOnlyAuthFixture();
  const server = await startApi(
    mcpEnv(),
    { oauthVerifier: fixture.verifier },
    hostToolSurface(),
  );
  const authorization = `Bearer ${fixture.token}`;

  const list = await postJson(server, 'tools/list', 301, { headers: { authorization } });
  assert.deepEqual(parseJsonRpc(await list.text()).result?.tools, []);

  const call = await postJson(server, 'tools/call', 302, {
    headers: { authorization, 'mcp-name': 'collections.get' },
    body: modernBody('tools/call', 302, { name: 'collections.get', arguments: {} }),
  });
  assert.equal(parseJsonRpc(await call.text()).error?.code, -32602);
});

test('tools/call Header mismatch, unknown names, and private targets fail closed', async () => {
  const fixture = await authFixture();
  const server = await startApi(mcpEnv(), { oauthVerifier: fixture.verifier }, hostToolSurface());
  const authorization = `Bearer ${fixture.token}`;
  const paramHeader = `mcp-param-${PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER}`;

  const mismatch = await postJson(server, 'tools/call', 205, {
    headers: {
      authorization,
      'mcp-name': 'collections.get',
      [paramHeader]: 'other-collection',
    },
    body: modernBody('tools/call', 205, {
      name: 'collections.get',
      arguments: { collectionId: 'collection-1' },
    }),
  });
  assert.equal(parseJsonRpc(await mismatch.text()).error?.code, -32020);

  const invalidEncoding = await postJson(server, 'tools/call', 206, {
    headers: {
      authorization,
      'mcp-name': 'collections.get',
      [paramHeader]: '=?base64?***?=',
    },
    body: modernBody('tools/call', 206, {
      name: 'collections.get',
      arguments: { collectionId: 'collection-1' },
    }),
  });
  assert.equal(parseJsonRpc(await invalidEncoding.text()).error?.code, -32020);

  const unknown = await postJson(server, 'tools/call', 207, {
    headers: {
      authorization,
      'mcp-name': 'collections.unknown',
      [paramHeader]: 'collection-1',
    },
    body: modernBody('tools/call', 207, {
      name: 'collections.unknown',
      arguments: { collectionId: 'collection-1' },
    }),
  });
  assert.equal(parseJsonRpc(await unknown.text()).error?.code, -32602);

  const privateTarget = await postJson(server, 'tools/call', 208, {
    headers: {
      authorization,
      'mcp-name': 'collections.get',
      [paramHeader]: 'private-collection',
    },
    body: modernBody('tools/call', 208, {
      name: 'collections.get',
      arguments: { collectionId: 'private-collection' },
    }),
  });
  const privatePayload = parseJsonRpc(await privateTarget.text());
  assert.equal(privatePayload.error?.code, -32602);
  assert.doesNotMatch(privatePayload.error?.message ?? '', /private-collection/u);
});

test('tools/call honors per-request timeout and abort through the Modern adapter', async () => {
  const fixture = await authFixture();
  const server = await startApi(mcpEnv(), {
    oauthVerifier: fixture.verifier,
    requestTimeoutMs: 50,
  }, gatedToolSurface());
  const response = await postJson(server, 'tools/call', 209, {
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'mcp-name': 'collections.get',
      [`mcp-param-${PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER}`]: 'collection-1',
    },
    body: modernBody('tools/call', 209, {
      name: 'collections.get',
      arguments: { collectionId: 'collection-1' },
    }),
  });
  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), { error: 'mcp_request_timeout' });
});

test('duplicate MCP headers and header/body budgets fail closed', async () => {
  const server = await startApi(mcpEnv());

  const duplicate = await rawHttpPost(server, modernBody('server/discover', 80), [
    'Content-Type',
    'application/json',
    'MCP-Protocol-Version',
    '2026-07-28',
    'Mcp-Method',
    'server/discover',
    'Mcp-Method',
    'server/discover',
    'Accept',
    'application/json;q=1, text/event-stream;q=0.5',
  ]);
  assert.equal(duplicate.status, 400);
  assert.equal(parseJsonRpc(duplicate.body).error?.code, -32020);

  const many = await startApi(mcpEnv({ MCP_REQUEST_MAX_HEADER_COUNT: '16' }));
  const headers: Record<string, string> = { 'mcp-method': 'server/discover' };
  for (let index = 0; index < 20; index += 1) headers[`x-mcp-probe-${index}`] = 'value';
  const count = await postJson(many, 'server/discover', 81, { headers });
  assert.equal(count.status, 431);

  const long = await startApi(mcpEnv({ MCP_REQUEST_MAX_HEADER_VALUE_BYTES: '32' }));
  const longValue = await postJson(long, 'server/discover', 82, {
    headers: { 'x-mcp-probe-long': 'v'.repeat(64) },
  });
  assert.equal(longValue.status, 431);

  const smallBody = await startApi(mcpEnv({ MCP_REQUEST_MAX_BODY_BYTES: '64' }));
  const oversized = await postRaw(smallBody, 'x'.repeat(65));
  assert.equal(oversized.status, 413);
});

test('MCP strict I-JSON rejects duplicate members, unsafe numbers, budgets, and invalid UTF-8', async () => {
  const server = await startApi(mcpEnv());
  const headers = {
    'mcp-method': 'server/discover',
    'mcp-protocol-version': '2026-07-28',
    accept: 'application/json;q=1, text/event-stream;q=0.5',
  };
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['{"a":1,"a":2}', 'duplicate top-level member'],
    ['{"a":{"b":1,"b":2}}', 'duplicate nested member'],
    ['{"id":9007199254740992}', 'unsafe integer'],
    ['{"value":1e400}', 'non-finite number'],
    ['{"__proto__":{"polluted":true}}', 'prototype-polluting member name'],
    ['{"__proto__":1}', 'prototype-polluting primitive member name'],
    ['{"\\u005f\\u005fproto__":1}', 'escaped prototype-polluting member name'],
    ['{"constructor":1}', 'prototype-polluting constructor member name'],
    ['{"prototype":1}', 'prototype-polluting prototype member name'],
  ];
  for (const [body, label] of cases) {
    const text = await assertInvalidJsonResponse(await postRaw(server, body, headers), label);
    assert.doesNotMatch(text, /__proto__|polluted|9007199254740992|1e400/u, label);
  }

  const tooDeep = `${'{"a":'.repeat(17)}1${'}'.repeat(17)}`;
  await assertInvalidJsonResponse(await postRaw(server, tooDeep, headers), 'maximum depth');

  const tooManyMembers = `[${'0,'.repeat(10_000)}0]`;
  await assertInvalidJsonResponse(await postRaw(server, tooManyMembers, headers), 'maximum member/item budget');

  const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
  await assertInvalidJsonResponse(await postRaw(server, invalidUtf8, headers), 'invalid UTF-8');

  const legal = await postJson(server, 'server/discover', 150);
  assert.equal(legal.status, 200);

  const bodyLimited = await startApi(mcpEnv({ MCP_REQUEST_MAX_BODY_BYTES: '64' }));
  const bodyLimitBeforeParse = await postRaw(bodyLimited, `[${'0,'.repeat(32)}0]`, headers);
  assert.equal(bodyLimitBeforeParse.status, 413);
});

test('application/json without strictIJson keeps legacy JSON.parse behavior', async () => {
  const app = Fastify({ logger: false });
  installProductAdmission(app);
  app.post('/json', {
    config: {
      productTransport: {
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 65_536,
      },
    },
  }, async (request) => ({ body: request.body }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('product JSON server is not listening');
  const origin = `http://127.0.0.1:${address.port}`;

  const duplicate = await fetch(`${origin}/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1,"a":2}',
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual((await duplicate.json() as { readonly body: unknown }).body, { a: 2 });

  const unsafe = await fetch(`${origin}/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"id":9007199254740992}',
  });
  assert.equal(unsafe.status, 200);
  assert.deepEqual((await unsafe.json() as { readonly body: unknown }).body, { id: 9007199254740992 });
});

test('concurrent POST honors the bounded connection budget and rejects overflow', { timeout: 30_000 }, async () => {
  const fixture = await gatedAuthFixture();
  const operations = requestBudgetOperations();
  const server = await startApi(mcpEnv({
    MCP_REQUEST_MAX_CONCURRENT: '1',
    MCP_REQUEST_MAX_QUEUE: '1',
  }), { oauthVerifier: fixture.verifier, operations });

  // Undici connection-pool warm-up: the held request must be the FIRST to
  // reach the server handler (a fresh TCP connection can otherwise race the
  // pooled connection of the subsequently issued requests and invert the
  // arrival order, making the slot holder nondeterministic).
  await fetch(server.origin + '/').then((r) => r.text()).catch(() => undefined);
  const first = postJson(server, 'server/discover', 90, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  await fixture.gate.started;
  const second = postJson(server, 'server/discover', 91);
  await waitForQueueSlot(operations);
  const overflow = await postJson(server, 'server/discover', 92);
  assert.equal(overflow.status, 503);

  fixture.gate.release();
  const queued = await withTimeout(second, 5_000, 'queued request did not complete');
  assert.equal(queued.status, 200);
  const held = await withTimeout(first, 5_000, 'held request did not complete');
  assert.equal(held.status, 200);
});

test('overflow rejection never releases a busy connection slot', { timeout: 30_000 }, async () => {
  const fixture = await gatedAuthFixture();
  const operations = requestBudgetOperations();
  const server = await startApi(mcpEnv({
    MCP_REQUEST_MAX_CONCURRENT: '1',
    MCP_REQUEST_MAX_QUEUE: '1',
  }), { oauthVerifier: fixture.verifier, operations });

  // Undici connection-pool warm-up: the held request must be the FIRST to
  // reach the server handler (see the sibling budget test for the race).
  await fetch(server.origin + '/').then((r) => r.text()).catch(() => undefined);
  const held = postJson(server, 'server/discover', 96, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  await fixture.gate.started;
  const queued = postJson(server, 'server/discover', 97);
  await waitForQueueSlot(operations);
  const overflow = await postJson(server, 'server/discover', 98);
  assert.equal(overflow.status, 503);

  fixture.gate.release();
  // The two ADMITTED requests both block on the OAuth epoch gate until the
  // release above, so the observable contract is: overflow 503 while the
  // queue is full, and every admitted request completes with 200 afterwards.
  // (The settle ORDER of the two admitted requests is a connection-arrival
  // race between undici's pooled connection and a freshly opened one — not
  // part of the budget contract — so no order assertion is made.)
  const [heldResponse, queuedResponse] = await Promise.all([
    withTimeout(held, 5_000, 'held request did not complete'),
    withTimeout(queued, 5_000, 'queued request did not complete'),
  ]);
  assert.equal(heldResponse.status, 200);
  assert.equal(queuedResponse.status, 200);
});

test('client abort releases the dispatch slot and a new request gets a fresh request ID', async () => {
  const fixture = await gatedAuthFixture();
  const server = await startApi(mcpEnv({
    MCP_REQUEST_MAX_CONCURRENT: '1',
    MCP_REQUEST_MAX_QUEUE: '1',
  }), { oauthVerifier: fixture.verifier });

  const controller = new AbortController();
  const first = postJson(server, 'server/discover', 100, {
    headers: { authorization: `Bearer ${fixture.token}` },
    signal: controller.signal,
  });
  await fixture.gate.started;
  controller.abort();
  await assert.rejects(() => first);
  fixture.gate.release();

  const second = await withTimeout(postJson(server, 'server/discover', 101), 5_000, 'slot was not released');
  assert.equal(second.status, 200);
  assert.ok(second.headers.get('x-request-id'));
});

test('an interrupted SSE stream is followed by a new X-Request-Id', async () => {
  const fixture = await gatedAuthFixture();
  const server = await startApi(mcpEnv(), { oauthVerifier: fixture.verifier });

  const controller = new AbortController();
  const first = mcpHttpPost(
    `${server.origin}${PHASE4B_MCP_CONFIG_ENDPOINT_PATH}`,
    withMcpTestHost({
      'content-type': 'application/json',
      'mcp-method': 'server/discover',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=0.5, text/event-stream;q=1',
      authorization: `Bearer ${fixture.token}`,
    }, server.config.publication.origin),
    modernBody('server/discover', 110),
    controller.signal,
  );
  await fixture.gate.started;
  fixture.gate.release();
  const firstResponse = await withTimeout(first, 5_000, 'SSE response did not start');
  const firstRequestId = firstResponse.headers.get('x-request-id');
  assert.ok(firstRequestId);
  const reader = firstResponse.body?.getReader();
  assert.ok(reader);
  await withTimeout(reader.read(), 5_000, 'SSE stream did not produce its leading comment');
  controller.abort();
  // Node http.request may already have delivered the rest of the short SSE
  // body, so the next read() can complete instead of rejecting the way fetch
  // abort does. Cancel still tears the socket down.
  await reader.cancel(controller.signal.reason).catch(() => undefined);

  const second = await withTimeout(postJson(server, 'server/discover', 111), 5_000, 'next request did not complete');
  assert.equal(second.status, 200);
  assert.ok(second.headers.get('x-request-id'));
  assert.notEqual(second.headers.get('x-request-id'), firstRequestId);
});

test('per-request timeout returns a stable 408 and shutdown closes in-flight work', async () => {
  const timedFixture = await gatedAuthFixture();
  const timed = await startApi(mcpEnv(), {
    oauthVerifier: timedFixture.verifier,
    requestTimeoutMs: 50,
  });
  const timeoutRequest = postJson(timed, 'server/discover', 120, {
    headers: { authorization: `Bearer ${timedFixture.token}` },
  });
  await timedFixture.gate.started;
  const timeoutResponse = await withTimeout(timeoutRequest, 5_000, 'timeout response did not arrive');
  assert.equal(timeoutResponse.status, 408);
  timedFixture.gate.release();

  const shutdownFixture = await gatedAuthFixture();
  const shutdown = await startApi(mcpEnv(), {
    oauthVerifier: shutdownFixture.verifier,
  });
  const pending = postJson(shutdown, 'server/discover', 121, {
    headers: { authorization: `Bearer ${shutdownFixture.token}` },
  });
  await shutdownFixture.gate.started;
  await withTimeout(shutdown.app.close(), 5_000, 'shutdown did not close');
  await assert.rejects(() => pending);
  shutdownFixture.gate.release();
});

test('MCP request rate limit returns stable 429 and separates anonymous and authenticated keys', async () => {
  let now = 1_000;
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 1, windowMs: 60_000 },
    now: () => now,
  });
  const fixture = await authFixture();
  const server = await startApi(mcpEnv(), {
    oauthVerifier: fixture.verifier,
    requestRateLimiter: limiter,
  });

  const anonymous = await postJson(server, 'server/discover', 300);
  assert.equal(anonymous.status, 200);

  const authenticated = await postJson(server, 'server/discover', 301, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(authenticated.status, 200, 'authenticated principal must use a distinct rate limit key');

  const limitedAnonymous = await postJson(server, 'server/discover', 302);
  assert.equal(limitedAnonymous.status, 429);
  assert.equal(limitedAnonymous.headers.get('retry-after'), '60');
  assert.deepEqual(await limitedAnonymous.json(), { error: 'mcp_rate_limited' });

  const limitedAuthenticated = await postJson(server, 'server/discover', 303, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(limitedAuthenticated.status, 429);
  assert.doesNotMatch(await limitedAuthenticated.text(), /127\.0\.0\.1|principal|clientId|credentialBindingId/u);

  limiter.reset();
  const listenProbe = await postJson(server, 'server/discover', 305);
  assert.equal(listenProbe.status, 200);
  const limitedListen = await postRaw(
    server,
    modernBody('subscriptions/listen', 'listen-limited', { notifications: {} }),
    {
      'content-type': 'application/json',
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
      accept: 'application/json;q=0.5, text/event-stream;q=1',
    },
  );
  assert.equal(limitedListen.status, 429, 'SSE/listen must reject before opening a 200 stream');
  assert.equal(limitedListen.headers.get('retry-after'), '60');
  assert.match(limitedListen.headers.get('content-type') ?? '', /^application\/json/u);
  assert.deepEqual(await limitedListen.json(), { error: 'mcp_rate_limited' });

  now += 60_000;
  const afterWindow = await postJson(server, 'server/discover', 304);
  assert.equal(afterWindow.status, 200, 'fixed window must reset after windowMs');
});

test('MCP request budget is shared across jti rotation and switches on epoch (FIX-L-043)', async () => {
  const now = 1_000;
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 1, windowMs: 60_000 },
    now: () => now,
  });
  const key = await createKeyFixture('key-fix-l-043');
  let epoch = 'epoch-1';
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
    securityEpoch: async () => epoch,
  }));
  const tokenA = await mintCredential({ key: key.privateKey, kid: key.kid, jti: 'jti-a' });
  const tokenB = await mintCredential({ key: key.privateKey, kid: key.kid, jti: 'jti-b' });
  const bobToken = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    jti: 'jti-bob',
    subject: 'urn:known:subject:bob',
  });
  const server = await startApi(mcpEnv(), {
    oauthVerifier: verifier,
    requestRateLimiter: limiter,
  });

  const first = await postJson(server, 'server/discover', 400, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(first.status, 200);

  const rotated = await postJson(server, 'server/discover', 401, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(
    rotated.status,
    429,
    'a rotated jti for the same principal/client must share the request budget',
  );

  const otherPrincipal = await postJson(server, 'server/discover', 402, {
    headers: { authorization: `Bearer ${bobToken}` },
  });
  assert.equal(otherPrincipal.status, 200, 'a different principal must keep an isolated budget');

  epoch = 'epoch-2';
  const afterEpoch = await postJson(server, 'server/discover', 403, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(afterEpoch.status, 200, 'a security epoch change must switch the budget boundary');

  const rotatedInNewEpoch = await postJson(server, 'server/discover', 404, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(
    rotatedInNewEpoch.status,
    429,
    'the new epoch bucket must still be shared across jtis',
  );
});
