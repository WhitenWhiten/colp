import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_AUTH_TOKEN_SENTINEL,
  createMcpOauthVerifier,
  requiredScopesForMcpReadOperation,
  type McpOauthVerifierOptions,
} from '../../../src/modules/mcp/index.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  collectTaint,
  compatRpc,
  injectCompatPost,
  injectStrictPost,
  startCompatApp,
  createCompatPingCapture,
  pingMcpApplicationFacade,
  mintProductionCompatCanaryAuth,
  withFacadeTaintCapture,
  assertProductionCompatBearerDropped,
  compatAuthFixture,
} from '../../support/phase4b-mcp-compat-admission.js';
import { MCP_COMPAT_CANARY_BEARER } from '../../support/phase4b-mcp-compat-spike.js';
import {
  ACCOUNT_ID,
  AUDIENCE,
  ISSUER,
  NOW,
  SUBJECT,
  createKeyFixture,
  mintCredential,
  staticJwksProvider,
  verifierOptions,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

async function signedVerifier(overrides: Partial<McpOauthVerifierOptions> = {}) {
  const key = await createKeyFixture('key-compat-t03');
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks: staticJwksProvider([key.jwk]),
    now: () => NOW,
    clockToleranceSeconds: 0,
    ...overrides,
  }));
  return { key, verifier };
}

test('valid bearer succeeds admission then tools/list is served', async () => {
  const fixture = await compatAuthFixture();
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier: fixture.verifier } }));
  const response = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${fixture.token}`,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(server.admissions.length, 1);
  const admitted = server.admissions[0]!;
  assert.equal(admitted.applicationContext.principal.kind, 'authenticated');
  assert.equal(admitted.authInfo.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
  assert.notEqual(admitted.authInfo.token, fixture.token);
  const blob = collectTaint([
    admitted,
    admitted.authInfo,
    admitted.applicationContext,
    response.payload,
    response.headers,
    server.metricNames,
  ]);
  assert.doesNotMatch(blob, new RegExp(fixture.token, 'u'));
  assert.doesNotMatch(blob, /Bearer /u);
});

test('resources/read without mcp:read:own is 403 insufficient_scope on both endpoints', async () => {
  const { key, verifier } = await signedVerifier();
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: ['mcp:read:public'],
  });
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier: verifier } }));
  const headers = { authorization: `Bearer ${token}` };
  const compat = await injectCompatPost(
    server.app,
    compatRpc('resources/read', 2, { uri: 'colp://example/collections/x' }),
    headers,
  );
  const strict = await injectStrictPost(server.app, 'resources/read', 2, {
    ...headers,
    'mcp-name': 'colp://example/collections/x',
  });
  assert.equal(requiredScopesForMcpReadOperation({ method: 'resources/read' })[0], 'mcp:read:own');
  assert.equal(compat.statusCode, 403);
  assert.equal(strict.statusCode, 403);
  const origin = server.config.mcp!.origin;
  const compatChallenge = String(compat.headers['www-authenticate'] ?? '');
  const strictChallenge = String(strict.headers['www-authenticate'] ?? '');
  assert.equal(
    strictChallenge,
    `Bearer error="insufficient_scope", scope="mcp:read:public mcp:read:own", resource_metadata="${origin}/.well-known/oauth-protected-resource/collections/-/mcp"`,
  );
  assert.equal(
    compatChallenge,
    `Bearer error="insufficient_scope", scope="mcp:read:public mcp:read:own", resource_metadata="${origin}/.well-known/oauth-protected-resource/collections/-/mcp-compat"`,
  );
  assert.notEqual(compatChallenge, strictChallenge);
  assert.equal(compat.json().error?.code, 'insufficient_permission');
  assert.equal(compat.json().error?.code, strict.json().error?.code);
});

test('expired, revoked, wrong audience, wrong issuer, and missing scope fail closed', async () => {
  const key = await createKeyFixture('key-compat-neg');
  const jwks = staticJwksProvider([key.jwk]);
  let revoked = false;
  const verifier = createMcpOauthVerifier(verifierOptions({
    jwks,
    now: () => NOW,
    clockToleranceSeconds: 0,
    isRevoked: async () => revoked,
  }));
  const server = track(startCompatApp({ mcpReadTransport: { oauthVerifier: verifier } }));

  const expired = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    expOffsetSeconds: -60,
  });
  const expiredResponse = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${expired}`,
  });
  assert.equal(expiredResponse.statusCode, 401);

  const wrongAud = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    audience: 'https://other.example.test/collections/-/mcp',
  });
  const audResponse = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${wrongAud}`,
  });
  assert.equal(audResponse.statusCode, 401);

  const wrongIss = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    issuer: 'https://evil.example.test/api/v1/auth',
  });
  const issResponse = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${wrongIss}`,
  });
  assert.equal(issResponse.statusCode, 401);

  revoked = true;
  const live = await mintCredential({ key: key.privateKey, kid: key.kid, jti: 'revoked-jti' });
  const revokedResponse = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${live}`,
  });
  assert.equal(revokedResponse.statusCode, 401);
  revoked = false;

  const publicOnly = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scope: ['mcp:read:public'],
    jti: 'missing-scope-jti',
  });
  const missingScope = await injectCompatPost(
    server.app,
    compatRpc('resources/list'),
    { authorization: `Bearer ${publicOnly}` },
  );
  assert.equal(missingScope.statusCode, 403);

  for (const response of [expiredResponse, audResponse, issResponse, revokedResponse, missingScope]) {
    assert.doesNotMatch(response.payload, /eyJ/u);
    assert.match(String(response.headers['www-authenticate'] ?? ''), /Bearer error=/u);
  }
});

test('bearer present without a wired verifier fails closed like strict', async () => {
  const server = track(startCompatApp());
  const headers = { authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}` };
  const compat = await injectCompatPost(server.app, compatRpc('tools/list'), headers);
  const strict = await injectStrictPost(server.app, 'server/discover', 50, headers);
  assert.equal(compat.statusCode, 503);
  assert.equal(strict.statusCode, 503);
  assert.deepEqual(compat.json(), { error: 'mcp_oauth_verifier_unconfigured' });
  assert.doesNotMatch(compat.payload, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
});

test('exhausting quota on strict rate-limits compat POST and vice versa', async () => {
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 1, windowMs: 60_000 },
    now: () => 1_000,
  });
  const fixture = await compatAuthFixture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: fixture.verifier,
      requestRateLimiter: limiter,
    },
    mcpRateLimiter: limiter,
  }));
  const headers = { authorization: `Bearer ${fixture.token}` };

  const strictHeaders = { authorization: `Bearer ${fixture.strictToken}` };
  const strictOk = await injectStrictPost(server.app, 'server/discover', 300, strictHeaders);
  assert.equal(strictOk.statusCode, 200);
  const compatLimited = await injectCompatPost(server.app, compatRpc('tools/list'), headers);
  assert.equal(compatLimited.statusCode, 429);
  assert.equal(compatLimited.headers['retry-after'], '60');
  assert.deepEqual(compatLimited.json(), { error: 'mcp_rate_limited' });

  limiter.reset();
  const compatOk = await injectCompatPost(server.app, compatRpc('tools/list'), headers);
  assert.equal(compatOk.statusCode, 200);
  const strictLimited = await injectStrictPost(server.app, 'server/discover', 301, strictHeaders);
  assert.equal(strictLimited.statusCode, 429);
  assert.deepEqual(strictLimited.json(), { error: 'mcp_rate_limited' });
});

test('anonymous quota is also shared across the two endpoints', async () => {
  const limiter = createMemoryMcpRateLimiter({
    request: { maxRequests: 1, windowMs: 60_000 },
    now: () => 1_000,
  });
  const server = track(startCompatApp({
    mcpReadTransport: { requestRateLimiter: limiter },
    mcpRateLimiter: limiter,
  }));
  const strictOk = await injectStrictPost(server.app, 'server/discover', 310);
  assert.equal(strictOk.statusCode, 200);
  const compatLimited = await injectCompatPost(server.app, compatRpc('initialize'));
  assert.equal(compatLimited.statusCode, 429);
});

test('endpoint-specific audiences remain required before shared quota admission', async () => {
  const fixture = await compatAuthFixture();
  const limiter = createMemoryMcpRateLimiter({ request: { maxRequests: 1, windowMs: 60_000 } });
  const server = track(startCompatApp({
    mcpReadTransport: { oauthVerifier: fixture.verifier, requestRateLimiter: limiter }, mcpRateLimiter: limiter,
  }));
  assert.equal((await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${fixture.strictToken}`,
  })).statusCode, 401);
  assert.equal((await injectStrictPost(server.app, 'server/discover', 311, {
    authorization: `Bearer ${fixture.token}`,
  })).statusCode, 401);
  assert.equal((await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${fixture.token}`,
  })).statusCode, 200);
  assert.equal((await injectStrictPost(server.app, 'server/discover', 312, {
    authorization: `Bearer ${fixture.strictToken}`,
  })).statusCode, 429);
});

test('canary bearer never appears in admission context, logs, metrics, or response', async () => {
  const fixture = await compatAuthFixture();
  const steps: string[] = [];
  const oauthVerifier = {
    async verify(input: { readonly authorization: string | readonly string[] | undefined }) {
      steps.push('oauth');
      return fixture.verifier.verify(input);
    },
  };
  const inner = createMemoryMcpRateLimiter({
    request: { maxRequests: 8, windowMs: 60_000 },
    now: () => 1_000,
  });
  const requestRateLimiter = {
    consume: async (subject: Parameters<typeof inner.consume>[0]) => {
      steps.push('rate');
      return inner.consume(subject);
    },
    close: () => inner.close(),
    readiness: () => inner.readiness(),
  };
  const server = track(startCompatApp({
    mcpReadTransport: { oauthVerifier, requestRateLimiter },
    mcpRateLimiter: requestRateLimiter,
  }));
  const ok = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${fixture.token}`,
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(steps, ['oauth', 'rate']);

  const failed = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${MCP_COMPAT_CANARY_BEARER}`,
  });
  assert.equal(failed.statusCode, 401);

  const blob = collectTaint([
    server.admissions,
    ok.payload,
    ok.headers,
    failed.json(),
    failed.payload,
    failed.headers,
    server.metricNames,
    steps,
    ACCOUNT_ID,
    SUBJECT,
    ISSUER,
    AUDIENCE,
  ]);
  assert.doesNotMatch(blob, new RegExp(MCP_COMPAT_CANARY_BEARER, 'u'));
  assert.doesNotMatch(blob, new RegExp(fixture.token, 'u'));
  assert.equal(server.admissions[0]?.authInfo.token, MCP_COMPAT_AUTH_TOKEN_SENTINEL);
});

test('OAuth runs after Origin and before the shared rate limiter', async () => {
  const fixture = await compatAuthFixture();
  const steps: string[] = [];
  const oauthVerifier = {
    async verify(input: { readonly authorization: string | readonly string[] | undefined }) {
      steps.push('oauth');
      return fixture.verifier.verify(input);
    },
  };
  const inner = createMemoryMcpRateLimiter({
    request: { maxRequests: 8, windowMs: 60_000 },
    now: () => 1_000,
  });
  const requestRateLimiter = {
    consume: async (subject: Parameters<typeof inner.consume>[0]) => {
      steps.push('rate');
      return inner.consume(subject);
    },
    close: () => inner.close(),
    readiness: () => inner.readiness(),
  };
  const server = track(startCompatApp({
    mcpReadTransport: { oauthVerifier, requestRateLimiter },
    mcpRateLimiter: requestRateLimiter,
  }));
  const ok = await injectCompatPost(server.app, compatRpc('tools/list'), {
    origin: 'https://app.example.test',
    authorization: `Bearer ${fixture.token}`,
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(steps, ['oauth', 'rate']);

  steps.length = 0;
  const csrf = await injectCompatPost(server.app, compatRpc('tools/list'), {
    origin: 'https://attacker.example.test',
    authorization: `Bearer ${fixture.token}`,
  });
  assert.equal(csrf.statusCode, 403);
  assert.deepEqual(steps, []);
});

test('production route drops uniquely canaried signed bearer from Fastify, Node, and SDK Request headers', async () => {
  const { token, verifierInputs, recordingVerifier } = await mintProductionCompatCanaryAuth();
  const facadeTaint: string[] = [];
  const capture = createCompatPingCapture();
  const server = track(startCompatApp({
    mcpReadTransport: {
      oauthVerifier: recordingVerifier,
      applicationFacade: withFacadeTaintCapture(pingMcpApplicationFacade(capture), facadeTaint),
    },
  }));
  const response = await injectCompatPost(server.app, compatRpc('tools/list'), {
    authorization: `Bearer ${token}`,
  });
  assert.equal(response.statusCode, 200);
  assert.ok(capture.listCalls >= 1);
  assertProductionCompatBearerDropped({
    canary: token,
    verifierInputs,
    server,
    facadeTaint,
    response,
  });
});
