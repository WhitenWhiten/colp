import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresPublicMarksReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  addUtcDays,
  createPublicationCursorKeyring,
  publishingInsightsWindowBounds,
} from '../../../src/modules/publication/index.js';
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

const instant = '2026-07-24T00:00:00.000Z';
const legacySlug = `legacy-${Buffer.from('123e4567-e89b-12d3-a456-426614174000').toString('hex')}`;
const keyA = { id: 'product-pg-a', secret: Buffer.alloc(32, 81).toString('base64') };
const keyB = { id: 'product-pg-b', secret: Buffer.alloc(32, 82).toString('base64') };

const identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(instant));
const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });

describeWithPostgres('P2-12 PostgreSQL Product public Collection evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let owner: AuthenticatedTestClient;
  let member: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let now = new Date(instant);

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p2_product_public', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    owner = await issueTestSession({
      factory, subject: 'owner', handle: 'pg-owner',
    });
    member = await issueTestSession({
      factory, subject: 'member', handle: 'pg-member',
    });
    outsider = await issueTestSession({
      factory, subject: 'outsider', handle: 'pg-outsider',
    });
    await seedFixtures(isolated, owner.subjectId, member.subjectId);
  }, 180_000);

  afterAll(async () => isolated?.close());

  test('uses real slug/root/publication facts and projects visibility for anonymous, owner, member, and outsider', async () => {
    const app = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    try {
      for (const slug of ['public-page', 'unlisted-page', legacySlug]) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/collections/${slug}` });
        assert.equal(response.statusCode, 200, slug);
        assert.equal(response.json().collection.access, 'public');
        assert.equal(response.json().collection.viewCount, 0);
        assert.equal('viewCount' in response.json().collection, true);
        assert.equal(response.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');
        assertVary(response.headers.vary, ['Cookie']);
        if (slug === 'public-page') {
          assert.equal(response.json().nodes.some((node: { id: string }) => node.id === 'public-secret'), false);
        }
      }

      const publicOwner = await app.inject({
        method: 'GET', url: '/api/v1/collections/public-page', headers: { cookie: owner.cookie },
      });
      assert.equal(publicOwner.statusCode, 200);
      assert.equal(publicOwner.json().collection.access, 'member');
      assert.equal(publicOwner.json().nodes.some((node: { id: string }) => node.id === 'public-secret'), true);
      assert.equal(publicOwner.headers['cache-control'], 'private, no-store');

      for (const slug of ['deleted-page', 'unpublished-page', 'missing-page']) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/collections/${slug}` });
        assert.equal(response.statusCode, 404, slug);
      }

      for (const slug of ['private-page', 'protected-page']) {
        const anonymous = await app.inject({ method: 'GET', url: `/api/v1/collections/${slug}` });
        const outside = await app.inject({
          method: 'GET', url: `/api/v1/collections/${slug}`, headers: { cookie: outsider.cookie },
        });
        const owned = await app.inject({
          method: 'GET', url: `/api/v1/collections/${slug}`, headers: { cookie: owner.cookie },
        });
        const membership = await app.inject({
          method: 'GET', url: `/api/v1/collections/${slug}`, headers: { cookie: member.cookie },
        });
        assert.equal(anonymous.statusCode, 404, `${slug}: anonymous`);
        assert.equal(outside.statusCode, 404, `${slug}: outsider`);
        assert.equal(owned.statusCode, 200, `${slug}: owner`);
        assert.equal(membership.statusCode, 200, `${slug}: member`);
        assert.equal(owned.json().collection.access, 'member');
        assert.equal(membership.json().collection.access, 'member');
        assert.equal(owned.headers['cache-control'], 'private, no-store');
      }
    } finally {
      await app.close();
    }
  });

  test('conceals owner Profile lifecycle and invalid projection states through production PostgreSQL composition', async () => {
    const app = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    const assertConcealed = async (label: string): Promise<void> => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/collections/public-page' });
      assert.equal(response.statusCode, 404, label);
      assert.equal(response.headers['cache-control'], 'private, no-store', label);
      assert.equal(response.body.includes('IiIiIiIiIiIiIiIiIiIiIg'), false, label);
      assert.equal(response.body.includes(owner.subjectId), false, label);
    };
    try {
      await isolated.runtime.pool.query(
        `update accounts set status = 'disabled' where subject_id = $1`, [owner.subjectId],
      );
      await assertConcealed('disabled account');
      await isolated.runtime.pool.query(
        `update accounts set status = 'active' where subject_id = $1`, [owner.subjectId],
      );

      await isolated.runtime.pool.query(
        `update accounts set status = 'deleted', deleted_at = now() where subject_id = $1`, [owner.subjectId],
      );
      await assertConcealed('deleted account');
      await isolated.runtime.pool.query(
        `update accounts set status = 'active', deleted_at = null where subject_id = $1`, [owner.subjectId],
      );

      await isolated.runtime.pool.query(
        `delete from profile_handles where account_id = 'IiIiIiIiIiIiIiIiIiIiIg'`,
      );
      await assertConcealed('hidden Profile handle');
      await isolated.runtime.pool.query(
        `insert into profile_handles(handle, account_id) values ('owner', 'IiIiIiIiIiIiIiIiIiIiIg')`,
      );

      await isolated.runtime.pool.query(
        `delete from profiles where account_id = 'IiIiIiIiIiIiIiIiIiIiIg'`,
      );
      await assertConcealed('missing Profile');
      await isolated.runtime.pool.query(
        `insert into profiles(account_id, display_name) values ('IiIiIiIiIiIiIiIiIiIiIg', '')`,
      );
      await assertConcealed('invalid Follow summary');
      await isolated.runtime.pool.query(
        `update profiles set display_name = 'Owner' where account_id = 'IiIiIiIiIiIiIiIiIiIiIg'`,
      );

      const restored = await app.inject({ method: 'GET', url: '/api/v1/collections/public-page' });
      assert.equal(restored.statusCode, 200);
      assert.deepEqual(restored.json().collection.owner, {
        profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'owner', displayName: 'Owner', avatarUrl: null,
      });
    } finally {
      await isolated.runtime.pool.query(
        `update accounts set status = 'active', deleted_at = null where subject_id = $1`,
        [owner.subjectId],
      );
      await isolated.runtime.pool.query(
        `insert into profiles(account_id, display_name)
           values ('IiIiIiIiIiIiIiIiIiIiIg', 'Owner')
           on conflict (account_id) do update set display_name = 'Owner'`,
      );
      await isolated.runtime.pool.query(
        `insert into profile_handles(handle, account_id)
           values ('owner', 'IiIiIiIiIiIiIiIiIiIiIg') on conflict (handle) do nothing`,
      );
      await app.close();
    }
  });

  test('follows production Product cursors across 10k rows without duplicates or omissions', async () => {
    const app = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    try {
      const observed = new Set<string>();
      let cursor: string | null = null;
      let sequence = 1;
      do {
        const query = cursor === null ? '?limit=100' : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
        const response = await app.inject({ method: 'GET', url: `/api/v1/collections/ten-thousand${query}` });
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.page.sequence, sequence++);
        for (const node of body.nodes as { id: string }[]) {
          assert.equal(observed.has(node.id), false, `duplicate ${node.id}`);
          observed.add(node.id);
        }
        cursor = body.page.cursor;
        assert.equal(body.page.hasMore, cursor !== null);
      } while (cursor !== null);
      assert.equal(observed.size, 10_001);
      assert.ok(observed.has('ten-thousand-root'));
      assert.ok(observed.has('ten-thousand-node-10000'));
    } finally {
      await app.close();
    }
  }, 180_000);

  test('shrinks a real PostgreSQL page below 4 MiB and continues from the emitted Product cursor', async () => {
    const app = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    try {
      const first = await app.inject({ method: 'GET', url: '/api/v1/collections/large-page?limit=100' });
      assert.equal(first.statusCode, 200);
      assert.ok(Buffer.byteLength(first.body, 'utf8') <= 4 * 1024 * 1024);
      assert.equal(first.json().page.hasMore, true);
      assert.ok(first.json().nodes.length <= 100);
      const observed = [...first.json().nodes];
      let cursor = first.json().page.cursor as string | null;
      while (cursor !== null) {
        const next = await app.inject({
          method: 'GET',
          url: `/api/v1/collections/large-page?limit=100&cursor=${encodeURIComponent(cursor)}`,
        });
        assert.equal(next.statusCode, 200);
        assert.ok(Buffer.byteLength(next.body, 'utf8') <= 4 * 1024 * 1024);
        observed.push(...next.json().nodes);
        cursor = next.json().page.cursor;
        assert.equal(next.json().page.hasMore, cursor !== null);
      }
      const ids = observed.map((node: { id: string }) => node.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, 301);
    } finally {
      await app.close();
    }
  }, 120_000);

  test('rejects tamper and expiry while retained keys survive application restart and rotation', async () => {
    now = new Date(instant);
    const firstApp = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    const first = await firstApp.inject({ method: 'GET', url: '/api/v1/collections/ten-thousand?limit=2' });
    const cursor = first.json().page.cursor as string;
    await firstApp.close();

    const restarted = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    const resumed = await restarted.inject({
      method: 'GET', url: `/api/v1/collections/ten-thousand?limit=2&cursor=${encodeURIComponent(cursor)}`,
    });
    assert.equal(resumed.statusCode, 200);
    await restarted.close();

    const rotated = buildTestApp(isolated, identityUnitOfWork, () => now, keyB, [keyA]);
    try {
      const retained = await rotated.inject({
        method: 'GET', url: `/api/v1/collections/ten-thousand?limit=2&cursor=${encodeURIComponent(cursor)}`,
      });
      assert.equal(retained.statusCode, 200);

      const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
      const invalid = await rotated.inject({
        method: 'GET', url: `/api/v1/collections/ten-thousand?limit=2&cursor=${encodeURIComponent(tampered)}`,
      });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error.code, 'invalid_cursor');

      now = new Date('2026-07-24T00:16:00.000Z');
      const expired = await rotated.inject({
        method: 'GET', url: `/api/v1/collections/ten-thousand?limit=2&cursor=${encodeURIComponent(cursor)}`,
      });
      assert.equal(expired.statusCode, 409);
      assert.equal(expired.json().error.code, 'snapshot_expired');
    } finally {
      await rotated.close();
      now = new Date(instant);
    }
  });

  test('GET slug sums in-window collection_view daily rows and ignores out-of-window rows', async () => {
    const bounds = publishingInsightsWindowBounds(new Date());
    const today = addUtcDays(bounds.toDayExclusive, -1);
    const beforeWindow = addUtcDays(bounds.fromDayInclusive, -1);
    await isolated.runtime.pool.query(
      `insert into publication_insight_daily (collection_id, day, event_type, node_id, count)
       values
        ('public', $1::date, 'collection_view', '', 4),
        ('public', $2::date, 'collection_view', '', 5),
        ('public', $3::date, 'collection_view', '', 11),
        ('public', $1::date, 'preview_open', '', 9),
        ('unlisted', $1::date, 'collection_view', '', 2)`,
      [bounds.fromDayInclusive, today, beforeWindow],
    );
    const app = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    try {
      const publicPage = await app.inject({ method: 'GET', url: '/api/v1/collections/public-page' });
      assert.equal(publicPage.statusCode, 200);
      assert.equal(publicPage.json().collection.viewCount, 9);
      assert.equal('viewCount' in publicPage.json().collection, true);
      assert.equal(publicPage.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');

      const unlisted = await app.inject({ method: 'GET', url: '/api/v1/collections/unlisted-page' });
      assert.equal(unlisted.statusCode, 200);
      assert.equal(unlisted.json().collection.access, 'public');
      assert.equal(unlisted.json().collection.viewCount, 2);
      assert.equal(unlisted.headers['cache-control'], 'public, max-age=60, stale-while-revalidate=300');

      const anonymousPrivate = await app.inject({ method: 'GET', url: '/api/v1/collections/private-page' });
      assert.equal(anonymousPrivate.statusCode, 404);
      assert.equal(anonymousPrivate.json().error.code, 'resource_not_found');

      const directory = await app.inject({
        method: 'GET', url: '/colp/v0.1/directory?limit=100',
        headers: {
          accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
        },
      });
      assert.equal(directory.statusCode, 200, directory.body);
      const catalog = directory.json() as { collections: Array<Record<string, unknown>> };
      assert.ok(catalog.collections.some((item) => item.id === 'public'));
      for (const item of catalog.collections) {
        assert.equal('viewCount' in item, false, String(item.id));
      }
      assert.doesNotMatch(directory.body, /"viewCount"/);
    } finally {
      await isolated.runtime.pool.query(
        `delete from publication_insight_daily where collection_id in ('public', 'unlisted')`,
      );
      await app.close();
    }
  });

  test('exposes only public node marks and pins folder-marked nodes; private marks never leak', async () => {
    const app = buildTestApp(isolated, identityUnitOfWork, () => now, keyA, []);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/collections/public-page' });
      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        nodes: Array<{ id: string; kind: string; tldr?: string; note?: string }>;
      };
      const marked = body.nodes.find((node) => node.id === 'public-marked');
      assert.ok(marked, 'public-marked node is present on the anonymous page');
      assert.equal(marked.kind, 'bookmark');
      // Latest updated_at tldr wins over the older public tldr row.
      assert.equal(marked.tldr, 'Public tldr latest');
      assert.equal(marked.note, 'Public note value');
      // Folder nodes carry public tldr marks too (folder subjects are legal).
      const folder = body.nodes.find((node) => node.id === 'public-folder');
      assert.ok(folder, 'public-folder node is present on the anonymous page');
      assert.equal(folder.kind, 'folder');
      assert.equal(folder.tldr, 'Folder tldr value');
      assert.equal(Object.hasOwn(folder, 'note'), false);
      // private/protected marks never appear anywhere in the public response.
      assert.equal(response.body.includes('Private note value'), false, 'private note leaked');
      assert.equal(response.body.includes('Protected tldr value'), false, 'protected tldr leaked');
      // The private bookmark itself stays concealed, so its marks are moot.
      assert.equal(body.nodes.some((node) => node.id === 'public-secret'), false);
      // Collection-level public tldr surfaces as the curator note.
      assert.equal(response.json().collection.curatorNote, 'Collection tldr value');

      const unlisted = await app.inject({ method: 'GET', url: '/api/v1/collections/unlisted-page' });
      assert.equal(unlisted.statusCode, 200);
      assert.equal(unlisted.json().collection.curatorNote, null);
      assert.equal(unlisted.body.includes('Private collection tldr'), false, 'private collection tldr leaked');
    } finally {
      await app.close();
    }
  });
});

function buildTestApp(
  isolated: IsolatedPostgresRuntime,
  identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>,
  now: () => Date,
  active: typeof keyA,
  retained: readonly (typeof keyA)[],
) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known', PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example', LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  const cursors = createPublicationCursorKeyring({ active, retained });
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    productPublicCollectionQuery: {
      locators: createPostgresProductPublicCollectionLocatorReadPort(isolated.runtime),
      viewCounts: createPostgresProductPublicCollectionViewCountReadPort(isolated.runtime),
      cursors,
      owners: createPostgresPublicProfileFactsReadPort(isolated.runtime),
      snapshot: {
        reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
        accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
        cursors,
        origin: config.publication.origin,
        now,
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      },
      publicMarks: createPostgresPublicMarksReadPort(isolated.runtime),
    },
    publicationDirectoryQuery: {
      reads: createPostgresPublicationDirectoryReadPort(isolated.runtime),
      cursors,
      origin: config.publication.origin,
      maxPageSize: 500,
    },
  });
  app.addHook('onClose', () => cursors.destroy());
  return app;
}

async function seedFixtures(
  isolated: IsolatedPostgresRuntime,
  ownerSubjectId: string,
  memberSubjectId: string,
): Promise<void> {
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
      `insert into profile_handles(handle, account_id) values ('owner', 'IiIiIiIiIiIiIiIiIiIiIg')`,
    );
    for (const fixture of [
      ['public', 'public-page', 'public', false],
      ['unlisted', 'unlisted-page', 'unlisted', false],
      ['legacy', legacySlug, 'public', false],
      ['private', 'private-page', 'private', false],
      ['protected', 'protected-page', 'protected', false],
      ['deleted', 'deleted-page', 'public', true],
      ['large', 'large-page', 'public', false],
      ['ten-thousand', 'ten-thousand', 'public', false],
    ] as const) {
      const [id, slug, visibility, deleted] = fixture;
      const root = `${id}-root`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, root],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, deleted_at, updated_at)
         values ($1, $2, $1, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $5,
                 $6::timestamptz, $7::timestamptz, $8::timestamptz)`,
        [id, ownerSubjectId, visibility, root, slug, instant, deleted ? instant : null, instant],
      );
      await client.query(
        `insert into nodes
          (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision, deleted_at)
         values ($1, $2, 'folder', true, 'Root', 'inherit', 'r1', 'ch1', $3::timestamptz)`,
        [root, id, deleted ? instant : null],
      );
      if (id === 'private' || id === 'protected') {
        await client.query(
          `insert into collection_members(collection_id, subject_id, role) values ($1, $2, 'viewer')`,
          [id, memberSubjectId],
        );
      }
    }

    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'ten-thousand-node-' || value, 'node' from generate_series(1, 10000) value`,
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ('public-secret', 'node')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       values ('public-secret', 'public', 'public-root', 'bookmark', 'Restricted',
               'https://example.test/restricted', 'private', '000000000001', 'r1', 'ch1')`,
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ('public-marked', 'node'), ('public-folder', 'node')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       values ('public-marked', 'public', 'public-root', 'bookmark', 'Marked',
               'https://example.test/marked', 'inherit', '000000000002', 'r1', 'ch1'),
              ('public-folder', 'public', 'public-root', 'folder', 'Folder',
               null, 'inherit', '000000000003', 'r1', 'ch1')`,
    );
    await seedMarkAnnotation(client, {
      id: 'public-marked-tldr', collectionId: 'public', subjectId: 'public-marked',
      type: 'tldr', visibility: 'public', value: 'Public tldr value',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'public-marked-tldr-latest', collectionId: 'public', subjectId: 'public-marked',
      type: 'tldr', visibility: 'public', value: 'Public tldr latest',
      updatedAt: '2026-07-24T02:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'public-marked-note', collectionId: 'public', subjectId: 'public-marked',
      type: 'note', visibility: 'public', value: 'Public note value',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'public-marked-private-note', collectionId: 'public', subjectId: 'public-marked',
      type: 'note', visibility: 'private', value: 'Private note value',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'public-marked-protected-tldr', collectionId: 'public', subjectId: 'public-marked',
      type: 'tldr', visibility: 'protected', value: 'Protected tldr value',
      updatedAt: '2026-07-24T02:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'public-folder-tldr', collectionId: 'public', subjectId: 'public-folder',
      type: 'tldr', visibility: 'public', value: 'Folder tldr value',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'public-collection-tldr', collectionId: 'public', subjectId: 'public',
      subjectType: 'collection', type: 'tldr', visibility: 'public',
      value: 'Collection tldr value', updatedAt: '2026-07-24T00:00:00.000Z',
    });
    await seedMarkAnnotation(client, {
      id: 'unlisted-collection-private-tldr', collectionId: 'unlisted', subjectId: 'unlisted',
      subjectType: 'collection', type: 'tldr', visibility: 'private',
      value: 'Private collection tldr', updatedAt: '2026-07-24T00:00:00.000Z',
    });
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, visibility, position_token,
         resource_revision, children_revision)
       select 'ten-thousand-node-' || value, 'ten-thousand', 'ten-thousand-root', 'bookmark',
              'Node ' || value, 'https://example.test/' || value, 'inherit',
              lpad(value::text, 12, '0'), 'r1', 'ch1'
         from generate_series(1, 10000) value`,
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       select 'large-node-' || value, 'node' from generate_series(1, 300) value`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, title, url, description, visibility, position_token,
         resource_revision, children_revision)
       select 'large-node-' || value, 'large', 'large-root', 'bookmark', 'Large ' || value,
              'https://example.test/large/' || value, repeat('x', 20000), 'inherit',
              lpad(value::text, 12, '0'), 'r1', 'ch1'
         from generate_series(1, 300) value`,
    );

    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ('unpublished', 'collection'), ('unpublished-root', 'node')`,
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at)
       values ('unpublished', $1, 'Unpublished', 'bookmarks', 'private', 'unpublished-root',
               'r1', 'c1', 'p1', null, null)`,
      [ownerSubjectId],
    );
    await client.query(
      `insert into nodes
        (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision)
       values ('unpublished-root', 'unpublished', 'folder', true, 'Root', 'inherit', 'r1', 'ch1')`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedMarkAnnotation(
  client: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
  input: {
    readonly id: string;
    readonly collectionId: string;
    readonly subjectId: string;
    readonly subjectType?: 'node' | 'collection';
    readonly type: 'tldr' | 'note';
    readonly visibility: 'public' | 'protected' | 'private';
    readonly value: string;
    readonly updatedAt: string;
  },
): Promise<void> {
  const { id, collectionId, subjectId, type, visibility, value, updatedAt } = input;
  const subjectType = input.subjectType ?? 'node';
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'annotation')`,
    [id],
  );
  await client.query(
    `insert into annotations(
       id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
       visibility, resource_revision, created_at, updated_at, payload_json)
     values ($1, $2, $3, $4, $5, $6, 'plain', $7::jsonb, $8, $9,
             $10::timestamptz, $11::timestamptz, $12::jsonb)`,
    [id, collectionId, subjectType, subjectId, 'IiIiIiIiIiIiIiIiIiIiIg', type, JSON.stringify(value),
      visibility, `rev-${id}`, updatedAt, updatedAt, JSON.stringify({
        id, collectionId,
        subject: { type: subjectType, id: subjectId },
        creator: { id: 'https://known.example/profiles/pg-owner', name: 'Owner' },
        type, format: 'plain', value, visibility,
        revision: `rev-${id}`, createdAt: updatedAt, updatedAt,
      })],
  );
}

function assertVary(value: string | undefined, expected: readonly string[]): void {
  const fields = new Set((value ?? '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean));
  for (const field of expected) assert.ok(fields.has(field.toLowerCase()), `Vary is missing ${field}: ${value}`);
}
