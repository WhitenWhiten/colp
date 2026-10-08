/**
 * T-08 remaining §9.3 security/fault cases on the production compat route.
 * Protocol handshake lives in `phase4b-mcp-compat-matrix.test.ts`.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'vitest';
import { waitForCondition } from '../../support/async-test-helpers.js';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { IdTokenVerificationError } from '../../../src/modules/identity/index.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_READINESS_PATH,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
  createInMemoryMcpOauthRevocationStore,
  createMcpOauthVerifier,
} from '../../../src/modules/mcp/index.js';
import type { McpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { createConnectionBudget } from '../../../src/transport/mcp/mcp-shared-admission.js';
import {
  ACCOUNT_ID,
  AUDIENCE,
  CLIENT_ID,
  ISSUER,
  NOW,
  SUBJECT,
  createKeyFixture,
  mintCredential,
  staticJwksProvider,
  verifierOptions,
  MCP_TEST_REQUEST_HOST,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  compatJsonRpc,
  createCompatPingCapture,
  injectCompatLegacyPost,
  injectCompatPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
  mintProductionCompatCanaryAuth,
  compatAuthFixture,
  withFacadeTaintCapture,
  assertProductionCompatBearerDropped,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatResourcesListBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import type { McpApplicationFacade } from '../../../src/modules/mcp/index.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function assertNoRetarget(response: {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): void {
  assert.equal(response.headers.location, undefined);
  assert.equal(response.headers['content-location'], undefined);
  assert.ok(response.statusCode < 300 || response.statusCode >= 400);
  assert.doesNotMatch(response.payload, /retry the (strict|compat)|automatic fallback|retarget/iu);
}

function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  return waitForCondition(predicate, { timeoutMs: 2_000, description: label });
}

async function mintWithoutClientId(input: {
  readonly key: Parameters<typeof mintCredential>[0]['key'];
  readonly kid: string;
  readonly clientId?: string | null;
}): Promise<string> {
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  const payload: Record<string, unknown> = {
    scope: 'mcp:read:public mcp:read:own',
  };
  if (input.clientId !== null && input.clientId !== undefined) {
    payload.client_id = input.clientId;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(ISSUER)
    .setSubject(SUBJECT)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSeconds - 5)
    .setExpirationTime(nowSeconds + 3_600)
    .setJti('t08-wrong-client')
    .sign(input.key);
}

test('security epoch mismatch fails closed on compat and does not retarget strict', async () => {
  const capture = createCompatPingCapture();
  let current = new Date(NOW.getTime() - 120_000);
  const store = createInMemoryMcpOauthRevocationStore({ now: () => current });
  const key = await createKeyFixture('key-epoch-t08');
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: (query) => store.isRevoked(query),
    audience: [AUDIENCE, `${AUDIENCE}-compat`],
    securityEpoch: () => store.securityEpoch(),
    now: () => current,
  }));
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: verifier,
      applicationFacade: pingMcpApplicationFacade(capture),
    },
  }));
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    now: NOW,
    jti: 't08-epoch-old',
    audience: `${AUDIENCE}-compat`,
  });
  const ok = await injectCompatPost(server.app, mcpCompatToolsListBody(1), {
    authorization: `Bearer ${token}`,
  });
  assert.equal(ok.statusCode, 200);

  current = NOW;
  await store.bumpSecurityEpoch('epoch-bumped-t08');
  const stale = await injectCompatPost(server.app, mcpCompatToolsListBody(2), {
    authorization: `Bearer ${token}`,
  });
  assert.equal(stale.statusCode, 401);
  assertNoRetarget(stale);
  assert.doesNotMatch(stale.payload, /epoch-bumped-t08|SELECT /u);

  current = new Date(NOW.getTime() + 120_000);
  const fresh = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    now: current,
    jti: 't08-epoch-new',
    audience: `${AUDIENCE}-compat`,
  });
  const recovered = await injectCompatPost(server.app, mcpCompatToolsListBody(3), {
    authorization: `Bearer ${fresh}`,
  });
  assert.equal(recovered.statusCode, 200);
  const strictToken = await mintCredential({ key: key.privateKey, kid: key.kid, now: current });
  const strict = await injectStrictPost(server.app, 'server/discover', 4, {
    authorization: `Bearer ${strictToken}`,
  });
  assert.equal(strict.statusCode, 200);
});

test('wrong or missing OAuth client_id fails closed on compat', async () => {
  const key = await createKeyFixture('key-client-t08');
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
  }));
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier: verifier } }));
  const missing = await mintWithoutClientId({ key: key.privateKey, kid: key.kid, clientId: null });
  const empty = await mintWithoutClientId({ key: key.privateKey, kid: key.kid, clientId: '' });
  for (const token of [missing, empty]) {
    const response = await injectCompatPost(server.app, mcpCompatToolsListBody(1), {
      authorization: `Bearer ${token}`,
    });
    assert.equal(response.statusCode, 401);
    assertNoRetarget(response);
    assert.doesNotMatch(response.payload, new RegExp(token, 'u'));
  }
  assert.equal(CLIENT_ID.length > 0, true);
  assert.equal(ACCOUNT_ID.length > 0, true);
  assert.equal(SUBJECT.length > 0, true);
});

test('JWKS fetch failure fails closed without leaking internals or retargeting', async () => {
  const key = await createKeyFixture('key-jwks-t08');
  const token = await mintCredential({ key: key.privateKey, kid: key.kid, jti: 't08-jwks' });
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: {
      async getKeySet() {
        throw new IdTokenVerificationError('jwks_fetch_failed', 'JWKS upstream SELECT secrets');
      },
    },
  }));
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier: verifier } }));
  const response = await injectCompatPost(server.app, mcpCompatToolsListBody(1), {
    authorization: `Bearer ${token}`,
  });
  assert.ok(response.statusCode >= 400);
  assert.notEqual(response.statusCode, 200);
  assertNoRetarget(response);
  assert.doesNotMatch(response.payload, /JWKS upstream SELECT secrets|eyJ/u);
  const strict = await injectStrictPost(server.app, 'server/discover', 2);
  assert.equal(strict.statusCode, 200);
});

test('Redis limiter unavailability is 503 on compat and does not retarget or replay writes', async () => {
  const limiter: McpRateLimiter = {
    async consume() {
      return {
        kind: 'failed',
        failure: { class: 'unavailable', code: 'mcp_rate_limit_redis_unavailable' },
      };
    },
    readiness: () => ({
      status: 'degraded',
      reason: 'last_command_failed',
      lastCheckedAtEpochMs: NOW.getTime(),
    }),
    async close() {
      return;
    },
  };
  const server = track(startCompatApp({
    mcpReadTransport: { requestRateLimiter: limiter },
    mcpRateLimiter: limiter,
  }));
  const compat = await injectCompatPost(server.app, mcpCompatToolsListBody(1));
  assert.equal(compat.statusCode, 503);
  assert.deepEqual(compat.json(), { error: 'mcp_rate_limit_unavailable' });
  assertNoRetarget(compat);
  const strict = await injectStrictPost(server.app, 'server/discover', 2);
  assert.equal(strict.statusCode, 503);
  assert.deepEqual(strict.json(), { error: 'mcp_rate_limit_unavailable' });
});

test('DB exception on resources/list does not leak internals or retarget', async () => {
  const base = pingMcpApplicationFacade();
  const facade: McpApplicationFacade = Object.freeze({
    ...base,
    async listResources() {
      throw new Error('relation "resource_visibility" does not exist SELECT secrets');
    },
  });
  const server = track(startCompatApp({ mcpReadTransport: { applicationFacade: facade } }));
  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(5),
    COMPAT_REVISION,
  );
  assert.ok(listed.statusCode === 200 || listed.statusCode >= 400);
  assertNoRetarget(listed);
  assert.doesNotMatch(listed.payload, /resource_visibility|SELECT secrets/u);
  const strict = await injectStrictPost(server.app, 'server/discover', 6);
  assert.equal(strict.statusCode, 200);
});

test('SDK exception mapping hides internals and does not retarget the other endpoint', async () => {
  const base = pingMcpApplicationFacade();
  const facade: McpApplicationFacade = Object.freeze({
    ...base,
    async callTool() {
      throw new Error('relation "collections" does not exist SELECT secrets');
    },
  });
  const server = track(startCompatApp({ mcpReadTransport: { applicationFacade: facade } }));
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 3),
    COMPAT_REVISION,
  );
  assert.ok(called.statusCode === 200 || called.statusCode >= 400);
  assertNoRetarget(called);
  assert.doesNotMatch(called.payload, /relation "collections"|SELECT secrets/u);
  if (called.statusCode === 200) {
    const result = compatJsonRpc(called).result ?? {};
    assert.equal(result.isError === true || compatJsonRpc(called).error !== undefined, true);
  }
  const strict = await injectStrictPost(server.app, 'server/discover', 9);
  assert.equal(strict.statusCode, 200);
});

test('request timeout aborts in-flight compat work without retargeting strict', async () => {
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture, { slow: true }),
      requestTimeoutMs: 40,
    },
  }));
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 99),
    COMPAT_REVISION,
  );
  assert.ok(called.statusCode === 200 || called.statusCode >= 400);
  assert.equal(capture.aborted, true);
  assertNoRetarget(called);
  assert.doesNotMatch(called.payload, /TimeoutError|stack|SELECT /u);
  const strict = await injectStrictPost(server.app, 'server/discover', 10);
  assert.equal(strict.statusCode, 200);
});

test('401, 403, 5xx, and timeout on compat do not automatically fall back to strict', async () => {
  const fixture = await compatAuthFixture();
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: fixture.verifier,
      applicationFacade: pingMcpApplicationFacade(capture, { slow: true }),
      requestTimeoutMs: 40,
    },
  }));

  const unauthorized = await injectCompatPost(server.app, mcpCompatToolsListBody(1), {
    authorization: 'Bearer not-a-jwt',
  });
  assert.equal(unauthorized.statusCode, 401);
  assertNoRetarget(unauthorized);
  assert.equal(capture.listCalls, 0);

  const forbidden = await injectCompatPost(server.app, mcpCompatToolsListBody(2), {
    origin: 'https://attacker.example.test',
    authorization: `Bearer ${fixture.token}`,
  });
  assert.equal(forbidden.statusCode, 403);
  assertNoRetarget(forbidden);
  assert.equal(server.admissions.length, 0);

  const timedOut = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 3),
    COMPAT_REVISION,
    { authorization: `Bearer ${fixture.token}` },
  );
  assertNoRetarget(timedOut);
  assert.equal(capture.aborted, true);

  const stillStrict = await injectStrictPost(server.app, 'server/discover', 11, {
    authorization: `Bearer ${fixture.strictToken}`,
  });
  assert.equal(stillStrict.statusCode, 200);
});

test('undeclared logging, sampling, roots, and tasks methods return a stable method error', async () => {
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade() },
  }));
  for (const [id, method] of [
    [80, 'logging/setLevel'],
    [81, 'sampling/createMessage'],
    [82, 'roots/list'],
    [83, 'tasks/list'],
    [84, 'completion/complete'],
  ] as const) {
    const response = await injectCompatLegacyPost(
      server.app,
      { jsonrpc: '2.0', id, method, params: {} },
      COMPAT_REVISION,
    );
    assert.equal(compatJsonRpc(response).error?.code, -32_601, method);
  }
});

test('strict/compat share one connection budget so switching endpoints cannot bypass concurrency', async () => {
  const capture = createCompatPingCapture();
  const budget = createConnectionBudget(1, 0);
  const server = track(startCompatApp({
    mcpReadTransport: {
      applicationFacade: pingMcpApplicationFacade(capture, { slow: true }),
      requestConnectionBudget: budget,
    },
  }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address();
  assert.ok(address && typeof address === 'object');
  const inFlight = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: MCP_COMPAT_ENDPOINT_PATH,
    method: 'POST',
    headers: {
      ...mcpCompatAcceptHeaders(COMPAT_REVISION),
      host: MCP_TEST_REQUEST_HOST,
    },
  });
  inFlight.write(JSON.stringify(mcpCompatToolsCallBody('compat.ping', 99)));
  inFlight.end();
  inFlight.on('error', () => undefined);
  await waitUntil(() => capture.slowStarted, 'slow tool start');
  const strict = await injectStrictPost(server.app, 'server/discover', 12);
  assert.equal(strict.statusCode, 503);
  const listed = await injectCompatPost(server.app, mcpCompatToolsListBody(13));
  assert.equal(listed.statusCode, 503);
  inFlight.destroy();
  await waitUntil(() => capture.aborted, 'abort after destroy');
});

test('canary rollback (flag off) 404s compat surfaces and leaves strict registered', async () => {
  const server = track(startCompatApp({ compatEnabled: false }));
  const post = await injectCompatPost(server.app, mcpCompatInitializeBody(COMPAT_REVISION, {
    name: 'claude-code',
    version: '2.1.250',
  }));
  assert.equal(post.statusCode, 404);
  assert.equal((await server.app.inject({ method: 'GET', url: MCP_COMPAT_READINESS_PATH })).statusCode, 404);
  assert.equal((await server.app.inject({
    method: 'GET',
    url: PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
  })).statusCode, 404);
  const get = await server.app.inject({ method: 'GET', url: MCP_COMPAT_ENDPOINT_PATH });
  assert.equal(get.statusCode, 404);
  const strict = await injectStrictPost(server.app, 'server/discover', 14);
  assert.equal(strict.statusCode, 200);
  assert.equal((await server.app.inject({ method: 'GET', url: '/ready/features/mcp' })).statusCode, 200);
});

test('production tool throw does not leak the uniquely canaried bearer into SDK Request, facade, or response', async () => {
  const { token, verifierInputs, recordingVerifier } = await mintProductionCompatCanaryAuth();
  const facadeTaint: string[] = [];
  const base = pingMcpApplicationFacade();
  const facade: McpApplicationFacade = withFacadeTaintCapture(Object.freeze({
    ...base,
    async callTool() {
      throw new Error(`relation "collections" does not exist SELECT ${token}`);
    },
  }), facadeTaint);
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: recordingVerifier,
      applicationFacade: facade,
    },
  }));
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 3),
    COMPAT_REVISION,
    { authorization: `Bearer ${token}` },
  );
  assert.ok(called.statusCode === 200 || called.statusCode >= 400);
  assert.doesNotMatch(called.payload, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assertProductionCompatBearerDropped({
    canary: token,
    verifierInputs,
    server,
    facadeTaint,
    onerror: [called.payload],
    response: called,
  });
});

test('production timeout does not leak the uniquely canaried bearer into SDK Request, facade, or response', async () => {
  const { token, verifierInputs, recordingVerifier } = await mintProductionCompatCanaryAuth();
  const facadeTaint: string[] = [];
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: recordingVerifier,
      applicationFacade: withFacadeTaintCapture(
        pingMcpApplicationFacade(capture, { slow: true }),
        facadeTaint,
      ),
      requestTimeoutMs: 40,
    },
  }));
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('compat.ping', 99),
    COMPAT_REVISION,
    { authorization: `Bearer ${token}` },
  );
  assert.ok(called.statusCode === 200 || called.statusCode >= 400);
  assert.equal(capture.aborted, true);
  assertProductionCompatBearerDropped({
    canary: token,
    verifierInputs,
    server,
    facadeTaint,
    response: called,
  });
});

test('production client disconnect does not leak the uniquely canaried bearer into SDK Request or facade', async () => {
  const { token, verifierInputs, recordingVerifier } = await mintProductionCompatCanaryAuth();
  const facadeTaint: string[] = [];
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: recordingVerifier,
      applicationFacade: withFacadeTaintCapture(
        pingMcpApplicationFacade(capture, { slow: true }),
        facadeTaint,
      ),
    },
  }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address();
  assert.ok(address && typeof address === 'object');
  const inFlight = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: MCP_COMPAT_ENDPOINT_PATH,
    method: 'POST',
    headers: {
      ...mcpCompatAcceptHeaders(COMPAT_REVISION),
      host: MCP_TEST_REQUEST_HOST,
      authorization: `Bearer ${token}`,
    },
  });
  inFlight.write(JSON.stringify(mcpCompatToolsCallBody('compat.ping', 99)));
  inFlight.end();
  inFlight.on('error', () => undefined);
  await waitUntil(() => capture.slowStarted, 'slow tool start');
  inFlight.destroy();
  await waitUntil(() => capture.aborted, 'abort after destroy');
  assertProductionCompatBearerDropped({
    canary: token,
    verifierInputs,
    server,
    facadeTaint,
  });
});
