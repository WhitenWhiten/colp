import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import type { NotificationInboxQueryPorts, NotificationPreferenceCommandPorts,
  NotificationPreferenceReadPort, NotificationReadCommandPorts } from '../../../src/modules/notifications/index.js';
import { NotificationInboxCursorError } from '../../../src/modules/notifications/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { registerNotificationRoutes,
  type NotificationRoutesDependencies } from '../../../src/transport/product/notification-routes.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';

const ACTOR = 'EREREREREREREREREREQ';
const identity: IdentityUnitOfWork = { execute: (work) => work({ sessions: {
  findByTokenHash: async () => ({ id: 's', accountId: ACTOR, tokenHash: 'x', csrfTokenHash: 'csrf-hash',
    securityEpoch: 1n, createdAt: new Date(), lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + 1e5),
    absoluteExpiresAt: new Date(Date.now() + 1e5), revokedAt: null, rotatedFromSessionId: null }), touch: async () => true },
  accounts: { findById: async () => ({ id: ACTOR, subjectId: 'subject', email: 'secret@example.test', status: 'active',
    securityEpoch: 1n, createdAt: new Date(), deletedAt: null }) }, clock: { now: async () => new Date() } } as IdentityPorts) };

function app(rate = 100, query: NonNullable<NotificationRoutesDependencies['query']> =
  async () => ({ items: [], nextCursor: null, unreadCount: 7 })) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => sendProductError(request, reply,
    error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'Internal error.' })));
  registerNotificationRoutes(server, { enabled: true, allowedOrigins: ['https://app.example.test'],
    identityUnitOfWork: identity, csrfMatches: (raw) => raw === 'csrf',
    queryUnitOfWork: { execute: (work) => work({} as NotificationInboxQueryPorts) },
    readCommandUnitOfWork: { execute: (work) => work({ clock: {
      now: async () => new Date('2026-07-29T12:00:00.000Z') } } as unknown as NotificationReadCommandPorts) },
    preferenceRead: {} as unknown as NotificationPreferenceReadPort,
    preferenceCommandUnitOfWork: { execute: (work) => work({} as NotificationPreferenceCommandPorts) },
    query,
    markOne: async () => ({ kind: 'succeeded', outcome: 'not_found', changed: false }),
    markMany: async () => ({ kind: 'succeeded', requestedCount: 1, markedCount: 0 }),
    readPreference: async () => ({ channel: 'in_app', enabled: true, revision: 2n,
      updatedAt: new Date(0).toISOString(),
      email: { enabled: false, revision: 0n, updatedAt: new Date(1).toISOString(),
        verifiedSender: 'no-reply@example.test', emailSuppressed: false, emailAvailable: true } }),
    updatePreference: async (ports, input) => ({ kind: 'succeeded', channel: input.channel,
      enabled: input.mode === 'set' ? input.enabled : input.channel === 'email' ? false : true,
      revision: 3n, updatedAt: new Date(1).toISOString(), changed: true }),
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }), timeoutMs: 100 });
  return server;
}
const auth = { cookie: '__Host-known_session=test-token' };
const mutation = () => ({ ...auth, origin: 'https://app.example.test', 'x-csrf-token': 'csrf',
  'known-command-id': randomUUID(), 'content-type': 'application/json' });

test('list validates raw query, keeps unread authority count, and never leaks private markers', async () => {
  const server = app();
  const unauthenticated = await server.inject({ method: 'GET', url: '/api/v1/notifications' });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.headers['cache-control'], 'private, no-store');
  const duplicate = await server.inject({ method: 'GET', url: '/api/v1/notifications?limit=1&limit=2', headers: auth });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.headers['cache-control'], 'private, no-store');
  const duplicateCookie = await server.inject({ method: 'GET', url: '/api/v1/notifications',
    headers: { cookie: [auth.cookie, auth.cookie] } });
  assert.equal(duplicateCookie.statusCode, 400);
  const body = await server.inject({ method: 'GET', url: '/api/v1/notifications', headers: {
    ...auth, 'content-type': 'text/plain', 'content-length': '1' }, payload: 'x' });
  assert.equal(body.statusCode, 415);
  assert.equal(body.headers['cache-control'], 'private, no-store');
  const oversized = await server.inject({ method: 'GET', url: '/api/v1/notifications', headers: {
    ...auth, 'content-type': 'text/plain', 'content-length': '2' }, payload: 'xx' });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.headers['cache-control'], 'private, no-store');
  const response = await server.inject({ method: 'GET', url: '/api/v1/notifications?state=unread&limit=1', headers: auth });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.json().unreadCount, 7); assert.doesNotMatch(response.body, /secret@example|delivery|provider|rawEvent/iu);
  await server.close();
});

test('mutations enforce Origin CSRF command ids bodies and strong If-Match', async () => {
  const server = app();
  const forbidden = await server.inject({ method: 'POST', url: '/api/v1/notifications/read', headers: auth,
    payload: { notificationIds: ['n1'] } });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.headers['cache-control'], 'private, no-store');
  const missingPrecondition = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/in_app',
    headers: mutation(), payload: { mode: 'set', enabled: false } });
  assert.equal(missingPrecondition.statusCode, 428);
  assert.equal(missingPrecondition.headers['cache-control'], 'private, no-store');
  const ok = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/in_app',
    headers: { ...mutation(), 'if-match': '"notification-preference:in_app:2"' }, payload: { mode: 'set', enabled: false } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.headers.etag, '"notification-preference:in_app:3"');
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  const { 'content-type': _contentType, ...markHeaders } = mutation();
  const marked = await server.inject({ method: 'PUT', url: '/api/v1/notifications/n1/read',
    headers: { ...markHeaders, 'if-match': '"notification:0"' } });
  assert.equal(marked.statusCode, 200, marked.body); assert.deepEqual(marked.json(),
    { kind: 'succeeded', outcome: 'not_found', changed: false });
  for (const [name, value] of [
    ['origin', ['https://app.example.test', 'https://app.example.test']],
    ['x-csrf-token', ['csrf', 'csrf']],
    ['known-command-id', [randomUUID(), randomUUID()]],
    ['if-match', ['"notification:0"', '"notification:0"']],
  ] as const) {
    const headers: Record<string, string | readonly string[]> = {
      ...markHeaders, 'if-match': '"notification:0"', [name]: value,
    };
    const duplicate = await server.inject({ method: 'PUT', url: '/api/v1/notifications/n1/read', headers });
    assert.equal(duplicate.statusCode, 400, name);
  }
  const weak = await server.inject({ method: 'PUT', url: '/api/v1/notifications/n1/read',
    headers: { ...markHeaders, 'if-match': 'W/"notification:0"' } });
  assert.equal(weak.statusCode, 400);
  const badCommand = await server.inject({ method: 'POST', url: '/api/v1/notifications/read',
    headers: { ...mutation(), 'known-command-id': 'not-canonical' }, payload: { notificationIds: ['n1'] } });
  assert.equal(badCommand.statusCode, 400);
  const badMedia = await server.inject({ method: 'POST', url: '/api/v1/notifications/read',
    headers: { ...mutation(), 'content-type': 'text/plain' }, payload: 'private-marker' });
  assert.equal(badMedia.statusCode, 415);
  assert.equal(badMedia.headers['cache-control'], 'private, no-store');
  const duplicateMedia = await server.inject({ method: 'POST', url: '/api/v1/notifications/read',
    headers: { ...mutation(), 'content-type': ['application/json', 'application/json'] },
    payload: { notificationIds: ['n1'] } });
  assert.equal(duplicateMedia.statusCode, 400);
  const badBody = await server.inject({ method: 'POST', url: '/api/v1/notifications/read',
    headers: mutation(), payload: { notificationIds: ['n1'], providerMessageId: 'private-marker' } });
  assert.equal(badBody.statusCode, 422); assert.doesNotMatch(badBody.body, /private-marker/u);
  assert.equal(badBody.headers['cache-control'], 'private, no-store');
  await server.close();
});

test('email preference channel is accepted additively while push/invalid channels are rejected', async () => {
  const server = app();
  const get = await server.inject({ method: 'GET', url: '/api/v1/notification-preferences', headers: auth });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers['cache-control'], 'private, no-store');
  // FIX-M-023: the aggregate GET ETag is a whole-representation cache validator
  // only; the per-channel revisions in the body build the channel PUT validators.
  assert.equal(get.headers.etag, '"notification-preferences:all:2"');
  const body = get.json();
  assert.equal(body.channel, 'in_app');
  assert.equal(body.enabled, true);
  assert.deepEqual(body.email, { enabled: false, revision: '0',
    updatedAt: new Date(1).toISOString(), verifiedSender: 'no-reply@example.test',
    emailSuppressed: false, emailAvailable: true });
  const email = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/email',
    headers: { ...mutation(), 'if-match': '"notification-preference:email:0"' },
    payload: { mode: 'set', enabled: true } });
  assert.equal(email.statusCode, 200, email.body);
  assert.equal(email.json().channel, 'email');
  assert.equal(email.json().enabled, true);
  assert.equal(email.headers.etag, '"notification-preference:email:3"');
  const reset = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/email',
    headers: { ...mutation(), 'if-match': '"notification-preference:email:1"' }, payload: { mode: 'reset' } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().enabled, false);
  for (const channel of ['push', 'sms', 'inapp', 'email ']) {
    const bad = await server.inject({ method: 'PUT',
      url: `/api/v1/notification-preferences/${encodeURIComponent(channel)}`,
      headers: { ...mutation(), 'if-match': '"notification-preference:0"' },
      payload: { mode: 'set', enabled: true } });
    assert.equal(bad.statusCode, 400, channel);
  }
  await server.close();
});

test('preference PUT preconditions are channel-scoped with a frozen in_app compatibility window', async () => {
  const server = app();
  // The strong validator must name the path channel and is rejected otherwise.
  const inApp = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/in_app',
    headers: { ...mutation(), 'if-match': '"notification-preference:in_app:2"' },
    payload: { mode: 'set', enabled: false } });
  assert.equal(inApp.statusCode, 200, inApp.body);
  assert.equal(inApp.headers.etag, '"notification-preference:in_app:3"');
  const email = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/email',
    headers: { ...mutation(), 'if-match': '"notification-preference:email:0"' },
    payload: { mode: 'set', enabled: true } });
  assert.equal(email.statusCode, 200, email.body);
  assert.equal(email.headers.etag, '"notification-preference:email:3"');
  // Pre-FIX-M-023 aggregate validator stays valid for in_app during the
  // compatibility window because it was derived from the in_app revision...
  const legacyInApp = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/in_app',
    headers: { ...mutation(), 'if-match': '"notification-preference:2"' },
    payload: { mode: 'set', enabled: true } });
  assert.equal(legacyInApp.statusCode, 200, legacyInApp.body);
  // ...but is never replayed across channels: email rejects the old format.
  const legacyEmail = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/email',
    headers: { ...mutation(), 'if-match': '"notification-preference:0"' },
    payload: { mode: 'set', enabled: true } });
  assert.equal(legacyEmail.statusCode, 400, legacyEmail.body);
  // A validator naming another channel is rejected for both channels.
  const crossInApp = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/in_app',
    headers: { ...mutation(), 'if-match': '"notification-preference:email:0"' },
    payload: { mode: 'set', enabled: true } });
  assert.equal(crossInApp.statusCode, 400, crossInApp.body);
  const crossEmail = await server.inject({ method: 'PUT', url: '/api/v1/notification-preferences/email',
    headers: { ...mutation(), 'if-match': '"notification-preference:in_app:2"' },
    payload: { mode: 'set', enabled: true } });
  assert.equal(crossEmail.statusCode, 400, crossEmail.body);
  // The aggregate GET ETag is a whole-representation cache validator only and
  // is never accepted as a channel PUT precondition.
  for (const channel of ['in_app', 'email']) {
    const aggregate = await server.inject({ method: 'PUT',
      url: `/api/v1/notification-preferences/${channel}`,
      headers: { ...mutation(), 'if-match': '"notification-preferences:all:2"' },
      payload: { mode: 'set', enabled: true } });
    assert.equal(aggregate.statusCode, 400, channel);
  }
  await server.close();
});

test('cursor errors and cancellation use stable secret-safe Product errors', async () => {
  const cursor = app(100, async () => { throw new NotificationInboxCursorError(); });
  const invalid = await cursor.inject({ method: 'GET', url: '/api/v1/notifications?cursor=tampered',
    headers: auth });
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error.code, 'invalid_cursor');
  assert.equal(invalid.headers['cache-control'], 'private, no-store');
  await cursor.close();

  let signalObserved = false;
  const timeout = app(100, (_ports, input) => new Promise((_resolve, reject) => {
    input.signal?.addEventListener('abort', () => {
      signalObserved = true; reject(input.signal?.reason);
    }, { once: true });
  }));
  const unavailable = await timeout.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().error.code, 'feature_temporarily_unavailable');
  assert.equal(signalObserved, true);
  assert.doesNotMatch(unavailable.body, /cancelled|cookie|csrf|secret/iu);
  await timeout.close();
});

test('rate limits are shared per principal and endpoint family', async () => {
  const server = app(1);
  assert.equal((await server.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth })).statusCode, 200);
  const response = await server.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
  assert.equal(response.statusCode, 429); assert.equal(response.headers['cache-control'], 'private, no-store');
  await server.close();
});

test('frozen Phase 5 /me aliases share the successor handlers with parity auth, CSRF, cache, and ETag', async () => {
  const server = app();
  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/api/v1/me/notifications' });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.headers['cache-control'], 'private, no-store');
    const duplicate = await server.inject({ method: 'GET', url: '/api/v1/me/notifications?read=true&read=false', headers: auth });
    assert.equal(duplicate.statusCode, 400);
    const invalid = await server.inject({ method: 'GET', url: '/api/v1/me/notifications?read=maybe', headers: auth });
    assert.equal(invalid.statusCode, 400);
    const unsupported = await server.inject({ method: 'GET', url: '/api/v1/me/notifications?state=read', headers: auth });
    assert.equal(unsupported.statusCode, 400);
    const page = await server.inject({ method: 'GET', url: '/api/v1/me/notifications?read=true&limit=1', headers: auth });
    assert.equal(page.statusCode, 200); assert.equal(page.headers['cache-control'], 'private, no-store');
    assert.deepEqual(page.json(), { items: [], nextCursor: null, unreadCount: 7 });

    const forbidden = await server.inject({ method: 'POST', url: '/api/v1/me/notifications/read',
      headers: auth, payload: { notificationIds: ['n1'] } });
    assert.equal(forbidden.statusCode, 403);
    const badBody = await server.inject({ method: 'POST', url: '/api/v1/me/notifications/read',
      headers: mutation(), payload: { notificationIds: [] } });
    assert.equal(badBody.statusCode, 422);
    const marked = await server.inject({ method: 'POST', url: '/api/v1/me/notifications/read',
      headers: mutation(), payload: { notificationIds: ['n1', 'n2'] } });
    assert.equal(marked.statusCode, 200, marked.body);
    assert.equal(marked.headers['cache-control'], 'private, no-store');
    assert.deepEqual(marked.json(), { notificationIds: ['n1', 'n2'], readAt: '2026-07-29T12:00:00.000Z' });

    const preferences = await server.inject({ method: 'GET', url: '/api/v1/me/notification-preferences', headers: auth });
    assert.equal(preferences.statusCode, 200);
    assert.equal(preferences.headers.etag, '"notification-preference:2"');
    assert.deepEqual(preferences.json(),
      { revision: '2', inAppNewFollower: true, inAppFollowedCollectionChanged: true });

    const updated = await server.inject({ method: 'PUT', url: '/api/v1/me/notification-preferences',
      headers: mutation(), payload: { revision: '2', inAppNewFollower: false, inAppFollowedCollectionChanged: false } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.headers.etag, '"notification-preference:3"');
    assert.deepEqual(updated.json(),
      { revision: '3', inAppNewFollower: false, inAppFollowedCollectionChanged: false });
    const mismatched = await server.inject({ method: 'PUT', url: '/api/v1/me/notification-preferences',
      headers: mutation(), payload: { revision: '2', inAppNewFollower: true, inAppFollowedCollectionChanged: false } });
    assert.equal(mismatched.statusCode, 400);
  } finally { await server.close(); }
});

test('frozen /me notification list maps the read boolean onto the successor state filter', async () => {
  const captured: Array<{ state?: string }> = [];
  const server = app(100, async (_ports, input) => {
    captured.push(input); return { items: [], nextCursor: null, unreadCount: 7 };
  });
  try {
    await server.inject({ method: 'GET', url: '/api/v1/me/notifications', headers: auth });
    await server.inject({ method: 'GET', url: '/api/v1/me/notifications?read=true', headers: auth });
    await server.inject({ method: 'GET', url: '/api/v1/me/notifications?read=false&limit=1', headers: auth });
    assert.deepEqual(captured.map((input) => input.state), [undefined, 'read', 'unread']);
  } finally { await server.close(); }
});

test('successor list serializes locator keys while frozen /me keeps the old item whitelist', async () => {
  const item = {
    notificationId: 'n-locator', notificationType: 'collection_change' as const,
    actorProfileId: 'profile-1', actorHandle: 'mira.writer', actorDisplayName: 'Mira',
    subject: { type: 'collection' as const, id: 'collection-opaque' },
    collectionTitle: 'LLM learning path', publicationSlug: 'llm-learning-path',
    summary: 'public_collection_updated',
    state: 'unread' as const, stateRevision: '0', readAt: null,
    occurredAt: '2026-07-29T12:00:00.000Z',
  };
  const server = app(100, async () => ({ items: [item], nextCursor: null, unreadCount: 1 }));
  try {
    const successor = await server.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
    assert.equal(successor.statusCode, 200);
    const successorItem = successor.json().items[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(successorItem).sort(),
      ['actorDisplayName', 'actorHandle', 'actorProfileId', 'collectionTitle',
        'notificationId', 'notificationType', 'occurredAt', 'publicationSlug', 'readAt',
        'state', 'stateRevision', 'subject', 'summary']);
    assert.equal(successorItem.actorHandle, 'mira.writer');
    assert.equal(successorItem.publicationSlug, 'llm-learning-path');
    assert.equal(successorItem.collectionTitle, 'LLM learning path');
    assert.equal(successorItem.summary, 'public_collection_updated');
    assert.equal(successorItem.subject && (successorItem.subject as { id: string }).id, 'collection-opaque');
    const frozen = await server.inject({ method: 'GET', url: '/api/v1/me/notifications', headers: auth });
    assert.equal(frozen.statusCode, 200);
    const frozenItem = frozen.json().items[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(frozenItem).sort(),
      ['actor', 'collectionId', 'createdAt', 'kind', 'notificationId', 'readAt']);
    assert.equal(Object.hasOwn(frozenItem, 'actorHandle'), false);
    assert.equal(Object.hasOwn(frozenItem, 'publicationSlug'), false);
    assert.equal(Object.hasOwn(frozenItem, 'collectionTitle'), false);
    assert.equal(Object.hasOwn(frozenItem, 'summary'), false);
    assert.doesNotMatch(frozen.body, /mira\.writer|llm-learning-path/u);
  } finally { await server.close(); }
});

test('frozen /me aliases consume the same per-principal rate budget as their successor paths', async () => {
  const server = app(1);
  try {
    assert.equal((await server.inject({ method: 'GET', url: '/api/v1/me/notifications', headers: auth })).statusCode, 200);
    const second = await server.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
    assert.equal(second.statusCode, 429); assert.equal(second.headers['cache-control'], 'private, no-store');
  } finally { await server.close(); }
});
