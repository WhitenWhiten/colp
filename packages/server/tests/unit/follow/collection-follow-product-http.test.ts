import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import { generateOpaqueId, type IdentityPorts, type IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  CollectionFollowCommandError,
  FollowedCollectionsCursorError,
  type CollectionFollowCommandPorts,
  type CollectionFollowCombinedQueryPorts,
} from '../../../src/modules/social/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerCollectionFollowRoutes } from '../../../src/transport/product/collection-follow-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';

const ACTOR = 'EREREREREREREREREREREQ';
const COLLECTION = 'IiIiIiIiIiIiIiIiIiIiIg';
const OWNER_MESSAGE = 'A Collection owner cannot follow their own collection.';
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

function app(input: {
  enabled?: boolean;
  rate?: number;
  timeoutMs?: number;
  command?: Parameters<typeof registerCollectionFollowRoutes>[1]['command'];
  query?: () => Promise<{ following: boolean; followerCount: number; followedAt: Date | null } | null>;
  listQuery?: () => Promise<{
    items: readonly {
      collectionId: string; slug: string; title: string; summary: string | null;
      kind: 'bookmarks'; owner: { profileId: string; handle: string; displayName: string; avatarUrl: string | null };
      updatedAt: Date; followedAt: Date; availability: 'available' | 'unavailable';
    }[];
    nextCursor: string | null;
  }>;
  queryExecute?: <Result>(
    work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Result>;
} = {}) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductRouteManifestChecks(server, { requireComplete: false });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductHttpError) return sendProductError(request, reply, error);
    return sendProductError(request, reply, new ProductHttpError({
      statusCode: 500, code: 'internal_error', message: 'Internal error.',
    }));
  });
  registerCollectionFollowRoutes(server, {
    enabled: input.enabled ?? true, allowedOrigins: ['https://app.example.test'], identityUnitOfWork,
    csrfMatches: (raw) => raw === 'csrf',
    commandUnitOfWork: { execute: <Result>(work: (ports: CollectionFollowCommandPorts) => Promise<Result>) =>
      work({} as CollectionFollowCommandPorts) },
    queryUnitOfWork: {
      execute: input.queryExecute ?? (<Result>(work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>) =>
        work({} as CollectionFollowCombinedQueryPorts)),
    },
    command: input.command ?? (async (_ports, value) => ({
      kind: 'succeeded',
      state: {
        following: value.action === 'follow',
        followerCount: value.action === 'follow' ? 1 : 0,
        followedAt: value.action === 'follow' ? new Date(0) : null,
      },
    })),
    query: async () => input.query ? input.query() : ({
      following: true, followerCount: 2, followedAt: new Date(0),
    }),
    listQuery: input.listQuery ?? (async () => ({ items: [], nextCursor: null })),
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
    timeoutMs: input.timeoutMs ?? 100,
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const mutation = (extra: Record<string, string> = {}) => ({ ...auth, origin: 'https://app.example.test',
  'x-csrf-token': 'csrf', 'known-command-id': randomUUID(), ...extra });
const path = (collectionId = COLLECTION) => `/api/v1/collections/${collectionId}/follow`;
const LIST = '/api/v1/me/followed-collections';

test('anonymous requests are 401 even when the flag is off', async () => {
  const server = app({ enabled: false });
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const response = await server.inject({ method, url: path() });
    assert.equal(response.statusCode, 401, method);
    assert.equal(response.json().error.code, 'authentication_required', method);
    assert.doesNotMatch(response.body, /feature_temporarily_unavailable/u);
  }
  await server.close();
});

test('flag off after authentication is 404 without feature_temporarily_unavailable', async () => {
  const server = app({ enabled: false });
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const response = await server.inject({
      method, url: path(), headers: method === 'GET' ? auth : mutation(),
    });
    assert.equal(response.statusCode, 404, method);
    assert.equal(response.json().error.code, 'resource_not_found', method);
    assert.doesNotMatch(response.body, /feature_temporarily_unavailable/u);
  }
  await server.close();
});

test('PUT and DELETE forward command-receipt kinds through sendProductCommandReceiptOutcome', async () => {
  const replayBody = Buffer.from(
    '{"following":true,"followerCount":9,"followedAt":"2026-08-26T00:00:00.000Z"}',
  );
  const cases = [
    {
      outcome: {
        kind: 'replay' as const,
        status: 200,
        body: replayBody,
        stableHeaders: { 'cache-control': 'private, no-store' },
        mediaType: 'application/json',
        contractVersion: '1.0.0',
      },
      status: 200,
      code: null,
      cacheControl: 'private, no-store',
      retryAfter: undefined,
      body: replayBody.toString(),
    },
    {
      outcome: { kind: 'reused' as const },
      status: 409,
      code: 'command_id_reused',
      cacheControl: undefined,
      retryAfter: undefined,
      body: null,
    },
    {
      outcome: { kind: 'in_progress' as const, retryAfterSeconds: 2 },
      status: 409,
      code: 'command_in_progress',
      cacheControl: undefined,
      retryAfter: '2',
      body: null,
    },
  ] as const;
  for (const method of ['PUT', 'DELETE'] as const) {
    for (const testCase of cases) {
      const server = app({ command: async () => testCase.outcome });
      const response = await server.inject({ method, url: path(), headers: mutation() });
      assert.equal(response.statusCode, testCase.status, `${method} ${testCase.outcome.kind}`);
      if (testCase.body !== null) {
        assert.equal(response.body, testCase.body, `${method} replay body`);
        assert.equal(response.headers['cache-control'], testCase.cacheControl, `${method} replay`);
      } else {
        assert.equal(response.json().error.code, testCase.code, `${method} ${testCase.outcome.kind}`);
      }
      if (testCase.retryAfter !== undefined) {
        assert.equal(response.headers['retry-after'], testCase.retryAfter, `${method} in_progress`);
      }
      await server.close();
    }
  }
});

test('PUT/DELETE require session Origin CSRF and command id; success is private no-store', async () => {
  const server = app();
  assert.equal((await server.inject({ method: 'PUT', url: path() })).statusCode, 401);
  assert.equal((await server.inject({ method: 'PUT', url: path(), headers: auth })).statusCode, 403);
  const ok = await server.inject({ method: 'PUT', url: path(), headers: mutation() });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.deepEqual(ok.json(), { following: true, followerCount: 1, followedAt: '1970-01-01T00:00:00.000Z' });
  const gone = await server.inject({ method: 'DELETE', url: path(), headers: mutation() });
  assert.equal(gone.statusCode, 200);
  assert.deepEqual(gone.json(), { following: false, followerCount: 0, followedAt: null });
  const body = await server.inject({ method: 'PUT', url: path(),
    headers: mutation({ 'content-type': 'application/json' }), payload: '{}' });
  assert.equal(body.statusCode, 413);
  await server.close();
});

test('GET requires a session, returns CollectionFollowState, and has no HEAD twin', async () => {
  const server = app();
  assert.equal((await server.inject({ method: 'GET', url: path() })).statusCode, 401);
  const get = await server.inject({ method: 'GET', url: path(), headers: auth });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers['cache-control'], 'private, no-store');
  assert.deepEqual(get.json(), { following: true, followerCount: 2, followedAt: '1970-01-01T00:00:00.000Z' });
  const routes = server.printRoutes();
  assert.match(routes, /\/follow \(PUT, DELETE, GET\)/u);
  assert.doesNotMatch(routes, /\/follow \([^)]*HEAD/u);
  const head = await server.inject({ method: 'HEAD', url: path(), headers: auth });
  assert.equal(head.statusCode, 404);
  await server.close();
});

test('owner self-follow preserves the locked invalid_request message', async () => {
  const server = app({
    command: async () => { throw new CollectionFollowCommandError('invalid_request', OWNER_MESSAGE); },
  });
  const response = await server.inject({ method: 'PUT', url: path(), headers: mutation() });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_request');
  assert.equal(response.json().error.message, OWNER_MESSAGE);
  await server.close();
});

test('invisible GET is resource_not_found and rate limits use the collection-follow bucket', async () => {
  const hidden = app({ query: async () => null });
  const response = await hidden.inject({ method: 'GET', url: path(), headers: auth });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /hidden|private@example/iu);
  await hidden.close();

  const limited = app({ rate: 1 });
  assert.equal((await limited.inject({ method: 'GET', url: path(), headers: auth })).statusCode, 200);
  const rate = await limited.inject({ method: 'GET', url: path(), headers: auth });
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.json().error.code, 'rate_limited');
  await limited.close();
});

test('production OpaqueId collection identities are accepted', async () => {
  const server = app();
  const collectionId = generateOpaqueId();
  const accepted = await server.inject({ method: 'PUT', url: path(collectionId), headers: mutation() });
  assert.equal(accepted.statusCode, 200);
  await server.close();
});

test('list anonymous requests are 401 even when the flag is off', async () => {
  const server = app({ enabled: false });
  const response = await server.inject({ method: 'GET', url: LIST });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'authentication_required');
  assert.doesNotMatch(response.body, /feature_temporarily_unavailable/u);
  await server.close();
});

test('list flag off after authentication is 404 without feature_temporarily_unavailable', async () => {
  const server = app({ enabled: false });
  const response = await server.inject({ method: 'GET', url: LIST, headers: auth });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /feature_temporarily_unavailable/u);
  await server.close();
});

test('list empty page is 200 with items [] and nextCursor null; HEAD is absent', async () => {
  const server = app();
  const get = await server.inject({ method: 'GET', url: LIST, headers: auth });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers['cache-control'], 'private, no-store');
  assert.deepEqual(get.json(), { items: [], nextCursor: null });
  assert.equal(JSON.stringify(get.json()).includes('followerCount'), false);
  const routes = server.printRoutes();
  assert.match(routes, /me\/followed-collections \(GET\)/u);
  assert.doesNotMatch(routes, /followed-collections \([^)]*HEAD/u);
  const head = await server.inject({ method: 'HEAD', url: LIST, headers: auth });
  assert.equal(head.statusCode, 404);
  await server.close();
});

test('list returns FollowedCollectionItem fields with availability and rejects cursor-plus-limit', async () => {
  const server = app({
    listQuery: async () => ({
      items: [{
        collectionId: COLLECTION, slug: 'followed-notes', title: 'Followed notes', summary: 'Kept notes',
        kind: 'bookmarks',
        owner: { profileId: ACTOR, handle: 'alice', displayName: 'Alice', avatarUrl: null },
        updatedAt: new Date(0), followedAt: new Date(0), availability: 'available',
      }, {
        collectionId: 'M2NkNGU1ZjZhN2I4YzlkMG', slug: 'went-private', title: 'Went private', summary: null,
        kind: 'bookmarks',
        owner: { profileId: ACTOR, handle: 'alice', displayName: 'Alice', avatarUrl: null },
        updatedAt: new Date(0), followedAt: new Date(0), availability: 'unavailable',
      }],
      nextCursor: null,
    }),
  });
  const get = await server.inject({ method: 'GET', url: LIST, headers: auth });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json(), {
    items: [{
      collectionId: COLLECTION, slug: 'followed-notes', title: 'Followed notes', summary: 'Kept notes',
      kind: 'bookmarks',
      owner: { profileId: ACTOR, handle: 'alice', displayName: 'Alice', avatarUrl: null },
      updatedAt: '1970-01-01T00:00:00.000Z', followedAt: '1970-01-01T00:00:00.000Z',
      availability: 'available',
    }, {
      collectionId: 'M2NkNGU1ZjZhN2I4YzlkMG', slug: 'went-private', title: 'Went private', summary: null,
      kind: 'bookmarks',
      owner: { profileId: ACTOR, handle: 'alice', displayName: 'Alice', avatarUrl: null },
      updatedAt: '1970-01-01T00:00:00.000Z', followedAt: '1970-01-01T00:00:00.000Z',
      availability: 'unavailable',
    }],
    nextCursor: null,
  });
  const both = await server.inject({ method: 'GET', url: `${LIST}?cursor=abc&limit=10`, headers: auth });
  assert.equal(both.statusCode, 400);
  assert.equal(both.json().error.code, 'invalid_request');
  await server.close();
});

test('list swapped-principal cursor is invalid_cursor and shares the collection-follow limiter', async () => {
  const rejected = app({
    listQuery: async () => { throw new FollowedCollectionsCursorError(); },
  });
  const response = await rejected.inject({
    method: 'GET', url: `${LIST}?cursor=not-a-real-cursor`, headers: auth,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_cursor');
  await rejected.close();

  const limited = app({ rate: 1 });
  assert.equal((await limited.inject({ method: 'GET', url: LIST, headers: auth })).statusCode, 200);
  const rate = await limited.inject({ method: 'GET', url: LIST, headers: auth });
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.json().error.code, 'rate_limited');
  await limited.close();
});

function hangOnAbort(received: { signal?: AbortSignal }) {
  return <Result>(
    _work: (ports: CollectionFollowCombinedQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result> => {
    received.signal = options?.signal;
    return new Promise<never>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

test('GET follow state timeout aborts the query unit of work so PostgreSQL can cancel', async () => {
  const received: { signal?: AbortSignal } = {};
  const server = app({ timeoutMs: 40, queryExecute: hangOnAbort(received) });
  const response = await server.inject({ method: 'GET', url: path(), headers: auth });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.ok(received.signal);
  assert.equal(received.signal.aborted, true);
  await server.close();
});

test('GET followed-collections timeout aborts the query unit of work so PostgreSQL can cancel', async () => {
  const received: { signal?: AbortSignal } = {};
  const server = app({ timeoutMs: 40, queryExecute: hangOnAbort(received) });
  const response = await server.inject({ method: 'GET', url: LIST, headers: auth });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.ok(received.signal);
  assert.equal(received.signal.aborted, true);
  await server.close();
});
