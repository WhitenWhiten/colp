import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createReadingProgressCursorSigner, createSavedResourceCursorSigner, type ReadingProgressReadUnitOfWork,
  type ReadingProgressUnitOfWork, type SavedResourceReadUnitOfWork,
  type SavedResourceUnitOfWork } from '../../../src/modules/reading-progress/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork } from '../../support/product-http-harness.js';

const ORIGIN = 'https://app.example.test';
const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function harness(waitForCancellation = false) {
  const now = new Date('2026-07-25T12:00:00.000Z');
  const identityState = createIdentityMemoryState(now);
  const identity = createIdentityMemoryUnitOfWork(identityState);
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const signals: AbortSignal[] = [];
  async function observeRequest(signal: AbortSignal | undefined) {
    assert.ok(signal, 'the HTTP handler passes its cancellation signal');
    signals.push(signal);
    if (waitForCancellation) await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  const readingRead: ReadingProgressReadUnitOfWork = { execute: async (work, request) => {
    await observeRequest(request?.signal);
    return work({ clock: { now: async () => now },
      cursorSigner: createReadingProgressCursorSigner({ current: { id: 'reading-http-v1', key: 'reading-http-cursor-secret' } }),
      reads: { get: async () => null, list: async () => [], hydrateAccessible: async () => [] },
    });
  } };
  const readingCommands: ReadingProgressUnitOfWork = { execute: async () => { throw new Error('unexpected reading mutation'); } };
  const read: SavedResourceReadUnitOfWork = { execute: async (work, request) => {
    await observeRequest(request?.signal);
    return work({
    clock: { now: async () => now }, cursorSigner: createSavedResourceCursorSigner({
      current: { id: 'http-v1', key: 'saved-http-cursor-secret' },
    }), reads: { async listLive() { return [{ resourceType: 'node', resourceId: 'node-1', savedAt: now }]; },
      async hydrateAccessible({ targets }) { return targets.map((target) => ({ ...target, collectionId: 'collection-1',
        title: 'Node title', url: 'https://example.test' })); } },
  }); } };
  const commands: SavedResourceUnitOfWork = { execute: async (work) => work({
    receipts: { async claim() { return { kind: 'claimed' }; }, async complete() {}, async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; } },
    targets: { async resolveAccessible(input) { return { ...input, collectionId: 'collection-1' }; } },
    savedResources: { async findLive() { return null; }, async insertLive(input) { return { inserted: true, record: {
      id: '1', accountId: input.accountId, resourceType: input.resourceType, resourceId: input.resourceId,
      savedAt: input.at, updatedAt: input.at, deletedAt: null } }; }, async softDelete() { return null; } },
    audit: { async append() {} }, clock: { now: async () => now },
  }) };
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/known_test', PRODUCT_ORIGIN: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent' });
  if (waitForCancellation) Object.assign(config.httpSecurity, { requestTimeoutMs: 10 });
  const app = buildApiApp({ config, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
    readingProgressReadUnitOfWork: readingRead, readingProgressUnitOfWork: readingCommands,
    savedResourceReadUnitOfWork: read,
    savedResourceUnitOfWork: commands }); apps.push(app); return { app, identity, identityState, factory, signals };
}
async function login(h: ReturnType<typeof harness>) {
  const client = await issueTestSession({
    factory: h.factory, subject: randomUUID(),
    displayName: 'Saved', handle: `saved_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  });
  const metadata = [...h.factory.state.metadata.values()].find((row) => row.accountId === client.accountId);
  return { cookie: client.cookie, csrf: client.csrfToken, sessionId: metadata!.authSessionId, accountId: client.accountId };
}

test('Saved Resource GET/PUT/DELETE require session and return private no-store including errors', async () => {
  const h = harness(); const unauthorized = await h.app.inject({ method: 'GET', url: '/api/v1/saved-resources' });
  assert.equal(unauthorized.statusCode, 401); assert.equal(unauthorized.headers['cache-control'], 'private, no-store');
  const client = await login(h);
  // BA-world session facts: the metadata row is the product session store; the
  // GET list route authenticates with touch:false, so a foreign lastSeenAt
  // rewrite must survive the request untouched.
  const rewritten = new Date('2026-07-25T10:00:00.000Z');
  assert.equal(h.factory.setMetadataLastSeenAt(client.accountId, rewritten), true);
  const list = await h.app.inject({ method: 'GET', url: '/api/v1/saved-resources', headers: { cookie: client.cookie } });
  assert.equal(list.statusCode, 200); assert.equal(list.headers['cache-control'], 'private, no-store');
  const metadata = [...h.factory.state.metadata.values()].find((row) => row.accountId === client.accountId)!;
  assert.equal(metadata.lastSeenAt.toISOString(), '2026-07-25T10:00:00.000Z');
  const headers = { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': randomUUID() };
  const put = await h.app.inject({ method: 'PUT', url: '/api/v1/saved-resources/node/node-1', headers });
  assert.equal(put.statusCode, 201); assert.equal(put.headers['cache-control'], 'private, no-store');
  const del = await h.app.inject({ method: 'DELETE', url: '/api/v1/saved-resources/node/node-1', headers: { ...headers, 'known-command-id': randomUUID() } });
  assert.equal(del.statusCode, 204); assert.equal(del.headers['cache-control'], 'private, no-store');
});

test('mutations enforce Origin, CSRF, Known-Command-Id, no body/media and header cardinality', async () => {
  const h = harness(); const client = await login(h); const url = '/api/v1/saved-resources/node/node-1';
  for (const request of [
    { headers: { cookie: client.cookie, origin: ORIGIN, 'known-command-id': randomUUID() } },
    { headers: { cookie: client.cookie, origin: 'https://evil.test', 'x-csrf-token': client.csrf, 'known-command-id': randomUUID() } },
    { headers: { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf } },
    { headers: { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': randomUUID(), 'content-type': 'application/json' }, payload: {} },
  ]) { const response = await h.app.inject({ method: 'PUT', url, ...request }); assert.ok(response.statusCode >= 400); assert.equal(response.headers['cache-control'], 'private, no-store'); }
  for (const headers of [
    { cookie: client.cookie, origin: [ORIGIN, 'https://evil.test'], 'x-csrf-token': client.csrf, 'known-command-id': randomUUID() },
    { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': [client.csrf, client.csrf], 'known-command-id': randomUUID() },
    { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': [randomUUID(), randomUUID()] },
  ]) { const response = await h.app.inject({ method: 'PUT', url, headers }); assert.equal(response.statusCode, 400); assert.equal(response.headers['cache-control'], 'private, no-store'); }
});

test('list rejects repeated, unknown, empty and noncanonical query parameters', async () => {
  const h = harness(); const client = await login(h);
  for (const query of ['resourceType=node&resourceType=collection', 'resourceType=', 'resourceType=annotation',
    'limit=01', 'cursor=x&limit=1', 'createdAfter=bad', 'unknown=x']) {
    const response = await h.app.inject({ method: 'GET', url: `/api/v1/saved-resources?${query}`, headers: { cookie: client.cookie } });
    assert.equal(response.statusCode, 400, query); assert.equal(response.headers['cache-control'], 'private, no-store');
  }
});


test('Reading Progress handlers authenticate with the real HTTP config and pass read cancellation', async () => {
  const h = harness();
  for (const [method, url] of [
    ['GET', '/api/v1/reading-progress'], ['GET', '/api/v1/reading-progress/node/node-1'],
    ['PUT', '/api/v1/reading-progress/node/node-1'], ['DELETE', '/api/v1/reading-progress/node/node-1'],
  ] as const) {
    const response = await h.app.inject({ method, url, headers: { origin: ORIGIN } });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
  const client = await login(h);
  const list = await h.app.inject({ method: 'GET', url: '/api/v1/reading-progress', headers: { cookie: client.cookie } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().page.returnedCount, 0);
  const item = await h.app.inject({ method: 'GET', url: '/api/v1/reading-progress/node/node-1', headers: { cookie: client.cookie } });
  assert.equal(item.statusCode, 404);
  assert.equal(h.signals.length, 2);
  assert.ok(h.signals.every(signal => !signal.aborted));
});

for (const url of ['/api/v1/reading-progress', '/api/v1/saved-resources']) {
  test(`${url} aborts a pending downstream read at the configured deadline`, async () => {
    const h = harness(true); const client = await login(h);
    const response = await h.app.inject({ method: 'GET', url, headers: { cookie: client.cookie } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
    assert.equal(h.signals.length, 1);
    assert.equal(h.signals[0]!.aborted, true);
    assert.equal(h.signals[0]!.reason.name, 'AbortError');
  });
}
