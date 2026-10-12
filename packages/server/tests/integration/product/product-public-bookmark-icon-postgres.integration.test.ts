import { createDatabaseFaviconStore } from '../../../src/infrastructure/collections/favicon-database-store.js';
import { isFaviconPubliclyAccessible, isFaviconReadableBySubject } from '../../../src/infrastructure/database/publication-object-controls.js';
import { makePng } from '../../support/link-preview-fixtures.js';
/**
 * BF-04: live bookmark_icons JOIN on Product public Collection pages,
 * faviconCdnAllowed, and a query-count upper bound (one IN-list lookup).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresBookmarkIconReadPort } from '../../../src/infrastructure/collections/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const instant = '2026-08-20T00:00:00.000Z';
const PRODUCT_ORIGIN = 'https://known.example';
const ICON_A = '01234567-89ab-4cde-8f01-23456789abcd';
const ICON_SECRET = 'fedcba98-7654-4321-8abc-0123456789ab';
const DIGEST = Buffer.alloc(32, 9);
const keyA = { id: 'icon-pg-a', secret: Buffer.alloc(32, 91).toString('base64') };

const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(instant));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

describeWithPostgres('BF-04 PostgreSQL live bookmark icon JOIN on public Collection pages', () => {
  let isolated: IsolatedPostgresRuntime;
  let owner: AuthenticatedTestClient;
  let iconLookups = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('bf04_public_icon_join', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    owner = await issueTestSession({ factory, subject: 'icon-owner', handle: 'icon-owner' });
    await seedFixtures(isolated, owner.subjectId);
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('anonymous directory-public page JOINs icons once, drops private icons, and forbids CDN', async () => {
    iconLookups = 0;
    const app = buildTestApp(isolated, () => iconLookups += 1);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/collections/icon-public-page' });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        collection: { access: string; faviconCdnAllowed?: boolean };
        nodes: Array<{ id: string; kind: string; iconUrl?: string | null }>;
      };
      assert.equal(body.collection.access, 'public');
      assert.equal(body.collection.faviconCdnAllowed, false);
      assert.equal(body.nodes.some((node) => node.id === 'icon-secret'), false);
      assert.equal(JSON.stringify(body).includes(ICON_SECRET), false);
      const folder = body.nodes.find((node) => node.id === 'icon-folder');
      const bookmark = body.nodes.find((node) => node.id === 'icon-bm-1');
      const missing = body.nodes.find((node) => node.id === 'icon-bm-8');
      const root = body.nodes.find((node) => node.kind === 'root');
      assert.equal(folder?.iconUrl, null);
      assert.equal(root?.iconUrl, null);
      assert.equal(bookmark?.iconUrl, `${PRODUCT_ORIGIN}/api/v1/favicon/${ICON_A}`);
      assert.equal(missing?.iconUrl, null);
      assert.equal(iconLookups, 1);
      assert.doesNotMatch(response.body, /favicon\.im|duckduckgo/i);
    } finally {
      await app.close();
    }
  });

  test('unlisted anonymous page forbids CDN even when access is public', async () => {
    const app = buildTestApp(isolated, () => undefined);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/collections/icon-unlisted-page' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().collection.access, 'public');
      assert.equal(response.json().collection.faviconCdnAllowed, false);
    } finally {
      await app.close();
    }
  });

  test('owner Session on the public Collection uses member projection and forbids CDN', async () => {
    const app = buildTestApp(isolated, () => undefined);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/collections/icon-public-page',
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        collection: { access: string; faviconCdnAllowed?: boolean };
        nodes: Array<{ id: string; iconUrl?: string | null }>;
      };
      assert.equal(body.collection.access, 'member');
      assert.equal(body.collection.faviconCdnAllowed, false);
      assert.equal(body.nodes.some((node) => node.id === 'icon-secret'), true);
      assert.equal(
        body.nodes.find((node) => node.id === 'icon-secret')?.iconUrl,
        `${PRODUCT_ORIGIN}/api/v1/favicon/${ICON_SECRET}`,
      );
    } finally {
      await app.close();
    }
  });

  test('empty node-id list is a no-op (no bookmark_icons SQL)', async () => {
    let queries = 0;
    const counted = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        queries += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const before = queries;
    const result = await createPostgresBookmarkIconReadPort(counted).findObjectIdsByNodeIds([]);
    assert.equal(result.size, 0);
    assert.equal(queries, before);
  });
  test('database objects persist across store instances and private bytes require a live authorized session', async () => {
    const store = createDatabaseFaviconStore(isolated.runtime.db);
    const png = makePng(2, 2);
    await store.put(ICON_SECRET, png, 'image/png');
    const reopened = createDatabaseFaviconStore(isolated.runtime.db);
    assert.deepEqual((await reopened.get(ICON_SECRET))?.body, png);
    await assert.rejects(() => store.put('../outside', png, 'image/png'));
    await assert.rejects(() => store.put(ICON_A, Buffer.alloc(65_537), 'image/png'));
    const stranger = await issueTestSession({ subject: 'favicon-stranger', handle: 'favicon-stranger', factory });
    const app = buildTestApp(isolated, () => undefined);
    try {
      const url = `/api/v1/favicon/${ICON_SECRET}`;
      const anonymous = await app.inject({ method: 'GET', url });
      assert.equal(anonymous.statusCode, 404);
      const denied = await app.inject({ method: 'GET', url, headers: { cookie: stranger.cookie } });
      assert.equal(denied.statusCode, 404);
      assert.equal(denied.headers['cache-control'], 'private, no-store');
      const allowed = await app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.headers['cache-control'], 'private, no-store');
      assert.deepEqual(allowed.rawPayload, png);
      await isolated.runtime.pool.query('DELETE FROM bookmark_icons WHERE object_id = $1', [ICON_SECRET]);
      const retired = await app.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
      assert.equal(retired.statusCode, 404);
      await reopened.delete(ICON_SECRET);
      assert.equal(await store.get(ICON_SECRET), null);
    } finally { await app.close(); }
  });

});

function buildTestApp(isolated: IsolatedPostgresRuntime, onIconLookup: () => void) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: PRODUCT_ORIGIN,
    PUBLICATION_ORIGIN: PRODUCT_ORIGIN, LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  const cursors = createPublicationCursorKeyring({ active: keyA, retained: [] });
  const origin = createPostgresBookmarkIconReadPort(isolated.runtime.db);
  const app = buildApiApp({
    config,
    faviconStore: createDatabaseFaviconStore(isolated.runtime.db),
    faviconPublicAccess: {
      isPubliclyAccessible: (id) => isFaviconPubliclyAccessible(isolated.runtime.db, id),
      isReadableBySubject: (id, subject) => isFaviconReadableBySubject(isolated.runtime.db, id, subject),
    },
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicCollectionQuery: {
      locators: createPostgresProductPublicCollectionLocatorReadPort(isolated.runtime),
      viewCounts: createPostgresProductPublicCollectionViewCountReadPort(isolated.runtime),
      cursors,
      owners: createPostgresPublicProfileFactsReadPort(isolated.runtime),
      productOrigin: PRODUCT_ORIGIN,
      bookmarkIcons: {
        async findObjectIdsByNodeIds(nodeIds) {
          onIconLookup();
          return origin.findObjectIdsByNodeIds(nodeIds);
        },
      },
      snapshot: {
        reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
        accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
        cursors,
        origin: config.publication.origin,
        now: () => new Date(instant),
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      },
    },
  });
  app.addHook('onClose', () => cursors.destroy());
  return app;
}

async function seedFixtures(isolated: IsolatedPostgresRuntime, ownerSubjectId: string): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id) values ('IiIiIiIiIiIiIiIiIiIiIg', $1)`,
      [ownerSubjectId],
    );
    await client.query(
      `insert into profiles(account_id, display_name) values ('IiIiIiIiIiIiIiIiIiIiIg', 'Owner')`,
    );
    await client.query(
      `insert into profile_handles(handle, account_id) values ('icon-owner', 'IiIiIiIiIiIiIiIiIiIiIg')`,
    );

    for (const fixture of [
      ['icon-public', 'icon-public-page', 'public'],
      ['icon-unlisted', 'icon-unlisted-page', 'unlisted'],
    ] as const) {
      const [id, slug, visibility] = fixture;
      const root = `${id}-root`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, root],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at)
         values ($1, $2, $1, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $5,
                 $6::timestamptz, $6::timestamptz)`,
        [id, ownerSubjectId, visibility, root, slug, instant],
      );
      await client.query(
        `insert into nodes
          (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision)
         values ($1, $2, 'folder', true, 'Root', 'inherit', 'r1', 'ch1')`,
        [root, id],
      );
    }

    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ('icon-folder', 'node'), ('icon-secret', 'node')`,
    );
    for (let index = 1; index <= 8; index += 1) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
        [`icon-bm-${index}`],
      );
    }

    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, visibility, position_token,
         resource_revision, children_revision)
       values ('icon-folder', 'icon-public', 'icon-public-root', 'folder', 'Folder',
               'inherit', '000000000000', 'r1', 'ch1')`,
    );
    for (let index = 1; index <= 8; index += 1) {
      await client.query(
        `insert into nodes
          (id, collection_id, parent_id, kind, title, url, visibility, position_token,
           resource_revision, children_revision)
         values ($1, 'icon-public', 'icon-public-root', 'bookmark', $2,
                 $3, 'inherit', $4, 'r1', 'ch1')`,
        [
          `icon-bm-${index}`,
          `Bookmark ${index}`,
          `https://example.test/${index}`,
          String(index).padStart(12, '0'),
        ],
      );
    }
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       values ('icon-secret', 'icon-public', 'icon-public-root', 'bookmark', 'Secret',
               'https://example.test/secret', 'private', '000000000099', 'r1', 'ch1')`,
    );

    await client.query(
      `insert into bookmark_icons (
         node_id, collection_id, object_id, content_type, byte_size, digest_sha256
       ) values
         ('icon-bm-1', 'icon-public', $1, 'image/png', 16, $3),
         ('icon-secret', 'icon-public', $2, 'image/png', 16, $3)`,
      [ICON_A, ICON_SECRET, DIGEST],
    );

    // FO-07 fix fixtures: an explicit `none` (owner opt-out) and an explicit
    // `online` node on the public page, plus an explicit `none` node on the
    // unlisted page. All three have no icon binding, so only the per-node
    // source fact can tell them apart.
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values
         ('icon-bm-none', 'node'), ('icon-bm-explicit-online', 'node'), ('icon-unlisted-none', 'node')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       values ('icon-bm-none', 'icon-public', 'icon-public-root', 'bookmark', 'Opted out',
               'https://example.test/none', 'inherit', '000000000100', 'r1', 'ch1')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       values ('icon-bm-explicit-online', 'icon-public', 'icon-public-root', 'bookmark', 'Online',
               'https://example.test/online', 'inherit', '000000000101', 'r1', 'ch1')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       values ('icon-unlisted-none', 'icon-unlisted', 'icon-unlisted-root', 'bookmark', 'Opted out',
               'https://example.test/unlisted-none', 'inherit', '000000000100', 'r1', 'ch1')`,
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
