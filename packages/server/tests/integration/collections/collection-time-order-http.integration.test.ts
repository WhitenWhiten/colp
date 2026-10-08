/**
 * FO-05 `listCollectionChildren` Product HTTP (real PostgreSQL + real bootstrap
 * composition). Covers:
 *
 *   listCollectionChildren  GET /api/v1/collections/{collectionId}/children
 *
 * - same created_at values sort by stable ascending id and stay stable across
 *   continuation pages
 * - folder scope / root / parent-child relations preserved (one layer only)
 * - multi-page paging incl. a byte-budget (65536) short page with correct
 *   nextCursor and no truncation
 * - sort switches own independent cursors; old/mismatched cursors rejected
 * - reading (curated/created) never writes: position tokens, revisions, sync
 *   logs and the reading path stay identical before/after
 * - visibility: owner, shared member, anonymous public, conceal/deny,
 *   flag-off 404
 * - error query combinations (bad limit, unknown sort, duplicate query,
 *   non-empty body, cursor+limit mismatch, invalid parent, stale cursors)
 *
 * Success bodies are validated with hand-written contract validators in this
 * file (never shared with the implementation).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionChildrenReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import {
  createCollectionChildrenCursorSigner,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS,
  PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
} from '../../../src/modules/collections/index.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const CURSOR_KEY = Buffer.alloc(32, 42).toString('base64url');
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

const COLLECTION = 'fo05-collection-main-0001';
const ROOT = 'fo05-root-main-node-000001';
// Curated positions + creation times. Time ties are exact (same ms); node ids
// are chosen so that within a tie the expected ascending-id order holds
// ('fo05-node-a-folder...' < 'fo05-node-z-bookmark...', 000002 < 000003).
const F1 = 'fo05-node-a-folder-00000001';
const B1 = 'fo05-node-z-bookmark-000001';
const B2 = 'fo05-node-z-bookmark-000002';
const B3 = 'fo05-node-z-bookmark-000003';
const F2 = 'fo05-node-b-folder-00000002';
const DEEP = 'fo05-node-deep-000000001';

interface ChildSeed {
  readonly id: string;
  readonly parent: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly url: string | null;
  readonly position: string;
  readonly createdAt: string;
}

const CHILDREN: readonly ChildSeed[] = [
  { id: F1, parent: ROOT, kind: 'folder', title: 'Folder One', url: null, position: 'A1', createdAt: '2026-09-14T00:00:00.000Z' },
  { id: B1, parent: ROOT, kind: 'bookmark', title: 'Bookmark One', url: 'https://one.example.test/a', position: 'A3', createdAt: '2026-09-14T00:00:00.000Z' },
  { id: B2, parent: ROOT, kind: 'bookmark', title: 'Bookmark Two', url: 'https://two.example.test/a', position: 'A5', createdAt: '2026-09-14T00:00:01.000Z' },
  { id: B3, parent: ROOT, kind: 'bookmark', title: 'Bookmark Three', url: 'https://three.example.test/a', position: 'A2', createdAt: '2026-09-14T00:00:01.000Z' },
  { id: F2, parent: ROOT, kind: 'folder', title: 'Folder Two', url: null, position: 'A4', createdAt: '2026-09-14T00:00:02.000Z' },
];
/** Nested child of Folder One — must never appear in the root layer. */
const DEEP_SEED: ChildSeed = {
  id: DEEP, parent: F1, kind: 'bookmark', title: 'Deep Bookmark',
  url: 'https://deep.example.test/a', position: 'D1', createdAt: '2026-09-14T00:00:03.000Z',
};

/** curated = position order; the two created orders differ from it and each other. */
const CURATED_ORDER = [F1, B3, B1, F2, B2];
const CREATED_ASC_ORDER = [F1, B1, B2, B3, F2];
const CREATED_DESC_ORDER = [F2, B2, B3, F1, B1];

interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
}

describeWithPostgres('FO-05 collection children time-order Product HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let sharedViewer: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let stranger: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo05_children', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_FAVICON_POLICY: 'true',
      FAVICON_CURSOR_HMAC_KEY: CURSOR_KEY,
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory,
      subject: `fo05-owner-${randomUUID()}`, handle: `fo5o${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    sharedViewer = await issueTestSession({ factory,
      subject: `fo05-viewer-${randomUUID()}`, handle: `fo5v${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    stranger = await issueTestSession({ factory,
      subject: `fo05-stranger-${randomUUID()}`, handle: `fo5s${randomUUID().replaceAll('-', '').slice(0, 12)}` });
    await seedCollection(isolated, COLLECTION, ROOT, owner.subjectId, 'bookmarks', 'private', '7');
    for (const child of CHILDREN) {
      await insertLiveNode(isolated, COLLECTION, child);
    }
    await insertLiveNode(isolated, COLLECTION, DEEP_SEED);
    // A shared viewer (read-only) has permission to read the collection.
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1, $2, 'viewer', now())`,
      [COLLECTION, sharedViewer.subjectId],
    );
  }, 180_000);
  afterAll(async () => isolated?.close());

  function buildApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
    return buildApiApp({
      config: { ...config, ...overrides },
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        isolated.runtime.db, { productOrigin: ORIGIN }),
      collectionChildrenReadUnitOfWork: createPostgresCollectionChildrenReadUnitOfWork(
        isolated.runtime.db, {
          cursorSigner: createCollectionChildrenCursorSigner(config.faviconPolicy.cursorHmacKey),
          productOrigin: ORIGIN,
        }),
      browserSessionAuthority: factory.authority,
    });
  }

  function childrenUrl(address: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query);
    const suffix = params.size > 0 ? `?${params}` : '';
    return `${address}/api/v1/collections/${COLLECTION}/children${suffix}`;
  }

  test('curated default: canonical position order, one live layer only', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await api('GET', childrenUrl(address), { cookie: owner.cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      const page = assertChildrenPage(response.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'curated', itemCount: 5 });
      assert.deepEqual(page.items.map((item) => item.id), CURATED_ORDER);
      assert.equal(page.nextCursor, null, 'curated default has no continuation');
      // position mirrors the canonical tokens exactly; deep folder scope held.
      assert.deepEqual(page.items.map((item) => item.position), ['A1', 'A2', 'A3', 'A4', 'A5']);
      assert.ok(page.items.every((item) => item.parentId === ROOT));
      assert.equal(page.items.some((item) => item.id === DEEP), false, 'no nested flattening');
      const responseDeep = await api('GET', childrenUrl(address, { parentId: F1 }),
        { cookie: owner.cookie });
      assert.equal(responseDeep.status, 200);
      const deepPage = assertChildrenPage(responseDeep.json,
        { collectionId: COLLECTION, parentId: F1, sort: 'curated', itemCount: 1 });
      assert.deepEqual(deepPage.items.map((item) => item.id), [DEEP]);
    } finally { await app.close(); }
  });

  test('created_asc: same created_at ties resolve by ascending id and stay stable across pages', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const page1 = await api('GET', childrenUrl(address, { sort: 'created_asc', limit: '2' }), { cookie: owner.cookie });
      assert.equal(page1.status, 200);
      const first = assertChildrenPage(page1.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 });
      // Tie at 00:00:00: folder id < bookmark id => folder first, id ascending.
      assert.deepEqual(first.items.map((item) => item.id), CREATED_ASC_ORDER.slice(0, 2));
      assert.equal(first.items[0]?.position, 'A1');
      assert.equal(first.items[1]?.position, 'A3');
      assert.ok(typeof first.nextCursor === 'string' && CURSOR_PATTERN.test(first.nextCursor));

      const page2 = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: first.nextCursor ?? '' }),
        { cookie: owner.cookie });
      assert.equal(page2.status, 200);
      const second = assertChildrenPage(page2.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 });
      assert.deepEqual(second.items.map((item) => item.id), CREATED_ASC_ORDER.slice(2, 4));

      const page3 = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: second.nextCursor ?? '' }),
        { cookie: owner.cookie });
      assert.equal(page3.status, 200);
      const third = assertChildrenPage(page3.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 1 });
      assert.deepEqual(third.items.map((item) => item.id), CREATED_ASC_ORDER.slice(4));
      assert.equal(third.nextCursor, null, 'nextCursor is null at the end, never missing');

      const collected = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      assert.deepEqual(collected, CREATED_ASC_ORDER, 'continuation pages keep the exact stable order');
    } finally { await app.close(); }
  });

  test('created_desc: descending time with same-value ties still ascending by id', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await api('GET', childrenUrl(address, { sort: 'created_desc' }), { cookie: owner.cookie });
      assert.equal(response.status, 200);
      const page = assertChildrenPage(response.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_desc', itemCount: 5 });
      assert.deepEqual(page.items.map((item) => item.id), CREATED_DESC_ORDER);
      // t2, then t1 ties (id ascending), then t0 ties (id ascending).
      assert.equal(page.items[0]?.id, F2);
      assert.equal(page.items[1]?.id, B2);
      assert.equal(page.items[2]?.id, B3);
      assert.equal(page.items[3]?.id, F1);
      assert.equal(page.items[4]?.id, B1);
    } finally { await app.close(); }
  });

  test('byte-budget short page returns a correct nextCursor and never truncates', async () => {
    const fatCollection = 'fo05-collection-fat-0000001';
    const fatRoot = 'fo05-root-fat-node-000001';
    await seedCollection(isolated, fatCollection, fatRoot, owner.subjectId, 'bookmarks', 'private', '9');
    for (let i = 0; i < 5; i += 1) {
      await insertLiveNode(isolated, fatCollection, {
        id: `fo05-fat-node-000000${i + 1}`,
        parent: fatRoot, kind: 'bookmark', title: `Fat bookmark ${i}`,
        url: `https://fat${i}.example.test/x`, position: `F${i + 1}`,
        createdAt: '2026-09-14T00:00:00.000Z',
        description: 'D'.repeat(16_384),
      });
    }
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const url = `${address}/api/v1/collections/${fatCollection}/children`;
      const page1 = await api('GET', `${url}?sort=created_asc`, { cookie: owner.cookie });
      assert.equal(page1.status, 200);
      const first = assertChildrenPage(page1.json, { collectionId: fatCollection, parentId: fatRoot, sort: 'created_asc', itemCount: null });
      assert.ok(first.items.length >= 1 && first.items.length < 5, 'byte budget produces a short page');
      assert.ok(first.nextCursor !== null, 'short page must keep nextCursor');
      assert.ok(Buffer.byteLength(JSON.stringify(page1.json), 'utf8') <= 65_536);

      // Continue until the end; every item must be seen exactly once.
      const seen: string[] = [...first.items.map((item) => item.id)];
      let cursor: string | null = first.nextCursor;
      while (cursor !== null) {
        const next = await api('GET', `${url}?sort=created_asc&cursor=${encodeURIComponent(cursor)}`,
          { cookie: owner.cookie });
        assert.equal(next.status, 200);
        const page = assertChildrenPage(next.json, { collectionId: fatCollection, parentId: fatRoot, sort: 'created_asc', itemCount: null });
        assert.ok(Buffer.byteLength(JSON.stringify(next.json), 'utf8') <= 65_536);
        assert.equal(new Set(page.items.map((item) => item.id)).size, page.items.length);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      }
      assert.equal(seen.length, 5, 'no item is dropped or duplicated across byte-limited pages');
      assert.equal(new Set(seen).size, 5);
    } finally { await app.close(); }
  });

  test('sort switches own independent cursors; mismatched/old cursors are 400 invalid_cursor', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const asc = await api('GET', childrenUrl(address, { sort: 'created_asc', limit: '2' }), { cookie: owner.cookie });
      const ascCursor = assertChildrenPage(asc.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 }).nextCursor;
      assert.ok(ascCursor !== null);

      // Using the created_asc cursor under created_desc is a factor mismatch.
      const desc = await api('GET', childrenUrl(address, { sort: 'created_desc', cursor: ascCursor ?? '' }),
        { cookie: owner.cookie });
      assert.equal(desc.status, 400);
      assertProductError(desc.json, ['invalid_cursor'], 'restart_from_first_page');

      // Changing the parent is a factor mismatch.
      const otherParent = await api('GET',
        childrenUrl(address, { sort: 'created_asc', cursor: ascCursor ?? '', parentId: F1 }),
        { cookie: owner.cookie });
      assert.equal(otherParent.status, 400);
      assertProductError(otherParent.json, ['invalid_cursor'], 'restart_from_first_page');

      // A viewer-scope mismatch (sharedViewer's cookie with the owner's cursor).
      const foreignViewer = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: ascCursor ?? '' }),
        { cookie: sharedViewer.cookie });
      assert.equal(foreignViewer.status, 400);
      assertProductError(foreignViewer.json, ['invalid_cursor'], 'restart_from_first_page');

      // A tampered cursor is 400 invalid_cursor.
      const tampered = `${(ascCursor ?? '').slice(0, -1)}${ascCursor?.endsWith('A') ? 'B' : 'A'}`;
      const tamperedPage = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: tampered }),
        { cookie: owner.cookie });
      assert.equal(tamperedPage.status, 400);
      assertProductError(tamperedPage.json, ['invalid_cursor'], 'restart_from_first_page');

      // Reusing the same cursor with the same factors still works.
      const replay = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: ascCursor ?? '' }),
        { cookie: owner.cookie });
      assert.equal(replay.status, 200);
    } finally { await app.close(); }
  });

  test('validly-signed expired cursor is 409 snapshot_expired', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const signer = createCollectionChildrenCursorSigner(CURSOR_KEY);
      const issued = new Date(Date.now() - (PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS + 60_000));
      const expired = signer.sign({
        v: PRODUCT_COLLECTION_CHILDREN_CURSOR_VERSION,
        purpose: PRODUCT_COLLECTION_CHILDREN_CURSOR_PURPOSE,
        viewer: `account:${owner.subjectId}`,
        collectionId: COLLECTION,
        parentId: '',
        sort: 'created_asc',
        limit: 2,
        contentRevision: '7',
        after: { nodeId: B1, positionKey: 'A3', createdAt: '2026-09-14T00:00:00.000Z' },
        issuedAt: issued.toISOString(),
        expiresAt: new Date(issued.getTime() + PRODUCT_COLLECTION_CHILDREN_CURSOR_TTL_MS).toISOString(),
      });
      const response = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: expired }),
        { cookie: owner.cookie });
      assert.equal(response.status, 409);
      assertProductError(response.json, ['snapshot_expired'], 'restart_from_first_page');
    } finally { await app.close(); }
  });

  test('a content revision change expires the continuation with 409 snapshot_expired', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const asc = await api('GET', childrenUrl(address, { sort: 'created_asc', limit: '2' }), { cookie: owner.cookie });
      const cursor = assertChildrenPage(asc.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 }).nextCursor;
      assert.ok(cursor !== null);
      // A canonical write would advance content_revision; emulate exactly that.
      await isolated.runtime.pool.query(
        `update collections set content_revision = '8', commit_ordinal = commit_ordinal + 1 where id = $1`,
        [COLLECTION],
      );
      try {
        const stale = await api('GET', childrenUrl(address, { sort: 'created_asc', cursor: cursor ?? '' }),
          { cookie: owner.cookie });
        assert.equal(stale.status, 409);
        assertProductError(stale.json, ['snapshot_expired'], 'restart_from_first_page');
      } finally {
        await isolated.runtime.pool.query(
          `update collections set content_revision = '7', commit_ordinal = commit_ordinal - 1 where id = $1`,
          [COLLECTION],
        );
      }
    } finally { await app.close(); }
  });

  test('reading_path collections keep the curated order: created sorts are 400 invalid_query', async () => {
    const pathCollection = 'fo05-collection-path-00001';
    const pathRoot = 'fo05-root-path-node-00001';
    await seedCollection(isolated, pathCollection, pathRoot, owner.subjectId, 'reading_path', 'private', '3');
    await insertLiveNode(isolated, pathCollection, {
      id: 'fo05-path-a-000000000001', parent: pathRoot, kind: 'bookmark', title: 'Step A',
      url: 'https://a.example.test/x', position: 'P1', createdAt: '2026-09-14T00:00:00.000Z',
    });
    await insertLiveNode(isolated, pathCollection, {
      id: 'fo05-path-b-000000000001', parent: pathRoot, kind: 'bookmark', title: 'Step B',
      url: 'https://b.example.test/x', position: 'P2', createdAt: '2026-09-14T00:00:01.000Z',
    });
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const curated = await api('GET', `${address}/api/v1/collections/${pathCollection}/children`, { cookie: owner.cookie });
      assert.equal(curated.status, 200);
      const page = assertChildrenPage(curated.json, { collectionId: pathCollection, parentId: pathRoot, sort: 'curated', itemCount: 2 });
      assert.deepEqual(page.items.map((item) => item.position), ['P1', 'P2']);
      for (const bad of ['created_asc', 'created_desc']) {
        const rejected = await api('GET',
          `${address}/api/v1/collections/${pathCollection}/children?sort=${bad}`, { cookie: owner.cookie });
        assert.equal(rejected.status, 400, `sort=${bad} must be rejected for reading_path`);
        assertProductError(rejected.json, ['invalid_query']);
      }
      // Readings never wrote anything: the curated path order is unchanged.
      const again = await api('GET', `${address}/api/v1/collections/${pathCollection}/children`, { cookie: owner.cookie });
      assert.deepEqual(assertChildrenPage(again.json, { collectionId: pathCollection, parentId: pathRoot, sort: 'curated', itemCount: 2 }).items
        .map((item) => item.position), ['P1', 'P2']);
    } finally { await app.close(); }
  });

  test('reading never writes: position tokens, revisions, sync/operation logs unchanged', async () => {
    const before = await snapshotWriteState(isolated, COLLECTION);
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      for (const sort of ['curated', 'created_asc', 'created_desc']) {
        let cursor: string | null = null;
        for (let page = 0; page < 4; page += 1) {
          const query: Record<string, string> = { sort };
          if (cursor !== null) query.cursor = cursor;
          const response = await api('GET', childrenUrl(address, query), { cookie: owner.cookie });
          assert.equal(response.status, 200);
          const body = assertChildrenPage(response.json, { collectionId: COLLECTION, parentId: ROOT, sort, itemCount: null });
          cursor = body.nextCursor;
          if (cursor === null) break;
        }
      }
    } finally { await app.close(); }
    const after = await snapshotWriteState(isolated, COLLECTION);
    assert.deepEqual(after.nodes, before.nodes, 'node position tokens/revisions must not change');
    assert.deepEqual(after.collection, before.collection, 'collection fences must not change');
    assert.deepEqual(after.operationCount, before.operationCount, 'no canonical operation may be appended');
    assert.deepEqual(after.auditCount, before.auditCount, 'no audit event may be appended');
  });

  test('visibility: owner, shared viewer, anonymous + signed-in public reads, conceal, flag-off 404', async () => {
    const publicCollection = 'fo05-collection-public-001';
    const publicRoot = 'fo05-root-public-node-001';
    await seedCollection(isolated, publicCollection, publicRoot, owner.subjectId, 'bookmarks', 'public', '5');
    await insertLiveNode(isolated, publicCollection, {
      id: 'fo05-public-mark-00000001', parent: publicRoot, kind: 'bookmark', title: 'Public mark',
      url: 'https://pub.example.test/x', position: 'P1', createdAt: '2026-09-14T00:00:00.000Z',
    });
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = (id: string) => `${address}/api/v1/collections/${id}/children`;
    try {
      // owner (private collection) — 200.
      const ownerPage = await api('GET', childrenUrl(address), { cookie: owner.cookie });
      assert.equal(ownerPage.status, 200);
      // shared viewer (private collection, member) — 200.
      const viewerPage = await api('GET', childrenUrl(address), { cookie: sharedViewer.cookie });
      assert.equal(viewerPage.status, 200);
      // stranger (private, no membership) — concealed 404.
      const strangerPage = await api('GET', childrenUrl(address), { cookie: stranger.cookie });
      assert.equal(strangerPage.status, 404);
      assertProductError(strangerPage.json, ['resource_not_found']);
      // anonymous on private — concealed 404.
      const anonPrivate = await api('GET', childrenUrl(address), {});
      assert.equal(anonPrivate.status, 404);

      // anonymous on public — 200 with the children layer.
      const anonPublic = await api('GET', `${base(publicCollection)}`, {});
      assert.equal(anonPublic.status, 200);
      assertChildrenPage(anonPublic.json, { collectionId: publicCollection, parentId: publicRoot, sort: 'curated', itemCount: 1 });

      // logged-in non-member on public — 200 like every other public surface:
      // signed-in visitors and anonymous share the same readable bytes.
      const strangerPublic = await api('GET', `${base(publicCollection)}`, { cookie: stranger.cookie });
      assert.equal(strangerPublic.status, 200);
      assertChildrenPage(strangerPublic.json, { collectionId: publicCollection, parentId: publicRoot, sort: 'curated', itemCount: 1 });

      // anonymous on unlisted/protected — conceal 404; missing ids look the same.
      for (const visibility of ['unlisted', 'protected']) {
        const hidden = `fo05-collection-hidden-${visibility}`;
        const hiddenRoot = `fo05-root-hidden-${visibility}`;
        await seedCollection(isolated, hidden, hiddenRoot, owner.subjectId, 'bookmarks', visibility, '6');
        const anonHidden = await api('GET', `${base(hidden)}`, {});
        assert.equal(anonHidden.status, 404, `${visibility} anonymous read must conceal`);
      }
      const missing = await api('GET', `${base('fo05-no-such-collection-1')}`, {});
      assert.equal(missing.status, 404);
      const missingOwner = await api('GET', `${base('fo05-no-such-collection-1')}`, { cookie: owner.cookie });
      assert.equal(missingOwner.status, 404);

      // Flag off: every request is 404.
      const flagOff = buildApp({ faviconPolicy: { ...config.faviconPolicy, enabled: false } });
      const offAddress = await flagOff.listen({ host: '127.0.0.1', port: 0 });
      try {
        const off = await api('GET', childrenUrl(offAddress), { cookie: owner.cookie });
        assert.equal(off.status, 404);
        const offAnon = await api('GET', `${offAddress}/api/v1/collections/${publicCollection}/children`, {});
        assert.equal(offAnon.status, 404);
      } finally { await flagOff.close(); }
    } finally { await app.close(); }
  });

  test('FO-08 node-level faviconCdnAllowed: explicit none bookmarks opt out in every /children view', async () => {
    const publicCollection = 'fo05-collection-cdn-00001';
    const publicRoot = 'fo05-root-cdn-node-00001';
    await seedCollection(isolated, publicCollection, publicRoot, owner.subjectId, 'bookmarks', 'public', '8');
    const NONE_NODE = 'fo05-cdn-none-mark-00001';
    const OK_NODE = 'fo05-cdn-ok-mark-000001';
    await insertLiveNode(isolated, publicCollection, {
      id: NONE_NODE, parent: publicRoot, kind: 'bookmark', title: 'Opted out',
      url: 'https://optout.example.test/x', position: 'C1', createdAt: '2026-09-14T00:00:00.000Z',
    });
    await insertLiveNode(isolated, publicCollection, {
      id: OK_NODE, parent: publicRoot, kind: 'bookmark', title: 'Online mark',
      url: 'https://ok.example.test/x', position: 'C2', createdAt: '2026-09-14T00:00:01.000Z',
    });
    // The owner explicitly set the first bookmark's icon source to none
    // (the Product DELETE path); the second node stays virtual inherit.
    await isolated.runtime.pool.query(
      `insert into bookmark_icon_sources(node_id, collection_id, source_mode, revision, updated_at)
       values ($1, $2, 'none', 2, now())`,
      [NONE_NODE, publicCollection]);

    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const base = `${address}/api/v1/collections/${publicCollection}/children`;
      for (const sort of ['curated', 'created_desc']) {
        const response = await api('GET', `${base}?sort=${sort}`, {});
        assert.equal(response.status, 200, `${sort} anonymous public read`);
        const page = assertChildrenPage(response.json,
          { collectionId: publicCollection, parentId: publicRoot, sort, itemCount: 2 });
        const byId = new Map(page.items.map((item) => [item.id, item]));
        assert.equal(byId.get(NONE_NODE)?.faviconCdnAllowed, false,
          `explicit none bookmark must never be CDN-hotlinked under sort=${sort}`);
        assert.equal(byId.get(OK_NODE)?.faviconCdnAllowed, true,
          `other public bookmarks keep the collection-level CDN fact under sort=${sort}`);
      }
      // Signed-in non-member gets the same bytes (public surface).
      const member = await api('GET', `${base}?sort=created_desc`, { cookie: stranger.cookie });
      assert.equal(member.status, 200);
      const memberPage = assertChildrenPage(member.json,
        { collectionId: publicCollection, parentId: publicRoot, sort: 'created_desc', itemCount: 2 });
      assert.equal(
        memberPage.items.find((item) => item.id === NONE_NODE)?.faviconCdnAllowed, false,
        'a logged-in visitor sees the same opt-out');

      // A PRIVATE collection gates the CDN off like the public snapshot does:
      // bookmark nodes carry the false gate, folders never carry the field.
      const priv = await api('GET', childrenUrl(address, { sort: 'created_desc' }), { cookie: owner.cookie });
      assert.equal(priv.status, 200);
      const privPage = assertChildrenPage(priv.json,
        { collectionId: COLLECTION, parentId: ROOT, sort: 'created_desc', itemCount: 5 });
      for (const item of privPage.items) {
        if (item.kind === 'bookmark') {
          assert.equal(item.faviconCdnAllowed, false,
            'non-public bookmark nodes must never allow the third-party CDN');
        } else {
          assert.equal(item.faviconCdnAllowed, undefined,
            'folder nodes never carry the node-level CDN field');
        }
      }
    } finally { await app.close(); }
  });

  test('pinned bookmarks say so in every /children sort; other nodes omit the field', async () => {
    const pinnedCollection = 'fo05-collection-pin-00001';
    const pinnedRoot = 'fo05-root-pin-node-00001';
    await seedCollection(isolated, pinnedCollection, pinnedRoot, owner.subjectId, 'bookmarks', 'public', '8');
    const PINNED = 'fo05-pin-pinned-mark-001';
    const OTHER = 'fo05-pin-other-mark-0001';
    await insertLiveNode(isolated, pinnedCollection, {
      id: PINNED, parent: pinnedRoot, kind: 'bookmark', title: 'Pinned',
      url: 'https://pinned.example.test/x', position: 'C1', createdAt: '2026-09-14T00:00:00.000Z',
    });
    await insertLiveNode(isolated, pinnedCollection, {
      id: OTHER, parent: pinnedRoot, kind: 'bookmark', title: 'Other',
      url: 'https://other.example.test/x', position: 'C2', createdAt: '2026-09-14T00:00:01.000Z',
    });
    // Only the pin namespace is read here, so a minimal backfilled payload stands in for the full one.
    await isolated.runtime.pool.query(`update nodes set payload_json = $2::jsonb, payload_schema_version = 1,
       payload_authority_status = 'backfilled' where id = $1`,
      [PINNED, JSON.stringify({ extensions: { 'https://known.example/extensions/bookmark-pin-v1': { pinned: true } } })]);

    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      for (const sort of ['curated', 'created_asc', 'created_desc']) {
        const response = await api('GET', `${address}/api/v1/collections/${pinnedCollection}/children?sort=${sort}`, {});
        assert.equal(response.status, 200, `${sort} anonymous public read`);
        assertChildrenPage(response.json, { collectionId: pinnedCollection, parentId: pinnedRoot, sort, itemCount: 2 });
        const items = (response.json as { items: Array<Record<string, unknown>> }).items;
        assert.equal(items.find((item) => item.id === PINNED)?.pinned, true, `pinned bookmark under sort=${sort}`);
        assert.equal('pinned' in items.find((item) => item.id === OTHER)!, false, `unpinned bookmark under sort=${sort}`);
      }
    } finally { await app.close(); }
  });

  test('error combinations: bad sort/limit/parent, cursor+limit, duplicate query, unknown query, non-empty body', async () => {
    const app = buildApp();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const base = childrenUrl(address);
    try {
      // Unknown / malformed sort.
      for (const sort of ['by_hand', 'created', '']) {
        const response = await api('GET', `${base}?sort=${sort}`, { cookie: owner.cookie });
        assert.equal(response.status, 400, `sort=${JSON.stringify(sort)} must be rejected`);
        assertProductError(response.json, ['invalid_query']);
      }
      // Bad limit values.
      for (const limit of ['0', '101', '-1', 'abc', '1.5', '99999999999999999999']) {
        const response = await api('GET', `${base}?limit=${limit}`, { cookie: owner.cookie });
        assert.equal(response.status, 400, `limit=${limit} must be rejected`);
        assertProductError(response.json, ['invalid_query']);
      }
      // Missing limit uses the contract default of 50.
      const noLimit = await api('GET', `${base}?sort=created_asc`, { cookie: owner.cookie });
      assert.equal(noLimit.status, 200);
      assert.equal(assertChildrenPage(noLimit.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 5 }).items.length, 5);

      // F-B2: a continuation may echo the first-page limit together with the
      // cursor (the cursor binds the limit) — a matching echo returns the
      // same page; a different limit is 400 invalid_cursor, never a silent
      // page-size change.
      const asc = await api('GET', `${base}?sort=created_asc&limit=2`, { cookie: owner.cookie });
      const first = assertChildrenPage(asc.json, { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 });
      const cursor = first.nextCursor;
      assert.ok(cursor !== null, 'limit=2 first page must issue a nextCursor');
      const expectedPage2 = await api('GET', `${base}?sort=created_asc&cursor=${encodeURIComponent(cursor)}`,
        { cookie: owner.cookie });
      assert.equal(expectedPage2.status, 200);
      const expectedItems = assertChildrenPage(expectedPage2.json,
        { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 }).items
        .map((item) => item.id);
      const echo = await api('GET', `${base}?sort=created_asc&limit=2&cursor=${encodeURIComponent(cursor)}`,
        { cookie: owner.cookie });
      assert.equal(echo.status, 200, JSON.stringify(echo.json));
      const echoed = assertChildrenPage(echo.json,
        { collectionId: COLLECTION, parentId: ROOT, sort: 'created_asc', itemCount: 2 });
      assert.deepEqual(echoed.items.map((item) => item.id), expectedItems,
        'echoing the first-page limit with the cursor returns the same continuation page');
      const mismatch = await api('GET', `${base}?sort=created_asc&limit=3&cursor=${encodeURIComponent(cursor)}`,
        { cookie: owner.cookie });
      assert.equal(mismatch.status, 400);
      assertProductError(mismatch.json, ['invalid_cursor'], 'restart_from_first_page');

      // parentId must be a live folder in this collection.
      const bookmarkParent = await api('GET', `${base}?parentId=${B1}`, { cookie: owner.cookie });
      assert.equal(bookmarkParent.status, 400);
      assertProductError(bookmarkParent.json, ['invalid_query']);
      const missingParent = await api('GET', `${base}?parentId=fo05-no-such-node-00001`, { cookie: owner.cookie });
      assert.equal(missingParent.status, 400);
      assertProductError(missingParent.json, ['invalid_query']);

      // Duplicate single-valued query keys are rejected.
      const duplicate = await api('GET', `${base}?parentId=${F1}&parentId=${F2}`,
        { cookie: owner.cookie });
      assert.equal(duplicate.status, 400);
      assertProductError(duplicate.json, ['invalid_query']);

      // Unknown query parameter rejected.
      const unknown = await api('GET', `${base}?unknown=1`, { cookie: owner.cookie });
      assert.equal(unknown.status, 400);
      assertProductError(unknown.json, ['invalid_query']);

      // Non-empty body on a GET is rejected. This is rejected at the
      // framework boundary (Fastify refuses bodies on GET before the handler),
      // with the identical platform envelope the FO-01..04 GET surfaces
      // produce; the contract requirement is the 400 rejection.
      const withBody = await api('GET', `${base}`, { cookie: owner.cookie, body: {}, contentType: 'application/json' });
      assert.equal(withBody.status, 400);

      // Malformed query encoding is 400 invalid_query.
      const malformed = await api('GET', `${base}?sort=%zz`, { cookie: owner.cookie });
      assert.equal(malformed.status, 400);

      // HEAD is not exposed on the new GET (exposeHeadRoute=false): the
      // enabled known path answers 405 method_not_allowed, never an
      // accidental auto-HEAD success.
      const head = await api('HEAD', `${base}?sort=created_asc`, { cookie: owner.cookie });
      assert.equal(head.status, 405);
    } finally { await app.close(); }
  });
});

// ---------------------------------------------------------------------------
// Contract validators (hand-written; never shared with the implementation)
// ---------------------------------------------------------------------------

interface BrowseNodeBody {
  readonly id: string;
  readonly parentId: string;
  readonly kind: 'folder' | 'bookmark';
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly position: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly iconUrl: string | null;
  /** FO-08: present on bookmark nodes only (public collections); false for explicit none. */
  readonly faviconCdnAllowed?: boolean;
}

interface ChildrenPageBody {
  readonly collectionId: string;
  readonly parentId: string;
  readonly rootId: string;
  readonly contentRevision: string;
  readonly sort: 'curated' | 'created_asc' | 'created_desc';
  readonly items: BrowseNodeBody[];
  readonly nextCursor: string | null;
}

function assertClosedObject(value: unknown, keys: readonly string[], name: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} must be a closed object`);
}

function assertBrowseNode(value: unknown): BrowseNodeBody {
  // Closed object with three optional bookmark-only fields: faviconCdnAllowed
  // (bookmark nodes of public collections), LP-04 previewImage (every
  // bookmark node; null here, link previews are off) and pinned (only `true`).
  // Any other unknown field is still rejected.
  const defaultKeys = ['id', 'parentId', 'kind', 'title', 'url', 'description',
    'position', 'createdAt', 'updatedAt', 'iconUrl'];
  const optionalKeys = ['faviconCdnAllowed', 'previewImage', 'pinned'];
  const allowedKeys = [...defaultKeys, ...optionalKeys];
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'BrowseNode must be an object');
  const body = value;
  const keys = Object.keys(body).sort();
  assert.ok(keys.every((key) => allowedKeys.includes(key)), `BrowseNode unknown field: ${keys.join(', ')}`);
  assert.deepEqual(keys.filter((key) => !optionalKeys.includes(key)).sort(), [...defaultKeys].sort(),
    'BrowseNode must carry exactly the required fields');
  if ('previewImage' in body) assert.equal(body.previewImage, null, 'link previews are off in this suite');
  if ('pinned' in body) assert.ok(body.pinned === true && body.kind === 'bookmark', 'BrowseNode.pinned is a bookmark-only true');
  const id = body.id;
  const parentId = body.parentId;
  const kind = body.kind;
  const title = body.title;
  const url = body.url;
  const description = body.description;
  const position = body.position;
  const createdAt = body.createdAt;
  const updatedAt = body.updatedAt;
  const iconUrl = body.iconUrl;
  const faviconCdnAllowed = body.faviconCdnAllowed;
  assert.ok(typeof id === 'string' && OPAQUE_ID_PATTERN.test(id), 'BrowseNode.id');
  assert.ok(typeof parentId === 'string' && OPAQUE_ID_PATTERN.test(parentId), 'BrowseNode.parentId');
  assert.ok(kind === 'folder' || kind === 'bookmark', 'BrowseNode.kind');
  assert.ok(typeof title === 'string' && title.length >= 1 && title.length <= 512, 'BrowseNode.title');
  assert.ok(url === null || (typeof url === 'string' && url.length >= 1 && url.length <= 8192), 'BrowseNode.url');
  assert.ok(description === null || typeof description === 'string', 'BrowseNode.description');
  assert.ok(typeof position === 'string' && position.length >= 1 && position.length <= 512, 'BrowseNode.position');
  assert.ok(typeof createdAt === 'string' && TIMESTAMP_PATTERN.test(createdAt), 'BrowseNode.createdAt');
  assert.ok(typeof updatedAt === 'string' && TIMESTAMP_PATTERN.test(updatedAt), 'BrowseNode.updatedAt');
  assert.ok(iconUrl === null || typeof iconUrl === 'string', 'BrowseNode.iconUrl');
  assert.ok(faviconCdnAllowed === undefined || typeof faviconCdnAllowed === 'boolean',
    'BrowseNode.faviconCdnAllowed must be a boolean when present');
  if (kind === 'bookmark') {
    assert.ok(typeof url === 'string' && url.startsWith('https://'), 'bookmark BrowseNode.url');
  } else {
    assert.equal(url, null, 'folder BrowseNode.url must be null');
    assert.equal(faviconCdnAllowed, undefined, 'folder BrowseNode.faviconCdnAllowed must be omitted');
  }
  return { id, parentId, kind, title, url: url as string | null,
    description: description as string | null, position,
    createdAt, updatedAt, iconUrl: iconUrl as string | null, faviconCdnAllowed };
}

function assertChildrenPage(value: unknown, expected: {
  collectionId: string;
  parentId: string;
  sort: string;
  itemCount: number | null;
}): ChildrenPageBody {
  assertClosedObject(value, ['collectionId', 'parentId', 'rootId', 'contentRevision',
    'sort', 'items', 'nextCursor'], 'ChildrenPage');
  const body = value;
  assert.equal(body.collectionId, expected.collectionId, 'ChildrenPage.collectionId');
  assert.equal(body.parentId, expected.parentId, 'ChildrenPage.parentId');
  assert.ok(typeof body.rootId === 'string' && OPAQUE_ID_PATTERN.test(body.rootId), 'ChildrenPage.rootId');
  assert.ok(typeof body.contentRevision === 'string' && REVISION_PATTERN.test(body.contentRevision),
    'ChildrenPage.contentRevision');
  assert.equal(body.sort, expected.sort, 'ChildrenPage.sort');
  assert.ok(Array.isArray(body.items) && body.items.length <= 100, 'ChildrenPage.items');
  const items = (body.items as unknown[]).map((item) => assertBrowseNode(item));
  if (expected.itemCount !== null) {
    assert.equal(items.length, expected.itemCount, 'ChildrenPage.items length');
  }
  const nextCursor = body.nextCursor;
  assert.ok(nextCursor === null || (typeof nextCursor === 'string' && CURSOR_PATTERN.test(nextCursor)),
    'ChildrenPage.nextCursor');
  return { collectionId: String(body.collectionId), parentId: String(body.parentId),
    rootId: String(body.rootId), contentRevision: String(body.contentRevision),
    sort: body.sort as ChildrenPageBody['sort'], items, nextCursor: nextCursor as string | null };
}

function assertProductError(value: unknown, codes: readonly string[], expectedRecovery?: string): {
  code: string; message: string; recovery: string;
} {
  assertClosedObject(value, ['error'], 'ProductErrorEnvelope');
  const body = value.error;
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body), 'error envelope');
  assert.deepEqual(Object.keys(body).sort(), ['code', 'currentEtag', 'fieldErrors', 'message',
    'precondition', 'recovery', 'requestId', 'retryAfterSeconds', 'sameRequestRetrySafe'].sort(),
  'error envelope fields');
  const code = body.code;
  const message = body.message;
  const recovery = body.recovery;
  assert.ok(typeof code === 'string' && codes.includes(code), `error.code in [${codes.join(', ')}]`);
  assert.ok(typeof message === 'string' && message.length > 0);
  assert.ok(typeof recovery === 'string');
  if (expectedRecovery !== undefined) assert.equal(recovery, expectedRecovery);
  return { code, message, recovery };
}

// ---------------------------------------------------------------------------
// HTTP plumbing + fixtures
// ---------------------------------------------------------------------------

function api(method: string, url: string, options: {
  cookie?: string; body?: unknown; contentType?: string;
}): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = options.contentType ?? 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if (text.length > 0) {
          try { json = JSON.parse(text) as unknown; } catch { json = text; }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function seedCollection(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  rootId: string,
  ownerSubjectId: string,
  kind: string,
  visibility: string,
  contentRevision: string,
): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    const published = visibility === 'public' || visibility === 'unlisted';
    const publicationSlug = published ? `fo05-${collectionId.replaceAll('_', '-')}` : null;
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node')`,
      [collectionId, rootId],
    );
    await client.query(
      `insert into collections (
         id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, commit_ordinal, created_at, updated_at,
         publication_slug, published_at
       ) values ($1, $2, $3, $4, $5, $6, 'coll-res-1', $7, 'coll-policy-1', 1, now(), now(), $8, $9)`,
      [collectionId, ownerSubjectId, `FO-05 fixture ${collectionId}`, kind, visibility, rootId,
        contentRevision, publicationSlug, published ? new Date() : null],
    );
    await client.query(
      `insert into nodes (
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at
       ) values ($1, $2, null, 'folder', true, 'Root', null, null,
                 'root-res-1', 'root-ch-1', now(), now())`,
      [rootId, collectionId],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1, $2, 'owner', now())`,
      [collectionId, ownerSubjectId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function insertLiveNode(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  seed: ChildSeed & { readonly description?: string | null },
): Promise<void> {
  await runtime.runtime.pool.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
    [seed.id],
  );
  await runtime.runtime.pool.query(
    `insert into nodes (
       id, collection_id, parent_id, kind, is_root, title, url, description, position_token,
       resource_revision, children_revision, created_at, updated_at
     ) values ($1, $2, $3, $4, false, $5, $6, $7, $8, 'node-res-1', 'node-ch-1', $9::timestamptz, $9::timestamptz)
     on conflict (id) do nothing`,
    [seed.id, collectionId, seed.parent, seed.kind, seed.title, seed.url, seed.description ?? null,
      seed.position, seed.createdAt],
  );
}

async function snapshotWriteState(runtime: IsolatedPostgresRuntime, collectionId: string): Promise<{
  nodes: Array<Record<string, unknown>>;
  collection: Record<string, unknown>;
  operationCount: number;
  auditCount: number;
}> {
  const nodes = await runtime.runtime.pool.query(
    `select id, position_token, resource_revision, children_revision, updated_at
     from nodes where collection_id = $1 order by id`,
    [collectionId],
  );
  const collection = await runtime.runtime.pool.query(
    `select resource_revision, content_revision, policy_revision, commit_ordinal, updated_at
     from collections where id = $1`,
    [collectionId],
  );
  const operationCount = await runtime.runtime.pool.query(
    `select count(*)::int as n from operations where collection_id = $1`,
    [collectionId],
  );
  const auditCount = await runtime.runtime.pool.query(
    `select count(*)::int as n from audit_events where collection_id = $1`,
    [collectionId],
  );
  return {
    nodes: nodes.rows.map((row) => ({
      id: row.id, position_token: row.position_token, resource_revision: row.resource_revision,
      children_revision: row.children_revision,
      updated_at: new Date(row.updated_at).toISOString(),
    })),
    collection: Object.fromEntries(Object.entries(collection.rows[0] ?? {}).map(([key, value]) =>
      [key, value instanceof Date ? value.toISOString() : String(value)])),
    operationCount: operationCount.rows[0]?.n ?? 0,
    auditCount: auditCount.rows[0]?.n ?? 0,
  };
}