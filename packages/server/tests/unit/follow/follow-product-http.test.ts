import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import { generateOpaqueId, type IdentityPorts, type IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import type { FollowCommandPorts, FollowQueryPage, FollowQueryPorts } from '../../../src/modules/social/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerFollowRoutes } from '../../../src/transport/product/follow-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';

const ACTOR = 'EREREREREREREREREREREQ';
const TARGET = 'IiIiIiIiIiIiIiIiIiIiIg';
const HIDDEN = 'MzMzMzMzMzMzMzMzMzMzMw';
const actor = { account: { id: ACTOR, subjectId: 'actor-subject' },
  session: { csrfTokenHash: 'csrf-hash' } };
const fakeIdentityPorts = { sessions: {
  findByTokenHash: async () => ({ id: 'session', accountId: ACTOR, tokenHash: 'x',
    csrfTokenHash: 'csrf-hash', securityEpoch: 1n, createdAt: new Date(), lastSeenAt: new Date(),
    idleExpiresAt: new Date(Date.now() + 10_000), absoluteExpiresAt: new Date(Date.now() + 10_000),
    revokedAt: null, rotatedFromSessionId: null }), touch: async () => true },
  accounts: { findById: async () => ({ id: actor.account.id, subjectId: actor.account.subjectId,
    email: 'private@example.test', status: 'active', securityEpoch: 1n, createdAt: new Date(), deletedAt: null }) },
  clock: { now: async () => new Date() } } as unknown as IdentityPorts;
const identityUnitOfWork: IdentityUnitOfWork = {
  execute: <Result>(work: (ports: IdentityPorts) => Promise<Result>) => work(fakeIdentityPorts),
};

function app(input: { enabled?: boolean; rate?: number; query?: () => Promise<FollowQueryPage | null> } = {}) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductRouteManifestChecks(server, { requireComplete: false });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductHttpError) return sendProductError(request, reply, error);
    return sendProductError(request, reply, new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'Internal error.' }));
  });
  registerFollowRoutes(server, {
    enabled: input.enabled ?? true, allowedOrigins: ['https://app.example.test'], identityUnitOfWork,
    csrfMatches: (raw) => raw === 'csrf',
    commandUnitOfWork: { execute: <Result>(work: (ports: FollowCommandPorts) => Promise<Result>) =>
      work({} as FollowCommandPorts) },
    queryUnitOfWork: { execute: <Result>(work: (ports: FollowQueryPorts) => Promise<Result>) =>
      work({} as FollowQueryPorts) },
    command: async (_ports, value) => ({ kind: 'succeeded', relation: { actorProfileId: ACTOR,
      targetProfileId: value.targetProfileId, following: value.action === 'follow', changedAt: new Date(0) } }),
    query: async () => input.query ? input.query() : ({ items: [{ profileId: ACTOR, handle: 'safe',
      displayName: 'Safe', avatarUrl: null }], nextCursor: null }),
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
    timeoutMs: 100,
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const mutation = (extra: Record<string, string> = {}) => ({ ...auth, origin: 'https://app.example.test',
  'x-csrf-token': 'csrf', 'known-command-id': randomUUID(), ...extra });

test('Follow route flag is exposure-only and defaults closed', async () => {
  const server = app({ enabled: false });
  assert.equal((await server.inject({ method: 'GET', url: `/api/v1/profiles/${TARGET}/followers`, headers: auth })).statusCode, 404);
  await server.close();
});

test('Follow mutations enforce Session Origin CSRF command id media/body and exact replay mapping', async () => {
  const server = app();
  assert.equal((await server.inject({ method: 'PUT', url: `/api/v1/profiles/${TARGET}/follow` })).statusCode, 401);
  assert.equal((await server.inject({ method: 'PUT', url: `/api/v1/profiles/${TARGET}/follow`, headers: auth })).statusCode, 403);
  const ok = await server.inject({ method: 'PUT', url: `/api/v1/profiles/${TARGET}/follow`, headers: mutation() });
  assert.equal(ok.statusCode, 200); assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.deepEqual(ok.json(), { actorProfileId: ACTOR, targetProfileId: TARGET, following: true,
    changedAt: '1970-01-01T00:00:00.000Z' });
  const body = await server.inject({ method: 'PUT', url: `/api/v1/profiles/${TARGET}/follow`,
    headers: mutation({ 'content-type': 'application/json' }), payload: '{}' });
  assert.equal(body.statusCode, 413);
  for (const [name, values] of [
    ['cookie', [auth.cookie, auth.cookie]],
    ['origin', ['https://app.example.test', 'https://app.example.test']],
    ['x-csrf-token', ['csrf', 'csrf']],
    ['known-command-id', [randomUUID(), randomUUID()]],
  ] as const) {
    const headers: Record<string, string | readonly string[]> = mutation(); headers[name] = values;
    const duplicate = await server.inject({ method: 'PUT', url: `/api/v1/profiles/${TARGET}/follow`, headers });
    assert.equal(duplicate.statusCode, 400, name);
    assert.equal(duplicate.json().error.code, 'invalid_request', name);
  }
  await server.close();
});

test('Follow routes accept production Profile identity and reject invalid opaque path identities', async () => {
  const server = app();
  const productionProfileId = generateOpaqueId();
  const accepted = await server.inject({ method: 'PUT',
    url: `/api/v1/profiles/${productionProfileId}/follow`, headers: mutation() });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().targetProfileId, productionProfileId);

  const invalidSegments = [
    '%20',
    'A'.repeat(23),
    'AAAAAAAAAAAAAAAAAAAAAB',
    'AAAAAAAAAAAAAAAAAAAAA%3D',
    'opaque%2Fpath',
    'opaque%252Fpath',
  ];
  for (const segment of invalidSegments) {
    const response = await server.inject({ method: 'GET',
      url: `/api/v1/profiles/${segment}/followers`, headers: auth });
    assert.equal(response.statusCode, 400, segment);
    assert.equal(response.json().error.code, 'invalid_request', segment);
  }
  const empty = await server.inject({ method: 'GET',
    url: '/api/v1/profiles//followers', headers: auth });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error.code, 'invalid_request');
  await server.close();
});

test('Follow lists reject duplicate raw query, conceal targets, support explicit HEAD and rate limits', async () => {
  const server = app();
  const duplicate = await server.inject({ method: 'GET', url: `/api/v1/profiles/${TARGET}/followers?limit=1&limit=2`, headers: auth });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.json().error.code, 'invalid_request');
  const unknown = await server.inject({ method: 'GET', url: `/api/v1/profiles/${TARGET}/followers?private-marker=x`, headers: auth });
  assert.equal(unknown.statusCode, 400); assert.equal(unknown.json().error.code, 'invalid_request');
  const get = await server.inject({ method: 'GET', url: `/api/v1/profiles/${TARGET}/followers?limit=1`, headers: auth });
  assert.equal(get.statusCode, 200); assert.equal(get.headers['cache-control'], 'private, no-store');
  assert.doesNotMatch(get.body, /email|accountId|cookie|csrf/iu);
  const head = await server.inject({ method: 'HEAD', url: `/api/v1/profiles/${TARGET}/followers?limit=1`, headers: auth });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
  await server.close();

  const limited = app({ rate: 1 });
  assert.equal((await limited.inject({ method: 'GET', url: `/api/v1/profiles/${TARGET}/followers`, headers: auth })).statusCode, 200);
  const rate = await limited.inject({ method: 'HEAD', url: `/api/v1/profiles/${TARGET}/followers`, headers: auth });
  assert.equal(rate.statusCode, 429); assert.equal(rate.body, '');
  await limited.close();

  const hidden = app({ query: async () => null });
  const response = await hidden.inject({ method: 'GET', url: `/api/v1/profiles/${HIDDEN}/following`, headers: auth });
  assert.equal(response.statusCode, 404); assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /hidden|private@example/iu);
  await hidden.close();
});

test('Follow query timeout maps to a secret-safe unavailable Problem', async () => {
  const server = app({ query: () => new Promise(() => undefined) });
  const response = await server.inject({ method: 'GET', url: `/api/v1/profiles/${TARGET}/followers`, headers: auth });
  assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.doesNotMatch(response.body, /target|cursor|cookie|csrf/iu);
  await server.close();
});
