import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  COMMUNITY_STATIC_GENERATION,
  CommunityNotificationError,
  communityNotificationPreferenceEtag,
  type CommunityNotification,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationCommandResult,
  type CommunityNotificationQueryPorts,
} from '../../../src/modules/community/index.js';
import {
  createFixedWindowRateLimiter,
  type CommunityRateLimiters,
} from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerCommunityNotificationRoutes } from '../../../src/transport/product/community-notification-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { mapFrameworkError } from '../../../src/transport/app-error-mapping.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';

const ACCOUNT = 'account-viewer-1';
const HMAC_KEY = Buffer.alloc(32, 9);
const INBOX = '/api/v1/me/community-notifications';
const INBOX_READ = '/api/v1/me/community-notifications/read';
const PREFERENCES = '/api/v1/me/community-notification-preferences';
const NOW = '2026-10-05T12:00:00.000Z';

function notification(overrides: Partial<CommunityNotification> = {}): CommunityNotification {
  return {
    id: 'n-1',
    kind: 'comment_reply',
    commentId: 'comment-1',
    target: {
      kind: 'collection', id: 'col-1', collectionId: null, seriesId: null,
      generation: COMMUNITY_STATIC_GENERATION,
    },
    actor: { id: 'a-actor', handle: 'alice', displayName: 'Alice', avatarUrl: null },
    preview: 'a reply',
    href: 'https://known.example/c/col-1#comment-comment-1',
    read: false,
    createdAt: NOW,
    ...overrides,
  };
}

const actor = { account: { id: ACCOUNT, subjectId: 'viewer-subject' },
  session: { csrfTokenHash: 'csrf-hash' } };
const fakeIdentityPorts = { sessions: {
  findByTokenHash: async () => ({ id: 'session', accountId: ACCOUNT, tokenHash: 'x',
    csrfTokenHash: 'csrf-hash', securityEpoch: 1n, createdAt: new Date(), lastSeenAt: new Date(),
    idleExpiresAt: new Date(Date.now() + 10_000), absoluteExpiresAt: new Date(Date.now() + 10_000),
    revokedAt: null, rotatedFromSessionId: null }), touch: async () => true },
  accounts: { findById: async () => ({ id: actor.account.id, subjectId: actor.account.subjectId,
    email: 'private@example.test', status: 'active', securityEpoch: 1n, createdAt: new Date(), deletedAt: null }) },
  clock: { now: async () => new Date() } } as unknown as IdentityPorts;
const identityUnitOfWork: IdentityUnitOfWork = {
  execute: <Result>(work: (ports: IdentityPorts) => Promise<Result>) => work(fakeIdentityPorts),
};

function communityRateLimits(rate: number): CommunityRateLimiters {
  return {
    vote: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
    comment: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
    curation: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
    publicReads: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
  };
}

function app(input: {
  enabled?: boolean;
  rate?: number;
  listNotifications?: Parameters<typeof registerCommunityNotificationRoutes>[1]['listNotifications'];
  readNotifications?: Parameters<typeof registerCommunityNotificationRoutes>[1]['readNotifications'];
  getPreference?: Parameters<typeof registerCommunityNotificationRoutes>[1]['getPreference'];
  putPreference?: Parameters<typeof registerCommunityNotificationRoutes>[1]['putPreference'];
} = {}) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductRouteManifestChecks(server, { requireComplete: false });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductHttpError) return sendProductError(request, reply, error);
    return sendProductError(request, reply, mapFrameworkError(error));
  });
  registerCommunityNotificationRoutes(server, {
    enabled: input.enabled ?? true,
    allowedOrigins: ['https://app.example.test'],
    identityUnitOfWork,
    notificationQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityNotificationQueryPorts) => Promise<Result>) =>
        work({} as CommunityNotificationQueryPorts),
    },
    notificationCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityNotificationCommandPorts) => Promise<Result>) =>
        work({} as CommunityNotificationCommandPorts),
    },
    rateLimits: communityRateLimits(input.rate ?? 100),
    timeoutMs: 100,
    etagHmacKey: HMAC_KEY,
    csrfMatches: (raw) => raw === 'csrf',
    ...(input.listNotifications !== undefined ? { listNotifications: input.listNotifications } : {}),
    ...(input.readNotifications !== undefined ? { readNotifications: input.readNotifications } : {}),
    ...(input.getPreference !== undefined ? { getPreference: input.getPreference } : {}),
    ...(input.putPreference !== undefined ? { putPreference: input.putPreference } : {}),
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const mutation = (extra: Record<string, string> = {}) => ({ ...auth, origin: 'https://app.example.test',
  'x-csrf-token': 'csrf', 'known-command-id': randomUUID(), ...extra });
const json = { 'content-type': 'application/json' };

/* ——— GET /me/community-notifications ——— */

test('GET inbox requires a session and serves the closed page with private no-store', async () => {
  const server = app({
    listNotifications: async (_ports, input) => {
      assert.equal(input.viewer.accountId, ACCOUNT);
      assert.equal(input.viewer.subjectId, 'viewer-subject');
      return { items: [notification()], nextCursor: 'cur-2', unreadCount: 1 };
    },
  });
  const anonymous = await server.inject({ method: 'GET', url: INBOX });
  assert.equal(anonymous.statusCode, 401);
  const response = await server.inject({ method: 'GET', url: `${INBOX}?read=unread&limit=10`, headers: auth });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['items', 'nextCursor', 'unreadCount']);
  assert.equal(body.items[0].id, 'n-1');
  assert.equal(body.items[0].kind, 'comment_reply');
  assert.equal(body.nextCursor, 'cur-2');
  assert.equal(body.unreadCount, 1);
  await server.close();
});

test('GET inbox rejects unknown, duplicate, and malformed query keys', async () => {
  const server = app({
    listNotifications: async () => ({ items: [], nextCursor: null, unreadCount: 0 }),
  });
  for (const url of [
    `${INBOX}?extra=1`,
    `${INBOX}?read=all&read=unread`,
    `${INBOX}?read=bogus`,
    `${INBOX}?limit=0`,
    `${INBOX}?limit=101`,
    `${INBOX}?limit=2.5`,
    `${INBOX}?cursor=bad%20token`,
  ]) {
    const response = await server.inject({ method: 'GET', url, headers: auth });
    assert.equal(response.statusCode, 400, url);
    assert.match(response.json().error.code, /^invalid_(query|cursor)$/u, url);
  }
  await server.close();
});

test('GET inbox flag-off conceals as 404 after session proof', async () => {
  const server = app({ enabled: false });
  const response = await server.inject({ method: 'GET', url: INBOX, headers: auth });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  await server.close();
});

test('GET inbox maps domain errors to product codes', async () => {
  for (const [error, status, code] of [
    [new CommunityNotificationError('invalid_cursor', 'cursor'), 400, 'invalid_cursor'],
    [new CommunityNotificationError('resource_not_found', 'concealed'), 404, 'resource_not_found'],
  ] as const) {
    const server = app({ listNotifications: async () => { throw error; } });
    const response = await server.inject({ method: 'GET', url: INBOX, headers: auth });
    assert.equal(response.statusCode, status, code);
    assert.equal(response.json().error.code, code);
    await server.close();
  }
});

/* ——— POST /me/community-notifications/read ——— */

test('POST read requires session, Origin, CSRF, and a canonical command id', async () => {
  const server = app();
  assert.equal((await server.inject({ method: 'POST', url: INBOX_READ,
    headers: json, payload: JSON.stringify({ ids: ['n-1'] }) })).statusCode, 401);
  assert.equal((await server.inject({ method: 'POST', url: INBOX_READ,
    headers: { ...auth, ...json }, payload: JSON.stringify({ ids: ['n-1'] }) })).statusCode, 403);
  const noCommand = await server.inject({ method: 'POST', url: INBOX_READ,
    headers: { ...mutation(), ...json, 'known-command-id': '' },
    payload: JSON.stringify({ ids: ['n-1'] }) });
  assert.equal(noCommand.statusCode, 400);
  const badCommand = await server.inject({ method: 'POST', url: INBOX_READ,
    headers: { ...mutation(), ...json, 'known-command-id': 'not-a-uuid' },
    payload: JSON.stringify({ ids: ['n-1'] }) });
  assert.equal(badCommand.statusCode, 400);
  await server.close();
});

test('POST read returns changedIds + unreadCount with private no-store', async () => {
  const server = app({
    readNotifications: async (_ports, input) => {
      assert.deepEqual(input.ids, ['n-1', 'n-2']);
      assert.equal(input.actor.principalId, ACCOUNT);
      return { kind: 'succeeded' as const,
        value: { changedIds: ['n-1'], unreadCount: 3 } };
    },
  });
  const response = await server.inject({ method: 'POST', url: INBOX_READ,
    headers: { ...mutation(), ...json },
    payload: JSON.stringify({ ids: ['n-1', 'n-2'] }) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), { changedIds: ['n-1'], unreadCount: 3 });
  await server.close();
});

test('POST read rejects malformed bodies before the command runs', async () => {
  const server = app();
  const headers = { ...mutation(), ...json };
  for (const payload of [
    '{}',
    JSON.stringify({ ids: [] }),
    JSON.stringify({ ids: ['n-1'], extra: 1 }),
    JSON.stringify({ ids: ['n-1', 'n-1'] }),
    JSON.stringify({ ids: ['bad id!'] }),
    JSON.stringify({ ids: [5] }),
    JSON.stringify({ ids: null }),
    'not json',
  ]) {
    const response = await server.inject({ method: 'POST', url: INBOX_READ, headers, payload });
    assert.equal(response.statusCode, 400, payload);
    assert.match(response.json().error.code, /^invalid_(request|json)$/u, payload);
  }
  await server.close();
});

test('POST read forwards command-receipt kinds through sendProductCommandReceiptOutcome', async () => {
  const replayBody = Buffer.from('{"changedIds":["n-1"],"unreadCount":0}');
  const cases: readonly {
    outcome: CommunityNotificationCommandResult<unknown>;
    status: number;
    code: string | null;
    body: string | null;
    retryAfter?: string;
  }[] = [
    {
      outcome: {
        kind: 'replay', status: 200, body: replayBody,
        stableHeaders: { 'cache-control': 'private, no-store' },
        mediaType: 'application/json', contractVersion: '1.0.0',
      },
      status: 200, code: null, body: replayBody.toString(),
    },
    { outcome: { kind: 'reused' }, status: 409, code: 'command_id_reused', body: null },
    { outcome: { kind: 'in_progress', retryAfterSeconds: 3 },
      status: 409, code: 'command_in_progress', body: null, retryAfter: '3' },
    { outcome: { kind: 'expired', resultDigest: null },
      status: 410, code: 'command_result_expired', body: null },
  ];
  for (const testCase of cases) {
    const server = app({ readNotifications: async () => testCase.outcome as never });
    const response = await server.inject({ method: 'POST', url: INBOX_READ,
      headers: { ...mutation(), ...json }, payload: JSON.stringify({ ids: ['n-1'] }) });
    assert.equal(response.statusCode, testCase.status, testCase.outcome.kind);
    if (testCase.body !== null) {
      assert.equal(response.body, testCase.body);
    } else {
      assert.equal(response.json().error.code, testCase.code);
    }
    if (testCase.retryAfter !== undefined) {
      assert.equal(response.headers['retry-after'], testCase.retryAfter);
    }
    await server.close();
  }
});

test('POST read flag-off still requires auth first, then conceals', async () => {
  const server = app({ enabled: false });
  const unauthenticated = await server.inject({ method: 'POST', url: INBOX_READ,
    headers: json, payload: JSON.stringify({ ids: ['n-1'] }) });
  assert.equal(unauthenticated.statusCode, 401);
  const response = await server.inject({ method: 'POST', url: INBOX_READ,
    headers: { ...mutation(), ...json }, payload: JSON.stringify({ ids: ['n-1'] }) });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  await server.close();
});

/* ——— GET/PUT /me/community-notification-preferences ——— */

test('GET preference requires a session and returns the strong opaque ETag', async () => {
  const server = app({
    getPreference: async () => ({ enabled: true, revision: '1', updatedAt: NOW }),
  });
  const anonymous = await server.inject({ method: 'GET', url: PREFERENCES });
  assert.equal(anonymous.statusCode, 401);
  const response = await server.inject({ method: 'GET', url: PREFERENCES, headers: auth });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const expected = communityNotificationPreferenceEtag(
    { recipientAccountId: ACCOUNT, revision: '1' }, HMAC_KEY);
  assert.equal(response.headers.etag, expected);
  assert.match(String(response.headers.etag), /^"community-notification-preference:[A-Za-z0-9_-]{32}"$/u);
  assert.deepEqual(response.json(), { enabled: true, revision: '1', updatedAt: NOW });
  await server.close();
});

test('PUT preference requires If-Match and returns the stored preference with its new ETag', async () => {
  const server = app();
  const headers = { ...mutation(), ...json };
  const missing = await server.inject({ method: 'PUT', url: PREFERENCES, headers,
    payload: JSON.stringify({ enabled: false }) });
  assert.equal(missing.statusCode, 428);
  const weak = await server.inject({ method: 'PUT', url: PREFERENCES,
    headers: { ...headers, 'if-match': 'W/"weak"' },
    payload: JSON.stringify({ enabled: false }) });
  assert.equal(weak.statusCode, 400);

  const putApp = app({
    putPreference: async (_ports, input) => {
      assert.equal(input.enabled, false);
      assert.equal(input.ifMatch, '"tag-1"');
      return { kind: 'succeeded' as const,
        value: { enabled: false, revision: '2', updatedAt: NOW } };
    },
  });
  const response = await putApp.inject({ method: 'PUT', url: PREFERENCES,
    headers: { ...headers, 'if-match': '"tag-1"' },
    payload: JSON.stringify({ enabled: false }) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.etag, communityNotificationPreferenceEtag(
    { recipientAccountId: ACCOUNT, revision: '2' }, HMAC_KEY));
  assert.deepEqual(response.json(), { enabled: false, revision: '2', updatedAt: NOW });
  await server.close();
  await putApp.close();
});

test('PUT preference maps a stale tag to 412 precondition_failed with the current tag', async () => {
  const current = communityNotificationPreferenceEtag(
    { recipientAccountId: ACCOUNT, revision: '5' }, HMAC_KEY);
  const server = app({
    putPreference: async () => {
      throw new CommunityNotificationError('precondition_failed',
        'The community notification preference tag is stale.', { currentEtag: current });
    },
  });
  const response = await server.inject({ method: 'PUT', url: PREFERENCES,
    headers: { ...mutation(), ...json, 'if-match': '"stale"' },
    payload: JSON.stringify({ enabled: false }) });
  assert.equal(response.statusCode, 412);
  const body = response.json();
  assert.equal(body.error.code, 'precondition_failed');
  assert.equal(body.error.currentEtag, current);
  await server.close();
});

test('PUT preference rejects malformed bodies and forwards receipt outcomes', async () => {
  const server = app();
  const headers = { ...mutation(), ...json, 'if-match': '"tag"' };
  for (const payload of [
    '{}',
    JSON.stringify({ enabled: 'yes' }),
    JSON.stringify({ enabled: null }),
    JSON.stringify({ enabled: true, extra: 1 }),
    'not json',
  ]) {
    const response = await server.inject({ method: 'PUT', url: PREFERENCES, headers, payload });
    assert.equal(response.statusCode, 400, payload);
  }
  await server.close();

  const reused = app({ putPreference: async () => ({ kind: 'reused' as const }) });
  const response = await reused.inject({ method: 'PUT', url: PREFERENCES,
    headers: { ...mutation(), ...json, 'if-match': '"tag"' },
    payload: JSON.stringify({ enabled: true }) });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'command_id_reused');
  await reused.close();
});

/* ——— shared admission ——— */

test('community rate limiting applies to the notification paths', async () => {
  const server = app({
    rate: 1,
    listNotifications: async () => ({ items: [], nextCursor: null, unreadCount: 0 }),
  });
  assert.equal((await server.inject({ method: 'GET', url: INBOX, headers: auth })).statusCode, 200);
  const limited = await server.inject({ method: 'GET', url: INBOX, headers: auth });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'rate_limited');
  await server.close();
});

test('the notification paths expose no HEAD twins', async () => {
  const server = app({
    listNotifications: async () => ({ items: [], nextCursor: null, unreadCount: 0 }),
  });
  for (const path of [INBOX, PREFERENCES]) {
    const head = await server.inject({ method: 'HEAD', url: path, headers: auth });
    assert.equal(head.statusCode, 404, path);
  }
  assert.equal(server.hasRoute({ method: 'GET', url: INBOX }), true);
  assert.equal(server.hasRoute({ method: 'POST', url: INBOX_READ }), true);
  assert.equal(server.hasRoute({ method: 'GET', url: PREFERENCES }), true);
  assert.equal(server.hasRoute({ method: 'PUT', url: PREFERENCES }), true);
  await server.close();
});
