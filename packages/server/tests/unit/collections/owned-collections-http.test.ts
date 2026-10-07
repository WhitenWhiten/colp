import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createProductOwnedCollectionsCursorSigner,
  type CollectionsUnitOfWork,
  type OwnedCollectionFact,
  type ProductCollectionMutationUnitOfWork,
} from '../../../src/modules/collections/index.js';
import { SESSION_IDLE_TTL_MS, SESSION_TOUCH_MIN_INTERVAL_MS } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const NOW = new Date('2026-07-26T08:00:00.000Z');
const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/owned_http_test',
  PRODUCT_ORIGIN: 'https://app.example.test', ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default', NODE_ENV: 'test', LOG_LEVEL: 'silent',
});
interface OwnedPageDocument {
  readonly items: ReadonlyArray<{
    readonly collection: { readonly id: string };
    readonly capabilities: Readonly<Record<string, boolean>>;
    readonly bookmarkCount: number;
  }>;
  readonly page: { readonly returnedCount: number; readonly hasMore: boolean; readonly nextCursor: string | null };
}

function fact(id: string, _subject: string, overrides: Partial<OwnedCollectionFact> = {}): OwnedCollectionFact {
  return {
    id, kind: 'bookmarks', title: `Private title ${id}`, summary: null, visibility: 'private',
    publicationSlug: null, allowSearchIndexing: false, publishedAt: null,
    rootNodeId: `root-${id}`, resourceRevision: `r-${id}`, contentRevision: `c-${id}`,
    policyRevision: `p-${id}`, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

const unusedCollections: CollectionsUnitOfWork = {
  async execute<T>(): Promise<T> { throw new Error('mutation UoW must not execute for owned list'); },
};
const unusedMutations: ProductCollectionMutationUnitOfWork = {
  async execute<T>(): Promise<T> { throw new Error('mutation UoW must not execute for owned list'); },
};

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function harness(
  rows: ReadonlyArray<OwnedCollectionFact & { owner: 'owner' | 'outsider' }>,
  counts: ReadonlyMap<string, number> = new Map(),
) {
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  let ownedRows: ReadonlyArray<OwnedCollectionFact & { ownerSubjectId: string }> = [];
  const signer = createProductOwnedCollectionsCursorSigner({
    current: { id: 'owned-http-v1', key: 'owned-http-cursor-secret-material-32-bytes' },
  });
  const lookupCalls: Array<ReadonlyArray<{ collectionId: string; contentRevision: string }>> = [];
  const listInputs: Array<{ ownerSubjectId: string }> = [];
  const app = buildApiApp({
    config, identityUnitOfWork: identity, collectionsUnitOfWork: unusedCollections,
    productCollectionMutationUnitOfWork: unusedMutations,
    browserSessionAuthority: factory.authority,
    ownedCollectionsQuery: {
      reads: {
        async listOwnedCollections(input) {
          // Fixture rows only. Do not implement the owner predicate here —
          // owned-only is proven by owned-collections-postgres.integration.test.ts
          // (library-management-acceptance is the named CI owner).
          listInputs.push({ ownerSubjectId: input.ownerSubjectId });
          return ownedRows
            .filter((row) => !input.kind || row.kind === input.kind)
            .filter((row) => !input.visibility || row.visibility === input.visibility)
            .filter((row) => !input.after || row.updatedAt < input.after.updatedAt
              || (row.updatedAt.getTime() === input.after.updatedAt.getTime() && row.id > input.after.id))
            .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
              || left.id.localeCompare(right.id))
            .slice(0, input.limit + 1);
        },
      },
      cursors: signer,
      clock: { now: async () => NOW },
    },
    bookmarkCounts: {
      async lookupBookmarkCounts(entries) {
        lookupCalls.push(entries.map((entry) => ({
          collectionId: entry.collectionId,
          contentRevision: entry.contentRevision,
        })));
        const ids = entries.map((entry) => entry.collectionId);
        if (counts.size === 0) return new Map(ids.map((id) => [id, 0]));
        return counts;
      },
    },
  });
  app.addHook('onClose', async () => signer.destroy());
  apps.push(app);
  const owner = await issueTestSession({ factory,
    subject: 'owner-subject', displayName: 'Owner', handle: 'ownedhttp' });
  const outsider = await issueTestSession({ factory,
    subject: 'outsider-subject', displayName: 'Outsider', handle: 'outsidehttp' });
  const subjectRows = rows.map(({ owner: rowOwner, ...row }) => ({
    ...row,
    ownerSubjectId: rowOwner === 'owner' ? owner.subjectId : outsider.subjectId,
  }));
  ownedRows = subjectRows;
  return { app, owner, outsider, lookupCalls, listInputs };
}

describe('GET /api/v1/collections Product contract', () => {
  test('requires Session, does not require Origin/CSRF, maps a closed no-leak DTO and pages', async () => {
    const { app, owner, lookupCalls } = await harness([
      { ...fact('a', 'owner-subject'), owner: 'owner' },
      { ...fact('b', 'owner-subject'), owner: 'owner' },
    ]);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/collections' });
    assertProductErrorEnvelope(anonymous, 401, 'authentication_required');
    assert.equal(anonymous.headers['cache-control'], 'private, no-store');
    assert.equal(lookupCalls.length, 0);
    assert.equal(JSON.stringify(anonymous.json()).includes('bookmarkCount'), false);

    const first = await app.inject({ method: 'GET', url: '/api/v1/collections?limit=1',
      headers: { cookie: owner.cookie, accept: 'application/json' } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    const body = first.json() as OwnedPageDocument;
    assert.equal(body.page.returnedCount, 1); assert.equal(body.page.hasMore, true); assert.ok(body.page.nextCursor);
    const item = body.items[0]; assert.ok(item);
    assert.deepEqual(Object.keys(item).sort(), ['bookmarkCount', 'capabilities', 'collection']);
    assert.equal(Number.isInteger(item.bookmarkCount) && item.bookmarkCount >= 0, true);
    assert.deepEqual(Object.keys(item.collection).sort(), [
      'allowSearchIndexing','contentEtag','contentRevision','createdAt','etag','id','kind','policyEtag',
      'policyRevision','publicationSlug','publishedAt','revision','rootNodeId','summary','title','updatedAt','visibility',
    ]);
    assert.deepEqual(item.capabilities, { updateCollection: true, managePublication: true,
      createNode: true, updateNode: true, moveNode: true, deleteNode: true });
    assert.equal(JSON.stringify(body).includes('owner-subject'), false);

    const next = await app.inject({ method: 'GET',
      url: `/api/v1/collections?cursor=${encodeURIComponent(body.page.nextCursor)}`,
      headers: { cookie: owner.cookie } });
    assert.equal(next.statusCode, 200); assert.equal((next.json() as OwnedPageDocument).items[0]?.collection.id, 'b');
  });

  test.each([
    'unknown=x', 'limit=', 'kind=', 'visibility=', 'cursor=', 'limit=01', 'limit=1.0',
    'limit=0', 'limit=101', 'limit=1&limit=1', 'limit=1&limit=2', 'cursor=a&cursor=b',
    'cursor=abc&limit=1', 'cursor=abc&kind=bookmarks', 'kind=BOOKMARKS', 'kind=%62ookmarks',
    'limit=1&kind=bookmarks', 'visibility=private&kind=bookmarks',
  ])('rejects non-canonical raw query %s', async (query) => {
    const { app, owner } = await harness([]);
    const response = await app.inject({ method: 'GET', url: `/api/v1/collections?${query}`,
      headers: { cookie: owner.cookie } });
    assertProductErrorEnvelope(response, 400, query.startsWith('cursor=abc') && !query.includes('&')
      ? 'invalid_cursor' : 'invalid_query');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test.each([1, 100])('accepts canonical limit boundary %i', async (limit) => {
    const { app, owner } = await harness([]);
    const response = await app.inject({ method: 'GET', url: `/api/v1/collections?limit=${limit}`,
      headers: { cookie: owner.cookie } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('maps tamper and cross-account cursor to stable invalid_cursor and enforces Accept/method cache', async () => {
    const { app, owner, outsider } = await harness([
      { ...fact('a', 'owner-subject'), owner: 'owner' },
      { ...fact('b', 'owner-subject'), owner: 'owner' },
    ]);
    const first = await app.inject({ method: 'GET', url: '/api/v1/collections?limit=1', headers: { cookie: owner.cookie } });
    const cursor = (first.json() as OwnedPageDocument).page.nextCursor!;
    for (const [cookie, value] of [[outsider.cookie, cursor], [owner.cookie, `${cursor}x`]]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/collections?cursor=${encodeURIComponent(value)}`,
        headers: { cookie } });
      assertProductErrorEnvelope(response, 400, 'invalid_cursor');
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    const unacceptable = await app.inject({ method: 'GET', url: '/api/v1/collections',
      headers: { cookie: owner.cookie, accept: 'text/html' } });
    assertProductErrorEnvelope(unacceptable, 406, 'not_acceptable');
    assert.equal(unacceptable.headers['cache-control'], 'private, no-store');
    const method = await app.inject({ method: 'PUT', url: '/api/v1/collections', headers: { cookie: owner.cookie } });
    assertProductErrorEnvelope(method, 405, 'method_not_allowed');
    assert.equal(method.headers.allow, 'GET, HEAD, POST');
    assert.equal(method.headers['cache-control'], 'private, no-store');
  });

  test('attaches bookmarkCount on every owned list item, including empty Collections', async () => {
    const { app, owner, lookupCalls } = await harness([
      { ...fact('empty', 'owner-subject'), owner: 'owner' },
      { ...fact('filled', 'owner-subject'), owner: 'owner' },
    ], new Map([['filled', 5]]));
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections',
      headers: { cookie: owner.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as OwnedPageDocument;
    assert.deepEqual(lookupCalls, [[{ collectionId: 'empty', contentRevision: 'c-empty' }, { collectionId: 'filled', contentRevision: 'c-filled' }]]);
    const empty = body.items.find((row) => row.collection.id === 'empty');
    const filled = body.items.find((row) => row.collection.id === 'filled');
    assert.ok(empty); assert.ok(filled);
    assert.equal(Object.hasOwn(empty, 'bookmarkCount'), true);
    assert.equal(empty.bookmarkCount, 0);
    assert.equal(filled.bookmarkCount, 5);
    assert.ok(body.items.every((row) => Number.isInteger(row.bookmarkCount) && row.bookmarkCount >= 0));
  });

  test('does not itself drop another owner\'s rows when the query mock returns them', async () => {
    const { app, owner, listInputs } = await harness([
      { ...fact('mine', 'owner-subject'), owner: 'owner' },
      { ...fact('theirs', 'outsider-subject'), owner: 'outsider' },
    ]);
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections',
      headers: { cookie: owner.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as OwnedPageDocument;
    assert.deepEqual(listInputs, [{ ownerSubjectId: owner.subjectId }]);
    assert.deepEqual(Object.keys(body.page).sort(), ['hasMore', 'nextCursor', 'returnedCount']);
    assert.deepEqual(body.items.map((row) => row.collection.id).sort(), ['mine', 'theirs']);
  });

  test('counts one page of authorized ids in a single lookup that carries contentRevision', async () => {
    const { app, owner, lookupCalls } = await harness([
      { ...fact('a', 'owner-subject'), owner: 'owner' },
      { ...fact('b', 'owner-subject'), owner: 'owner' },
    ], new Map([['a', 2], ['b', 9]]));
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections',
      headers: { cookie: owner.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as OwnedPageDocument;
    assert.deepEqual(lookupCalls, [[
      { collectionId: 'a', contentRevision: 'c-a' },
      { collectionId: 'b', contentRevision: 'c-b' },
    ]]);
    assert.deepEqual(body.items.map((row) => [row.collection.id, row.bookmarkCount]), [['a', 2], ['b', 9]]);
  });

  test('lists bookmarkCount from an explicit fake origin without cache composition', async () => {
    const { app, owner, lookupCalls } = await harness([
      { ...fact('memory-origin', 'owner-subject'), owner: 'owner' },
    ], new Map([['memory-origin', 4]]));
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections',
      headers: { cookie: owner.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as OwnedPageDocument).items[0]?.bookmarkCount, 4);
    assert.equal(lookupCalls.length, 1, 'the memory harness must use the fake origin, not a Redis decorator');
  });

  test('malformed percent encoding returns the Product invalid_query envelope', async () => {
    const { app } = await harness([]);
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections?kind=%ZZ' });
    assertProductErrorEnvelope(response, 400, 'invalid_query');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('unknown Product resources retain the private no-store 404 envelope', async () => {
    const { app, owner } = await harness([]);
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections-owned-missing',
      headers: { cookie: owner.cookie } });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('owned list past idle TTL expires; GET /me after touchMinInterval slides idle', async () => {
    const t0 = new Date(NOW);
    const identityState = createIdentityMemoryState(t0);
    const identity = createIdentityMemoryUnitOfWork(identityState);
    const factory = createInMemoryBetterAuthTestFactory({
      identityUnitOfWork: identity,
      sessionExpiresInSeconds: 30 * 24 * 60 * 60,
    });
    const signer = createProductOwnedCollectionsCursorSigner({
      current: { id: 'owned-idle-v1', key: 'owned-idle-cursor-secret-material-32-bytes' },
    });
    const app = buildApiApp({
      config, identityUnitOfWork: identity, collectionsUnitOfWork: unusedCollections,
      productCollectionMutationUnitOfWork: unusedMutations,
      browserSessionAuthority: factory.authority,
      ownedCollectionsQuery: {
        reads: { async listOwnedCollections() { return []; } },
        cursors: signer,
        clock: { now: async () => identityState.now },
      },
      bookmarkCounts: {
        async lookupBookmarkCounts() { return new Map(); },
      },
    });
    app.addHook('onClose', async () => signer.destroy());
    apps.push(app);
    const polling = await issueTestSession({
      factory, subject: 'owned-idle-poll', handle: 'owned_idle_poll',
    });
    const heartbeat = await issueTestSession({
      factory, subject: 'owned-idle-me', handle: 'owned_idle_me',
    });

    identityState.now = new Date(t0.getTime() + SESSION_TOUCH_MIN_INTERVAL_MS);
    const pollAtInterval = await app.inject({
      method: 'GET', url: '/api/v1/collections', headers: { cookie: polling.cookie },
    });
    assert.equal(pollAtInterval.statusCode, 200, pollAtInterval.body);
    const pollingMeta = [...factory.state.metadata.values()].find((row) => row.accountId === polling.accountId);
    assert.ok(pollingMeta);
    assert.equal(pollingMeta.lastSeenAt.getTime(), t0.getTime(), 'owned list GET must not slide last_seen');

    const me = await app.inject({
      method: 'GET', url: '/api/v1/me', headers: { cookie: heartbeat.cookie },
    });
    assert.equal(me.statusCode, 200, me.body);
    const heartbeatMeta = [...factory.state.metadata.values()].find((row) => row.accountId === heartbeat.accountId);
    assert.ok(heartbeatMeta);
    assert.equal(heartbeatMeta.lastSeenAt.getTime(), identityState.now.getTime());
    assert.equal(heartbeatMeta.idleExpiresAt.getTime(), identityState.now.getTime() + SESSION_IDLE_TTL_MS);

    identityState.now = new Date(t0.getTime() + SESSION_IDLE_TTL_MS + 1);
    const pollExpired = await app.inject({
      method: 'GET', url: '/api/v1/collections', headers: { cookie: polling.cookie },
    });
    assert.equal(pollExpired.statusCode, 401, 'owned-list-only past idle TTL must expire');
    assertProductErrorEnvelope(pollExpired, 401, 'authentication_required');

    const stillLive = await app.inject({
      method: 'GET', url: '/api/v1/collections', headers: { cookie: heartbeat.cookie },
    });
    assert.equal(stillLive.statusCode, 200, 'GET /me must have slid idle past the original TTL');
  });
});
