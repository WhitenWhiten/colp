import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import type { BookmarkPreferencesStore, BookmarkPreferencesView } from '../../../src/modules/identity/index.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork, createMemoryProductCommandReceiptPort } from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

const trusted = `chrome-extension://${'a'.repeat(32)}`;
const untrusted = `chrome-extension://${'b'.repeat(32)}`;
const url = '/api/v1/me/bookmark-preferences';
const apps: ReturnType<typeof buildApiApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup(enabled = true) {
  const now = new Date('2026-09-20T00:00:00Z');
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(now));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const client = await issueTestSession({ factory, subject: 'bookmark-composition', handle: 'bookmark_composition' });
  const base = loadConfig({ DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
    ALLOWED_ORIGINS: 'https://known.example', LOG_LEVEL: 'silent', OIDC_JWKS_URI: 'https://issuer.example/certs' });
  const config = { ...base, betterAuth: { ...base.betterAuth, enabled, trustedOrigins: [trusted, 'https://known.example'] } };
  let current: BookmarkPreferencesView | null = null;
  const store: BookmarkPreferencesStore = {
    load: async () => current,
    insertFirst: async (_account, view) => { if (current) return 'conflict'; current = view; return 'inserted'; },
    updateIfRevision: async (_account, revision, view) => {
      if (current?.revision !== revision) return false;
      current = view; return true;
    },
  };
  const receipts = createMemoryProductCommandReceiptPort(new Map());
  const app = buildApiApp({ config, identityUnitOfWork, browserSessionAuthority: factory.authority,
    bookmarkPreferencesQuery: store,
    bookmarkPreferencesUnitOfWork: { execute: work => work({ store, receipts, clock: { now: async () => now } }) } });
  apps.push(app);
  const headers = { cookie: client.cookie, 'x-csrf-token': client.csrfToken,
    'known-command-id': randomUUID(), 'if-match': '"0"', 'content-type': 'application/json' };
  return { app, headers, config };
}

test('production composition admits only trusted extension preference PATCH and CORS, retaining CSRF', async () => {
  const { app, headers, config } = await setup();
  const preflight = await app.inject({ method: 'OPTIONS', url, headers: { origin: trusted,
    'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type,x-csrf-token,known-command-id,if-match' } });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(trusted);
  expect(preflight.headers['access-control-allow-credentials']).toBe('true');
  expect(preflight.headers['access-control-allow-methods']).toBe('GET, PATCH, OPTIONS');
  expect(preflight.headers['access-control-expose-headers']).toContain('ETag');
  expect(preflight.headers['access-control-expose-headers']).toContain('Known-Bookmark-Session');
  for (const origin of [untrusted, 'https://untrusted.example']) {
    const denied = await app.inject({ method: 'PATCH', url, headers: { ...headers, origin }, payload: { foldersFirst: false } });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  }
  const badCsrf = await app.inject({ method: 'PATCH', url,
    headers: { ...headers, origin: trusted, 'x-csrf-token': 'wrong' }, payload: { foldersFirst: false } });
  expect(badCsrf.statusCode).toBe(403);
  const write = await app.inject({ method: 'PATCH', url, headers: { ...headers, origin: trusted },
    payload: { bookmarkInsertPosition: 'top', foldersFirst: false } });
  expect(write.statusCode, write.body).toBe(200);
  expect(write.json()).toMatchObject({ bookmarkInsertPosition: 'top', foldersFirst: false, revision: '1' });
  expect(write.headers['access-control-allow-origin']).toBe(trusted);
  const read = await app.inject({ method: 'GET', url, headers: { cookie: headers.cookie, origin: trusted } });
  expect(read.json()).toEqual(write.json());
  expect(read.headers['known-bookmark-session']).toEqual(expect.any(String));
  expect(config.allowedOrigins).toEqual(['https://known.example']);
  const unrelated = await app.inject({ method: 'OPTIONS', url: '/api/v1/me', headers: { origin: trusted } });
  expect(unrelated.headers['access-control-allow-origin']).toBeUndefined();
});

test('disabled Better Auth does not admit a configured extension into preference mutation origins', async () => {
  const { app, headers } = await setup(false);
  const response = await app.inject({ method: 'PATCH', url, headers: { ...headers, origin: trusted }, payload: { foldersFirst: false } });
  expect(response.statusCode).toBe(403);
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
});
