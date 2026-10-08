import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  virtualBookmarkPreferences,
  type BookmarkPreferencesStore,
  type BookmarkPreferencesView,
} from '../../../src/modules/identity/index.js';
import { registerBookmarkPreferencesRoutes } from '../../../src/transport/product/bookmark-preferences-routes.js';
import { parseStrictQuery, installProductAdmission } from '../../../src/transport/product-admission.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import { createMemoryProductCommandReceiptPort } from '../../support/product-http-harness.js';

const servers: ReturnType<typeof Fastify>[] = [];
const now = new Date('2026-09-19T00:00:00.000Z');
const account = { id: 'bookmark-account', subjectId: 'bookmark-subject', status: 'active' as const,
  securityEpoch: 1n, createdAt: now, deletedAt: null };
const identity = {
  sessions: { findByTokenHash: async () => ({ id: 'session', accountId: account.id, csrfTokenHash: 'csrf-hash',
    securityEpoch: 1n, createdAt: now, lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + 60_000),
    absoluteExpiresAt: new Date(now.getTime() + 60_000), revokedAt: null }), touch: async () => true },
  accounts: { findById: async () => account },
  clock: { now: async () => now },
} as unknown as IdentityPorts;
const identityUnitOfWork: IdentityUnitOfWork = { execute: (work) => work(identity) };
const auth = { cookie: '__Host-known_session=test' };

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

function setup() {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  servers.push(server);
  installProductRouteManifestChecks(server, { requireComplete: false });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => sendProductError(request, reply,
    error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'test failure' })));
  let current: BookmarkPreferencesView | null = null;
  const store: BookmarkPreferencesStore = {
    load: async (accountId) => accountId === account.id ? current : null,
    insertFirst: async (_accountId, view) => { if (current) return 'conflict'; current = view; return 'inserted'; },
    updateIfRevision: async (_accountId, revision, view) => {
      if (!current || current.revision !== revision) return false;
      current = view;
      return true;
    },
  };
  const receipts = createMemoryProductCommandReceiptPort(new Map());
  registerBookmarkPreferencesRoutes(server, {
    identityUnitOfWork,
    allowedOrigins: ['https://app.example.test'],
    csrfMatches: (raw) => raw === 'csrf',
    queryStore: store,
    commandUnitOfWork: { execute: (work) => work({ receipts, store, clock: { now: async () => now } }) },
  });
  return server;
}

function mutation(etag = '"0"', commandId = randomUUID()) {
  return { ...auth, origin: 'https://app.example.test', 'x-csrf-token': 'csrf',
    'known-command-id': commandId, 'if-match': etag, 'content-type': 'application/json' };
}

test('GET returns virtual bottom/false preferences with revision 0 and no-store ETag', async () => {
  const server = setup();
  const response = await server.inject({ method: 'GET', url: '/api/v1/me/bookmark-preferences', headers: auth });
  expect(response.statusCode).toBe(200);
  expect(response.headers.etag).toBe('"0"');
  expect(response.headers['known-bookmark-session']).toBe('session');
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.json()).toEqual({ bookmarkInsertPosition: 'bottom', foldersFirst: false, captureMode: 'manual', resultPanelAutoDismissMs: 3000, learnFromCorrections: true, resumeClassificationWhenOnline: true, aiTagMode: 'suggest',
    subscriptionOnUnfollow: 'keep', subscriptionOnUnsubscribe: 'keep', subscriptionDefaultCheckIntervalMinutes: 15, subscriptionDefaultDigestMode: 'latest', subscriptionDefaultEditionLimit: 10,
    revision: '0', updatedAt: now.toISOString() });
  expect(virtualBookmarkPreferences(now).revision).toBe('0');
});

test('PATCH validates Origin/CSRF/If-Match, persists revision 1, replays exact bytes, and rejects reuse', async () => {
  const server = setup();
  const commandId = randomUUID();
  const first = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: mutation('"0"', commandId), payload: { bookmarkInsertPosition: 'top', foldersFirst: false } });
  expect(first.statusCode).toBe(200);
  expect(first.headers.etag).toBe('"1"');
  expect(first.json()).toMatchObject({ bookmarkInsertPosition: 'top', foldersFirst: false, revision: '1' });

  const replay = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: mutation('"0"', commandId), payload: { foldersFirst: false, bookmarkInsertPosition: 'top' } });
  expect(replay.statusCode).toBe(200);
  expect(replay.body).toBe(first.body);

  const reused = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: mutation('"1"', commandId), payload: { foldersFirst: true } });
  expect(reused.statusCode).toBe(409);
  expect(reused.json().error.code).toBe('command_id_reused');

  const stale = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: mutation('"0"'), payload: { foldersFirst: true } });
  expect(stale.statusCode).toBe(412);
  expect(stale.headers.etag).toBeUndefined();
});

test('PATCH rejects invalid document and CSRF/Origin failures before writing', async () => {
  const server = setup();
  const badDocument = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: mutation(), payload: { bookmarkInsertPosition: 'middle' } });
  expect(badDocument.statusCode).toBe(400);
  const badCsrf = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: { ...mutation(), 'x-csrf-token': 'wrong' }, payload: { foldersFirst: false } });
  expect(badCsrf.statusCode).toBe(403);
  const badOrigin = await server.inject({ method: 'PATCH', url: '/api/v1/me/bookmark-preferences',
    headers: { ...mutation(), origin: 'https://evil.example.test' }, payload: { foldersFirst: false } });
  expect(badOrigin.statusCode).toBe(403);
});

test('N-1 patches preserve automatic settings and invalid new values fail before admission', async () => {
  const server = setup();
  const url = '/api/v1/me/bookmark-preferences';
  for (const payload of [{ captureMode: null }, { captureMode: 'background' }, { resultPanelAutoDismissMs: 2999 },
    { resultPanelAutoDismissMs: 30001 }, { resultPanelAutoDismissMs: 3000.5 }, { learnFromCorrections: 'true' },
    { aiTagMode: 'auto' }, { aiTagMode: null }]) {
    expect((await server.inject({ method: 'PATCH', url, headers: mutation(), payload })).statusCode).toBe(400);
  }
  const first = await server.inject({ method: 'PATCH', url, headers: mutation(),
    payload: { captureMode: 'automatic', resultPanelAutoDismissMs: 0, learnFromCorrections: false, resumeClassificationWhenOnline: false, aiTagMode: 'add' } });
  expect(first.statusCode).toBe(200);
  const oldClient = await server.inject({ method: 'PATCH', url, headers: mutation('"1"'),
    payload: { bookmarkInsertPosition: 'top', foldersFirst: false } });
  expect(oldClient.statusCode).toBe(200);
  expect(oldClient.json()).toMatchObject({ captureMode: 'automatic', resultPanelAutoDismissMs: 0,
    learnFromCorrections: false, resumeClassificationWhenOnline: false, aiTagMode: 'add' });
});

test('subscription defaults survive legacy PATCH and manual interval remains null', async () => {
  const server = setup();
  const url = '/api/v1/me/bookmark-preferences';
  const first = await server.inject({ method: 'PATCH', url, headers: mutation(), payload: {
    subscriptionOnUnfollow: 'remove', subscriptionOnUnsubscribe: 'remove',
    subscriptionDefaultCheckIntervalMinutes: null, subscriptionDefaultDigestMode: 'recent', subscriptionDefaultEditionLimit: 20,
  } });
  expect(first.statusCode).toBe(200);
  expect(first.headers['known-bookmark-session']).toBe('session');
  const legacy = await server.inject({ method: 'PATCH', url, headers: mutation('"1"'), payload: { foldersFirst: false } });
  expect(legacy.json()).toMatchObject({ subscriptionOnUnfollow: 'remove', subscriptionOnUnsubscribe: 'remove',
    subscriptionDefaultCheckIntervalMinutes: null, subscriptionDefaultDigestMode: 'recent', subscriptionDefaultEditionLimit: 20 });
  for (const payload of [{ subscriptionOnUnfollow: null }, { subscriptionOnUnsubscribe: 'inherit' },
    { subscriptionDefaultCheckIntervalMinutes: 0 }, { subscriptionDefaultDigestMode: 'all' },
    { subscriptionDefaultEditionLimit: 0 }, { subscriptionDefaultEditionLimit: 21 }, { subscriptionDefaultEditionLimit: 1.5 }]) {
    expect((await server.inject({ method: 'PATCH', url, headers: mutation('"2"'), payload })).statusCode).toBe(400);
  }
});

test('mutation and exact receipt replay carry the authenticated session', async () => {
  const server = setup();
  const request = { method: 'PATCH' as const, url: '/api/v1/me/bookmark-preferences',
    headers: mutation(), payload: { subscriptionOnUnsubscribe: 'remove' } };
  const first = await server.inject(request);
  const replay = await server.inject(request);
  expect(first.statusCode).toBe(200);
  expect(replay.statusCode).toBe(200);
  expect(replay.body).toBe(first.body);
  expect(replay.headers['known-bookmark-session']).toBe('session');
});
