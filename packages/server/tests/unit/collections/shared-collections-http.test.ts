import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createProductSharedCollectionsCursorSigner,
  type CollectionsUnitOfWork,
  type ProductCollectionMutationUnitOfWork,
  type SharedCollectionFact,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';

const NOW = new Date('2026-08-19T08:00:00.000Z');
const ROUTE = '/api/v1/me/shared-collections';
const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/shared_http_test',
  PRODUCT_ORIGIN: 'https://app.example.test', ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
  OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test', LOG_LEVEL: 'silent',
});

interface SharedPageDocument {
  readonly items: ReadonlyArray<{
    readonly collection: { readonly id: string };
    readonly capabilities: Readonly<Record<string, boolean>>;
    readonly bookmarkCount: number;
  }>;
  readonly page: { readonly returnedCount: number; readonly hasMore: boolean; readonly nextCursor: string | null };
}

function fact(id: string, overrides: Partial<SharedCollectionFact> = {}): SharedCollectionFact {
  return {
    id, kind: 'bookmarks', title: `Shared title ${id}`, summary: null, visibility: 'private',
    publicationSlug: null, allowSearchIndexing: false, publishedAt: null,
    rootNodeId: `root-${id}`, resourceRevision: `r-${id}`, contentRevision: `c-${id}`,
    policyRevision: `p-${id}`, createdAt: NOW, updatedAt: NOW,
    ownerSubjectId: 'owner-subject', membershipRole: 'editor',
    ...overrides,
  };
}

const unusedCollections: CollectionsUnitOfWork = {
  async execute<T>(): Promise<T> { throw new Error('mutation UoW must not execute for shared list'); },
};
const unusedMutations: ProductCollectionMutationUnitOfWork = {
  async execute<T>(): Promise<T> { throw new Error('mutation UoW must not execute for shared list'); },
};

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function harness(
  rows: readonly SharedCollectionFact[],
  counts: ReadonlyMap<string, number> = new Map(),
) {
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  let sharedRows: readonly SharedCollectionFact[] = [];
  const signer = createProductSharedCollectionsCursorSigner({
    current: { id: 'shared-http-v1', key: 'shared-http-cursor-secret-material-32-bytes' },
  });
  const lookupCalls: Array<ReadonlyArray<{ collectionId: string; contentRevision: string }>> = [];
  const app = buildApiApp({
    config, identityUnitOfWork: identity, collectionsUnitOfWork: unusedCollections,
    productCollectionMutationUnitOfWork: unusedMutations,
    browserSessionAuthority: factory.authority,
    sharedCollectionsQuery: {
      reads: {
        async listSharedCollections(input) {
          return sharedRows
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
  const member = await issueTestSession({ factory,
    subject: 'member-subject', displayName: 'Member', handle: 'sharedhttp' });
  const viewer = await issueTestSession({ factory,
    subject: 'viewer-subject', displayName: 'Viewer', handle: 'sharedviewer' });
  const editor = await issueTestSession({ factory,
    subject: 'editor-subject', displayName: 'Editor', handle: 'sharededitor' });
  sharedRows = rows;
  return { app, member, viewer, editor, lookupCalls };
}

describe('GET /api/v1/me/shared-collections Product contract', () => {
  test('requires Session and returns private no-store', async () => {
    const { app, lookupCalls } = await harness([]);
    const anonymous = await app.inject({ method: 'GET', url: ROUTE });
    assertProductErrorEnvelope(anonymous, 401, 'authentication_required');
    assert.equal(anonymous.headers['cache-control'], 'private, no-store');
    assert.equal(lookupCalls.length, 0);
    assert.equal(JSON.stringify(anonymous.json()).includes('bookmarkCount'), false);
  });

  test.each(['x=1', 'unknown=x'])('rejects unknown query %s with invalid_query', async (query) => {
    const { app, member } = await harness([]);
    const response = await app.inject({ method: 'GET', url: `${ROUTE}?${query}`,
      headers: { cookie: member.cookie } });
    assertProductErrorEnvelope(response, 400, 'invalid_query');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('rejects cursor + limit together as invalid_query', async () => {
    const { app, member } = await harness([]);
    const response = await app.inject({ method: 'GET', url: `${ROUTE}?limit=1&cursor=abc`,
      headers: { cookie: member.cookie } });
    assertProductErrorEnvelope(response, 400, 'invalid_query');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('rejects unacceptable Accept with 406 not_acceptable', async () => {
    const { app, member } = await harness([]);
    const response = await app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: member.cookie, accept: 'text/html' } });
    assertProductErrorEnvelope(response, 406, 'not_acceptable');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('200 empty page shape is closed and no-store', async () => {
    const { app, member } = await harness([]);
    const response = await app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: member.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const body = response.json() as SharedPageDocument;
    assert.deepEqual(Object.keys(body).sort(), ['items', 'page']);
    assert.deepEqual(body.items, []);
    assert.deepEqual(body.page, { returnedCount: 0, hasMore: false, nextCursor: null });
  });

  test('maps a shared editor row without owner capabilities', async () => {
    const { app, member } = await harness([fact('shared-1')]);
    const response = await app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: member.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as SharedPageDocument;
    assert.equal(body.items[0]?.collection.id, 'shared-1');
    assert.deepEqual(Object.keys(body.items[0]!).sort(), ['bookmarkCount', 'capabilities', 'collection']);
    assert.equal(Number.isInteger(body.items[0]!.bookmarkCount) && body.items[0]!.bookmarkCount >= 0, true);
    assert.equal(body.items[0]?.capabilities.createNode, true);
    assert.equal(body.items[0]?.capabilities.managePublication, false);
    assert.equal(JSON.stringify(body).includes('owner-subject'), false);
  });

  test('empty shared Collection still returns bookmarkCount 0', async () => {
    const { app, member } = await harness([fact('empty-shared')], new Map());
    const response = await app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: member.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    const item = (response.json() as SharedPageDocument).items[0];
    assert.ok(item);
    assert.equal(Object.hasOwn(item, 'bookmarkCount'), true);
    assert.equal(item.bookmarkCount, 0);
  });

  test('counts one page of authorized ids in a single lookup that carries contentRevision', async () => {
    const { app, member, lookupCalls } = await harness([
      fact('shared-a'), fact('shared-b'),
    ], new Map([['shared-a', 4], ['shared-b', 11]]));
    const response = await app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: member.cookie, accept: 'application/json' } });
    assert.equal(response.statusCode, 200);
    const body = response.json() as SharedPageDocument;
    assert.deepEqual(lookupCalls, [[
      { collectionId: 'shared-a', contentRevision: 'c-shared-a' },
      { collectionId: 'shared-b', contentRevision: 'c-shared-b' },
    ]]);
    assert.ok(body.items.every((row) => Number.isInteger(row.bookmarkCount) && row.bookmarkCount >= 0));
    assert.deepEqual(body.items.map((row) => [row.collection.id, row.bookmarkCount]),
      [['shared-a', 4], ['shared-b', 11]]);
  });

  test('viewer and editor see the same bookmarkCount for the same shared Collection', async () => {
    const counts = new Map([['shared-same', 17]]);
    const editorApp = await harness([fact('shared-same', { membershipRole: 'editor' })], counts);
    const viewerApp = await harness([fact('shared-same', { membershipRole: 'viewer' })], counts);
    const editorResponse = await editorApp.app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: editorApp.editor.cookie, accept: 'application/json' } });
    const viewerResponse = await viewerApp.app.inject({ method: 'GET', url: ROUTE,
      headers: { cookie: viewerApp.viewer.cookie, accept: 'application/json' } });
    assert.equal(editorResponse.statusCode, 200);
    assert.equal(viewerResponse.statusCode, 200);
    const editorItem = (editorResponse.json() as SharedPageDocument).items[0];
    const viewerItem = (viewerResponse.json() as SharedPageDocument).items[0];
    assert.equal(editorItem?.bookmarkCount, 17);
    assert.equal(viewerItem?.bookmarkCount, 17);
    assert.equal(editorItem?.capabilities.createNode, true);
    assert.equal(viewerItem?.capabilities.createNode, false);
  });
});
