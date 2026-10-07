import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { describe, test } from 'vitest';
import {
  createMemorySyncAdmissionPolicy,
  type SyncAdmissionPolicy,
} from '../../../src/infrastructure/rate-limit/index.js';
import { SyncEffectPageReadError } from '../../../src/modules/sync/index.js';
import {
  registerSyncEffectPageRoutes,
  type SyncEffectPageRouteDependencies,
} from '../../../src/transport/colp-sync/sync-effect-page-routes.js';

const routeUrl = new URL('../../../src/transport/colp-sync/sync-effect-page-routes.ts', import.meta.url);
const readerUrl = new URL('../../../src/infrastructure/sync/sync-effect-page-postgres.ts', import.meta.url);
const pullReaderUrls = [
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts', import.meta.url),
  new URL('../../../src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts', import.meta.url),
];
const appUrl = new URL('../../../src/transport/app.ts', import.meta.url);
const manifestUrl = new URL('../../../src/modules/publication/application/manifest-candidate.ts', import.meta.url);

test('P3-32B exposes effect pages only through private session and replica authorization', async () => {
  const [route, reader, pullReader, app, manifest] = await Promise.all([
    readFile(routeUrl, 'utf8'), readFile(readerUrl, 'utf8'),
    Promise.all(pullReaderUrls.map((url) => readFile(url, 'utf8'))).then((parts) => parts.join('\n')),
    readFile(appUrl, 'utf8'), readFile(manifestUrl, 'utf8'),
  ]);
  for (const fragment of [
    'Cache-Control', 'private, no-store', 'sessionId', 'replicaId', 'collectionId',
    'effectId', 'pageNumber', 'authentication_required', 'resource_not_found',
    'origin_not_allowed', 'WWW-Authenticate', 'invalid_cursor_scope',
    'known-sync-session', 'createPublicationProblemDescriptor',
  ]) assert.match(route, new RegExp(fragment, 'iu'), fragment);
  for (const fragment of ['assertTransactionalPullAuthority', "authority.protocolVersion !== '0.2'",
    'effect_id', 'collection_id']) {
    assert.match(reader, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), fragment);
  }
  for (const fragment of ['sync:pull', 'session.policy_revision', 'session.lifecycle_revision',
    'session.lease_generation', 'session.account_security_epoch', 'credential.security_epoch']) {
    assert.match(pullReader, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), fragment);
  }
  assert.doesNotMatch(route, /access_token|api[_-]?key|password|secret/iu);
  assert.match(app, /syncEffectPageRoutes/u);
  assert.match(manifest, /syncEffectPages/u);
  assert.match(manifest, /protocolVersions:[\s\S]*syncEffectPages[\s\S]*\['0\.1', '0\.2'\]/u);
  const compose = await readFile(new URL('../../../../devops/docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /SYNC_EFFECT_PAGE_RATE_LIMIT_EFFECT_MAX:.*:-24\}/u);
  const configSync = await readFile(new URL('../../../src/bootstrap/config-sync.ts', import.meta.url), 'utf8');
  assert.match(configSync, /SYNC_EFFECT_PAGE_RATE_LIMIT_EFFECT_MAX[\s\S]{0,80}min: 20/u);
});

const path = '/private/effects/{effectId}/{pageNumber}';
const query = '?sessionId=session-a&collectionId=collection-a&replicaId=replica-a';
const headers = { origin: 'chrome-extension://known', authorization: 'Bearer page-secret',
  'known-sync-session': 'session-a' };
const credential = { credentialId: 'credential-a' } as never;
const page = { effectId: 'effect-a', pageNumber: 1, pageCount: 1, memberCount: 1,
  members: ['node-a'], previousPageDigest: null, pageDigest: 'digest-a' } as never;

function app(options: { budget?: number; allowInsecureLoopback?: boolean;
    rateLimit?: SyncEffectPageRouteDependencies['rateLimit'];
    admission?: SyncAdmissionPolicy;
    read?: (input: Record<string, unknown>) => Promise<never> } = {}) {
    const server = Fastify({ logger: false });
    registerSyncEffectPageRoutes(server, {
      pathTemplate: path, allowedOrigins: ['chrome-extension://known'],
      allowInsecureLoopback: options.allowInsecureLoopback ?? true,
      responseBudgetBytes: options.budget ?? 16_384,
      rateLimit: options.rateLimit ?? { subjectMaxRequests: 1_000, effectMaxRequests: 1_000,
        ipMaxRequests: 1_000, windowMs: 60_000 },
      ...(options.admission === undefined ? {} : { admission: options.admission }),
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== headers.authorization) throw new Error('bad credential');
        return credential;
      } },
      reader: { read: options.read ?? (async () => page) },
    });
    return server;
  }

describe('P3-32B effect-page HTTP boundary', () => {
  test('returns one private page from Session header authority without query identity', async () => {
    let received: Record<string, unknown> | undefined;
    const server = app({ read: async (input) => { received = input; return page; } });
    const response = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.json(), page);
    assert.deepEqual(received, { credential, origin: headers.origin, sessionId: 'session-a', effectId: 'effect-a', pageNumber: 1 });
    await server.close();
  });

  test('accepts a one-version legacy query only when it repeats the Session identity', async () => {
    let received: Record<string, unknown> | undefined;
    const server = app({ read: async (input) => { received = input; return page; } });
    const matching = await server.inject({ method: 'GET', url: `/private/effects/effect-a/1${query}`, headers });
    assert.equal(matching.statusCode, 200);
    assert.deepEqual(received, { credential, origin: headers.origin, sessionId: 'session-a', collectionId: 'collection-a',
      replicaId: 'replica-a', effectId: 'effect-a', pageNumber: 1 });

    const mismatched = await server.inject({ method: 'GET', url:
      '/private/effects/effect-a/1?sessionId=session-other&collectionId=collection-a&replicaId=replica-a', headers });
    assert.equal(mismatched.statusCode, 404);
    assert.equal((mismatched.json() as { code: string }).code, 'resource_not_found');
    await server.close();
  });

  test('fails closed for transport, origin, authentication, query shape and byte budget without leaks', async () => {
    const secret = headers.authorization;
    const cases = [
      { server: app({ allowInsecureLoopback: false }), headers, status: 401 },
      { server: app(), headers: { ...headers, origin: 'https://wrong.example' }, status: 403 },
      { server: app(), headers: { origin: headers.origin }, status: 401 },
      { server: app(), headers, suffix: `${query}&extra=true`, status: 404 },
      { server: app({ budget: 1 }), headers, status: 413 },
      { server: app({ read: async () => { throw new SyncEffectPageReadError('integrity_failure'); } }),
        headers, status: 500 },
    ];
    for (const item of cases) {
      const response = await item.server.inject({ method: 'GET',
        url: `/private/effects/effect-a/1${item.suffix ?? query}`, headers: item.headers });
      assert.equal(response.statusCode, item.status);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.body.includes(secret), false);
      if (item.status === 401) assert.equal(response.headers['www-authenticate'], 'Bearer');
      await item.server.close();
    }
  });

  test('404 denials carry the full canonical resource-not-found Problem document without leaking request context', async () => {
    const server = app();
    const response = await server.inject({ method: 'GET',
      url: `/private/effects/effect-a/1${query}&extra=true`, headers });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.match(String(response.headers['content-type']), /^application\/problem\+json/u);
    const problem = response.json() as { type: string; code: string; title: string;
      status: number; retryable: boolean };
    assert.equal(problem.code, 'resource_not_found');
    assert.equal(problem.status, 404);
    assert.equal(problem.type, 'https://know-n.com/colp/problems/resource-not-found');
    assert.equal(problem.title, 'resource_not_found');
    assert.equal(problem.retryable, false);
    assert.deepEqual(Object.keys(problem).sort(), ['code', 'retryable', 'status', 'title', 'type']);
    assert.equal(response.body.includes('extra=true'), false);
    assert.equal(response.body.includes(headers.origin), false);
    assert.equal(response.headers['www-authenticate'], undefined);
    await server.close();
  });

  test('denies missing and disallowed origins with the sibling 403 origin_not_allowed Problem', async () => {
    const server = app();
    const wrong = await server.inject({ method: 'GET',
      url: `/private/effects/effect-a/1${query}`, headers: { ...headers, origin: 'https://wrong.example' } });
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.headers['cache-control'], 'private, no-store');
    assert.equal(wrong.headers['www-authenticate'], undefined);
    assert.match(String(wrong.headers['content-type']), /^application\/problem\+json/u);
    const wrongProblem = wrong.json() as { type: string; code: string; title: string;
      status: number; retryable: boolean };
    assert.equal(wrongProblem.code, 'origin_not_allowed');
    assert.equal(wrongProblem.status, 403);
    assert.equal(wrongProblem.type, 'https://know-n.com/colp/problems/origin-not-allowed');
    assert.equal(wrongProblem.title, 'origin_not_allowed');
    assert.equal(wrongProblem.retryable, false);
    assert.equal(wrong.body.includes('wrong.example'), false);

    const missing = await server.inject({ method: 'GET',
      url: `/private/effects/effect-a/1${query}`, headers: { authorization: headers.authorization } });
    assert.equal(missing.statusCode, 403);
    assert.equal((missing.json() as { code: string }).code, 'origin_not_allowed');
    assert.equal(missing.headers['www-authenticate'], undefined);
    await server.close();
  });

  test('challenges unauthenticated requests with WWW-Authenticate: Bearer and the full Problem document', async () => {
    const server = app();
    const response = await server.inject({ method: 'GET',
      url: `/private/effects/effect-a/1${query}`, headers: { origin: headers.origin } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.match(String(response.headers['content-type']), /^application\/problem\+json/u);
    const problem = response.json() as { type: string; code: string; title: string;
      status: number; retryable: boolean };
    assert.equal(problem.code, 'authentication_required');
    assert.equal(problem.status, 401);
    assert.equal(problem.retryable, false);
    assert.equal(response.body.includes(headers.authorization), false);
    await server.close();
  });

  test('requires Known-Sync-Session and conceals a missing or mismatched header', async () => {
    const server = app();
    const matching = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(matching.statusCode, 200);
    assert.deepEqual(matching.json(), page);

    const { 'known-sync-session': _session, ...withoutSession } = headers;
    const absent = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: withoutSession });
    assert.equal(absent.statusCode, 404);
    assert.equal((absent.json() as { code: string }).code, 'resource_not_found');

    const mismatched = await server.inject({ method: 'GET', url: `/private/effects/effect-a/1${query}`,
      headers: { ...headers, 'known-sync-session': 'session-other' } });
    assert.equal(mismatched.statusCode, 404);
    assert.equal(mismatched.headers['cache-control'], 'private, no-store');
    assert.equal((mismatched.json() as { code: string }).code, 'resource_not_found');
    assert.equal(mismatched.body.includes('session-other'), false);

    const malformed = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: { ...headers, 'known-sync-session': 'a,b' } });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { code: string }).code, 'invalid_query');
    await server.close();
  });
});

describe('FIX-M-013 effect-page request rate limiting', () => {
  test('over-limit requests return a unified 429 before the reader', async () => {
    const admission = createMemorySyncAdmissionPolicy({
      budgets: { 'effect-page': { maxRequests: 2, windowMs: 60_000 } },
    });
    let readerCalls = 0;
    const server = app({ rateLimit: { subjectMaxRequests: 2, effectMaxRequests: 10,
      ipMaxRequests: 100, windowMs: 60_000 },
    admission, read: async () => { readerCalls += 1; return page; } });
    const url = (pageNumber: number) => `/private/effects/effect-a/${pageNumber}`;
    const first = await server.inject({ method: 'GET', url: url(1), headers });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    assert.match(String(first.headers['ratelimit-policy']), /sync-effect-page/u);
    assert.equal(await server.inject({ method: 'GET', url: url(2), headers }).then((r) => r.statusCode), 200);
    const third = await server.inject({ method: 'GET', url: url(3), headers });
    assert.equal(third.statusCode, 429);
    assert.equal(third.headers['cache-control'], 'private, no-store');
    assert.match(String(third.headers['content-type']), /^application\/problem\+json/u);
    assert.ok(Number(third.headers['retry-after']) >= 1);
    assert.match(String(third.headers['ratelimit-policy']), /sync-effect-page/u);
    assert.equal((third.json() as { code: string; status: number }).code, 'rate_limited');
    assert.equal((third.json() as { status: number }).status, 429);
    const before = readerCalls;
    const fourth = await server.inject({ method: 'GET', url: url(4), headers });
    assert.equal(fourth.statusCode, 429);
    assert.equal(readerCalls, before, 'over-limit requests must not reach the reader');
    await server.close();
  });

  test('429 bodies carry the full canonical Problem document with retryAfterSeconds recovery', async () => {
    const admission = createMemorySyncAdmissionPolicy({
      budgets: { 'effect-page': { maxRequests: 1, windowMs: 60_000 } },
    });
    const server = app({ rateLimit: { subjectMaxRequests: 1, effectMaxRequests: 10,
      ipMaxRequests: 100, windowMs: 60_000 }, admission });
    const first = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(first.statusCode, 200);
    const denied = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.headers['www-authenticate'], undefined);
    const problem = denied.json() as { type: string; code: string; title: string; status: number;
      retryable: boolean; retryAfterSeconds?: number };
    assert.equal(problem.code, 'rate_limited');
    assert.equal(problem.status, 429);
    assert.equal(problem.retryable, true);
    assert.equal(problem.retryAfterSeconds, Number(denied.headers['retry-after']));
    assert.ok(Number(denied.headers['retry-after']) >= 1);
    await server.close();
  });

  test('subject admission is shared across effect traversals', async () => {
    const admission = createMemorySyncAdmissionPolicy({
      budgets: { 'effect-page': { maxRequests: 1, windowMs: 60_000 } },
    });
    const server = app({ rateLimit: { subjectMaxRequests: 10, effectMaxRequests: 1,
      ipMaxRequests: 100, windowMs: 60_000 }, admission });
    const first = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(first.statusCode, 200);
    const second = await server.inject({ method: 'GET', url: '/private/effects/effect-a/2', headers });
    assert.equal(second.statusCode, 429);
    assert.equal((second.json() as { code: string }).code, 'rate_limited');
    await server.close();
  });

  test('session rotation does not replenish the verified-principal subject budget', async () => {
    const subjects = new Set<string>();
    const admission: SyncAdmissionPolicy = {
      admitPreAuth: async () => ({ kind: 'allowed', retryAfterSeconds: 0 }),
      admitSubject: async ({ subjectKey }) => {
        if (subjects.has(subjectKey)) return { kind: 'denied', retryAfterSeconds: 60 };
        subjects.add(subjectKey); return { kind: 'allowed', retryAfterSeconds: 0 };
      },
      readiness: () => ({ status: 'healthy', reason: 'none' }), close: async () => undefined,
    };
    const server = app({ rateLimit: { subjectMaxRequests: 1, effectMaxRequests: 10,
      ipMaxRequests: 100, windowMs: 60_000 }, admission });
    const first = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(first.statusCode, 200);
    const second = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(second.statusCode, 429);
    const other = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: { ...headers, 'known-sync-session': 'session-b' } });
    assert.equal(other.statusCode, 429);
    assert.equal(subjects.size, 1);
    await server.close();
  });

  test('a low-cost trusted-client IP budget bounds error and unauthorized requests and ignores forged XFF', async () => {
    const server = app({ rateLimit: { subjectMaxRequests: 100, effectMaxRequests: 100,
      ipMaxRequests: 2, windowMs: 60_000 } });
    const unauthenticated = { origin: headers.origin };
    const first = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: unauthenticated });
    assert.equal(first.statusCode, 401);
    const second = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: unauthenticated });
    assert.equal(second.statusCode, 401);
    // Unauthenticated requests consume the cheap IP budget, so admission fails
    // closed before any credential or database work on the third request.
    const third = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: unauthenticated });
    assert.equal(third.statusCode, 429);
    assert.equal((third.json() as { code: string }).code, 'rate_limited');
    assert.ok(Number(third.headers['retry-after']) >= 1);
    // A forged X-Forwarded-For must not mint a fresh bucket (no trustProxy).
    const forged = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers: { ...headers, 'x-forwarded-for': '198.51.100.99' } });
    assert.equal(forged.statusCode, 429);
    // A different trusted (loopback) socket address owns a separate IP budget.
    const other = await server.inject({ method: 'GET', url: '/private/effects/effect-a/1',
      headers, remoteAddress: '::1' });
    assert.equal(other.statusCode, 200);
    await server.close();
  });

  test('an injected shared admission policy maps denied/failure correctly', async () => {
    const denying: SyncAdmissionPolicy = {
      admitPreAuth: async () => ({ kind: 'allowed', retryAfterSeconds: 0 }),
      admitSubject: async () => ({ kind: 'denied', retryAfterSeconds: 37 }),
      readiness: () => ({ status: 'healthy', reason: 'none' }), close: async () => undefined,
    };
    const deniedServer = app({ admission: denying });
    const denied = await deniedServer.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.headers['retry-after'], '37');
    assert.match(String(denied.headers['ratelimit-policy']), /sync-effect-page/u);
    assert.equal((denied.json() as { code: string }).code, 'rate_limited');
    assert.equal(denied.headers['cache-control'], 'private, no-store');
    await deniedServer.close();

    const failing: SyncAdmissionPolicy = {
      admitPreAuth: async () => ({ kind: 'allowed', retryAfterSeconds: 0 }),
      admitSubject: async () => ({ kind: 'failed', reason: 'limiter_unavailable' }),
      readiness: () => ({ status: 'degraded', reason: 'last_command_failed' }), close: async () => undefined,
    };
    const failedServer = app({ admission: failing });
    const failed = await failedServer.inject({ method: 'GET', url: '/private/effects/effect-a/1', headers });
    assert.equal(failed.statusCode, 503);
    assert.equal((failed.json() as { code: string }).code, 'service_unavailable');
    assert.equal(failed.headers['retry-after'], undefined, 'a 503 never fabricates a quota fact');
    assert.equal(failed.headers['ratelimit-policy'], undefined, 'a 503 never fabricates a quota policy');
    assert.equal(failed.headers['cache-control'], 'private, no-store');
    await failedServer.close();
  });
});
