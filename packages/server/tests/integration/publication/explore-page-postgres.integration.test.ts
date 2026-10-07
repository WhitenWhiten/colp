import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildExplorePageStatement,
  buildPublicationDirectoryStatement,
  createPostgresExplorePageReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicMarksReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  addUtcDays,
  publishingInsightsWindowBounds,
} from '../../../src/modules/publication/index.js';
import { isHiddenByCatalogPreferences } from '../../../src/modules/governance/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER = 'explore-page-owner';
const VIEWED = 'explore-viewed-a';
const QUIET = 'explore-quiet-b';
const STALE = 'explore-stale-c';
const UNLISTED = 'explore-unlisted-d';
const LINKS_MANY = 'explore-links-many';
const LINKS_FEW = 'explore-links-few';
const TAGGED_DESIGN = 'explore-tagged-design';
const TAGGED_OTHER = 'explore-tagged-other';

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describeWithPostgres('Explore page postgres viewCount and sort (EX-01)', () => {
  let isolated: IsolatedPostgresRuntime;
  let bounds: ReturnType<typeof publishingInsightsWindowBounds>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('explore_page_ex01', {
      maxConnections: 6,
      applicationName: 'known-explore-page',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    bounds = publishingInsightsWindowBounds(new Date());
    await seedExploreFixture(isolated, bounds);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('sort=popular ranks in-window views first and still returns viewCount=0 rows', async () => {
    const body = await getExplore(isolated, 'sort=popular&q=explore-alpha');
    const ids = body.items.map((item) => item.id);
    assert.equal(ids.includes(UNLISTED), false);
    const viewed = body.items.find((item) => item.id === VIEWED);
    const quiet = body.items.find((item) => item.id === QUIET);
    assert.ok(viewed);
    assert.ok(quiet);
    assert.ok(viewed.viewCount > 0);
    assert.equal(quiet.viewCount, 0);
    assert.ok(ids.indexOf(VIEWED) < ids.indexOf(QUIET));
  });

  test('daily rows before fromDayInclusive do not count', async () => {
    const body = await getExplore(isolated, `q=${encodeURIComponent('Stale Gamma')}`);
    const stale = body.items.find((item) => item.id === STALE);
    assert.ok(stale);
    assert.equal(stale.viewCount, 0);
  });

  test('unlisted collections with daily collection_view are absent for every sort', async () => {
    for (const sort of ['updated', 'popular', 'links']) {
      const body = await getExplore(isolated, `sort=${sort}&limit=100`);
      assert.equal(body.items.some((item) => item.id === UNLISTED), false, sort);
    }
  });

  test('sort=links orders by live_node_count including folders', async () => {
    const manyCount = await liveCount(isolated, LINKS_MANY);
    const fewCount = await liveCount(isolated, LINKS_FEW);
    assert.ok(manyCount > fewCount);
    const body = await getExplore(isolated, 'sort=links&q=explore-links');
    const ids = body.items.map((item) => item.id).filter((id) => id === LINKS_MANY || id === LINKS_FEW);
    assert.deepEqual(ids, [LINKS_MANY, LINKS_FEW]);
    assert.equal(body.items.find((item) => item.id === LINKS_MANY)?.nodeCount, manyCount);
    assert.equal(body.items.find((item) => item.id === LINKS_FEW)?.nodeCount, fewCount);
  });

  test('sort=popular paginates two pages with viewCount in the continuation cursor', async () => {
    const first = await getExplore(isolated, 'sort=popular&limit=1&q=explore-alpha');
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.id, VIEWED);
    assert.ok((first.items[0]?.viewCount ?? 0) > 0);
    assert.equal(typeof first.nextCursor, 'string');
    const cursor = JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8')) as {
      sort?: string;
      viewCount?: number;
      id?: string;
    };
    assert.equal(cursor.sort, 'popular');
    assert.equal(cursor.viewCount, first.items[0]?.viewCount);
    assert.equal(cursor.id, VIEWED);
    const second = await getExplore(
      isolated,
      `sort=popular&limit=1&q=explore-alpha&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    assert.equal(second.items[0]?.id, QUIET);
    assert.equal(second.items[0]?.viewCount, 0);
  });

  test('old {micros,id} cursor with sort=popular is invalid_cursor', async () => {
    const oldCursor = Buffer.from(JSON.stringify({
      micros: '1784851200000000',
      id: VIEWED,
    }), 'utf8').toString('base64url');
    const app = exploreApp(isolated);
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/explore/collections?sort=popular&cursor=${encodeURIComponent(oldCursor)}`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_cursor');
  });

  test('q and tag still filter; tag is jsonb ? exact match', async () => {
    const tagged = await getExplore(isolated, `tag=${encodeURIComponent('Design')}`);
    assert.deepEqual(tagged.items.map((item) => item.id), [TAGGED_DESIGN]);
    const substring = await getExplore(isolated, `tag=${encodeURIComponent('Des')}`);
    assert.equal(substring.items.some((item) => item.id === TAGGED_DESIGN), false);
    const byTitle = await getExplore(isolated, `q=${encodeURIComponent('tagged design')}`);
    assert.equal(byTitle.items.some((item) => item.id === TAGGED_DESIGN), true);
    assert.equal(byTitle.items.some((item) => item.id === TAGGED_OTHER), false);
  });

  test('Explore surfaces only public collection tldr as curatorNote', async () => {
    const body = await getExplore(isolated, `q=${encodeURIComponent('explore-alpha')}`);
    const viewed = body.items.find((item) => item.id === VIEWED);
    const quiet = body.items.find((item) => item.id === QUIET);
    assert.ok(viewed, 'VIEWED matches the explore-alpha query');
    assert.ok(quiet, 'QUIET matches the explore-alpha query');
    assert.equal(viewed.curatorNote, 'Viewed curator pick');
    assert.equal(quiet.curatorNote, null);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE QUIET TLDR/u);
  });

  test('compiled directory and Explore statements keep their separate view-count contracts', () => {
    const statement = buildPublicationDirectoryStatement({
      principal: 'anonymous',
      filter: {},
      limit: 10,
    });
    assert.doesNotMatch(statement.text, /view_count/);
    const explore = buildExplorePageStatement({
      filter: {},
      sort: 'popular',
      limit: 10,
    }, bounds);
    assert.match(explore.text, /from publication_insight_daily d/i);
    assert.match(explore.text, /viewed_page as materialized/i);
    assert.match(explore.text, /zero_page as materialized/i);
    assert.doesNotMatch(explore.text, /left join publication_insight_daily/i);
    assert.doesNotMatch(explore.text, /group by c\.id/i);
    assert.match(explore.text, /order by ranked\.view_count desc/i);
  });

  test('hidden bookmarks stay a legal visible count and links pages use the raw sort key', async () => {
    const high = 'explore-hide-high';
    const low = 'explore-hide-low';
    await seedHideCountCollection(isolated, high, '2026-08-01T00:00:00.000Z');
    await seedHideCountCollection(isolated, low, '2026-08-02T00:00:00.000Z');
    await addLiveBookmark(isolated, high, `${high}-b1`);
    await addLiveBookmark(isolated, high, `${high}-b2`);
    await addLiveBookmark(isolated, low, `${low}-b1`);
    await insertHide(isolated, high, `${high}-b1`, `${high}-hide-1`);
    await insertHide(isolated, high, `${high}-b1`, `${high}-hide-2`);
    await insertHide(isolated, high, `${high}-b2`, `${high}-hide-3`);
    await softDeleteNode(isolated, `${high}-b1`);
    await softDeleteNode(isolated, `${high}-b2`);
    const onlyRoot = await liveCount(isolated, high);
    assert.equal(onlyRoot, 1);
    for (const sort of ['updated', 'popular', 'links']) {
      const body = await getExplore(isolated, `sort=${sort}&q=explore-hide-count&limit=10`);
      assert.equal(body.items.find((item) => item.id === high)?.nodeCount, 1, sort);
    }
    const directory = await createPostgresPublicationDirectoryReadPort(isolated.runtime).loadPage({
      principal: 'anonymous',
      filter: { q: 'explore-hide-count' },
      limit: 10,
    });
    assert.equal(directory.find((row) => row.id === high)?.nodeCount, 1);

    await restoreNode(isolated, `${high}-b1`);
    assert.equal(await liveCount(isolated, high), 2);
    const restored = await getExplore(isolated, 'sort=links&q=explore-hide-count&limit=10');
    assert.equal(restored.items.find((item) => item.id === high)?.nodeCount, 1);

    await revokeHide(isolated, `${high}-hide-1`);
    await revokeHide(isolated, `${high}-hide-2`);
    const unhidden = await getExplore(isolated, 'sort=links&q=explore-hide-count&limit=10');
    assert.equal(unhidden.items.find((item) => item.id === high)?.nodeCount, 2);

    await addLiveBookmark(isolated, high, `${high}-b3`);
    await addLiveBookmark(isolated, high, `${high}-b4`);
    await insertHide(isolated, high, `${high}-b3`, `${high}-hide-b3`);
    const highLive = await liveCount(isolated, high);
    const lowLive = await liveCount(isolated, low);
    assert.ok(highLive > lowLive);
    const first = await getExplore(isolated, 'sort=links&q=explore-hide-count&limit=1');
    assert.equal(first.items[0]?.id, high);
    assert.equal(first.items[0]?.nodeCount, highLive - 1);
    const cursor = JSON.parse(Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8')) as {
      nodeCount?: number;
    };
    assert.equal(cursor.nodeCount, highLive);
    const second = await getExplore(
      isolated,
      `sort=links&q=explore-hide-count&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    assert.equal(second.items[0]?.id, low);
    assert.equal(second.items[0]?.nodeCount, lowLive);
  });

  test('preference SQL matches the application rules inside one bounded window', async () => {
    const titles = [
      { id: 'explore-pref-notes', title: 'Systems Notes explorepref', tags: ['ok'], language: 'en' },
      { id: 'explore-pref-other', title: 'Other explorepref', tags: ['ok'], language: 'en' },
      { id: 'explore-pref-design', title: 'Keep Design explorepref', tags: ['Design'], language: 'en' },
      { id: 'explore-pref-design-case', title: 'Keep design explorepref', tags: ['design'], language: 'en' },
      { id: 'explore-pref-fr', title: 'French Keep explorepref', tags: ['ok'], language: 'fr' },
      { id: 'explore-pref-empty-lang', title: 'No Language explorepref', tags: ['ok'], language: null },
      { id: 'explore-pref-nfc', title: 'Cafe\u0301 Keep explorepref', tags: ['ok'], language: 'en' },
      { id: 'explore-pref-dot', title: '\u0130stanbul Keep explorepref', tags: ['ok'], language: 'en' },
    ];
    for (const row of titles) {
      await seedPreferenceCollection(isolated, row.id, row.title, row.tags, row.language);
    }
    const preference = {
      hiddenOwnerAccountIds: [] as string[],
      hiddenTags: ['Design'],
      hiddenTitleKeywords: ['notes', 'caf\u00e9', '\u0130stanbul'.toLowerCase()],
      preferredLanguages: ['en'],
    };
    const rows = await createPostgresExplorePageReadPort(isolated.runtime).loadPage({
      filter: { q: 'explorepref' },
      sort: 'updated',
      limit: 24,
      scanBudget: 10,
      catalogPreference: preference,
    });
    assert.ok(rows.length <= 11);
    assert.ok(rows.every((row) => typeof row.preferenceHidden === 'boolean'));
    for (const row of rows) {
      assert.equal(row.preferenceHidden, isHiddenByCatalogPreferences({
        ownerAccountId: row.ownerAccountId ?? '',
        tags: row.tags,
        title: row.title,
        language: row.language,
      }, {
        ...preference,
        revision: '1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }), row.id);
    }
    const visible = rows.filter((row) => row.preferenceHidden !== true).map((row) => row.id);
    assert.equal(visible.includes('explore-pref-design-case'), true);
    assert.equal(visible.includes('explore-pref-notes'), false);
    assert.equal(visible.includes('explore-pref-design'), false);
    assert.equal(visible.includes('explore-pref-fr'), false);
    assert.equal(visible.includes('explore-pref-empty-lang'), false);
  });
});

interface ExploreBody {
  items: Array<{
    id: string;
    viewCount: number;
    nodeCount: number;
    curatorNote?: string | null;
  }>;
  nextCursor: string | null;
}

function exploreApp(isolated: IsolatedPostgresRuntime) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  return buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    explorePageQuery: createPostgresExplorePageReadPort(isolated.runtime),
    explorePublicMarks: createPostgresPublicMarksReadPort(isolated.runtime),
  });
}

async function getExplore(isolated: IsolatedPostgresRuntime, query: string): Promise<ExploreBody> {
  const app = exploreApp(isolated);
  apps.push(app);
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/explore/collections?${query}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as ExploreBody;
}

async function seedHideCountCollection(
  isolated: IsolatedPostgresRuntime,
  id: string,
  updatedAt: string,
): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [id, `${id}-root`],
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at,
         payload_json, payload_schema_version, payload_authority_status)
       values ($1, $2, $3, 'bookmarks', 'public', $4, 'r1', 'c1', 'p1', $1, $5::timestamptz, $5::timestamptz,
               '{}'::jsonb, 1, 'backfilled')`,
      [id, OWNER, `${id} explore-hide-count`, `${id}-root`, updatedAt],
    );
    await client.query(
      `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
      [`${id}-root`, id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function addLiveBookmark(
  isolated: IsolatedPostgresRuntime,
  collectionId: string,
  nodeId: string,
): Promise<void> {
  await isolated.runtime.pool.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node')`,
    [nodeId],
  );
  await isolated.runtime.pool.query(
    `insert into nodes
      (id, collection_id, parent_id, kind, is_root, title, url, position_token, resource_revision, children_revision)
     values ($1, $2, $3, 'bookmark', false, $1, 'https://example.test/hide', $1, 'r1', 'ch1')`,
    [nodeId, collectionId, `${collectionId}-root`],
  );
}

async function insertHide(
  isolated: IsolatedPostgresRuntime,
  collectionId: string,
  nodeId: string,
  actionId: string,
): Promise<void> {
  const target = JSON.stringify({ kind: 'bookmark', id: nodeId, collectionId });
  await isolated.runtime.pool.query(
    `insert into moderation_cases(
       id, reporter_account_id, target_kind, target_id, parent_id, target_json, target_fingerprint,
       category, description, status, revision, created_at, updated_at)
     values ($1, 'explore-page-owner-account', 'bookmark', $2, $3, $4::jsonb, $1, 'spam', 'hide', 'resolved', '1', now(), now())`,
    [actionId, nodeId, collectionId, target],
  );
  await isolated.runtime.pool.query(
    `insert into moderation_actions(
       id, case_id, target_kind, target_id, parent_id, target_json, target_fingerprint, action, reason,
       actor_account_id, state, revision, created_at)
     values ($1, $1, 'bookmark', $2, $3, $4::jsonb, $1, 'hide_public', 'hide', 'explore-page-owner-account', 'active', '1', now())`,
    [actionId, nodeId, collectionId, target],
  );
}

async function softDeleteNode(isolated: IsolatedPostgresRuntime, nodeId: string): Promise<void> {
  await isolated.runtime.pool.query(
    `update nodes set deleted_at = now(), deleted_commit_ordinal = 1 where id = $1`,
    [nodeId],
  );
}

async function restoreNode(isolated: IsolatedPostgresRuntime, nodeId: string): Promise<void> {
  await isolated.runtime.pool.query(
    `update nodes set deleted_at = null, deleted_commit_ordinal = null where id = $1`,
    [nodeId],
  );
}

async function revokeHide(isolated: IsolatedPostgresRuntime, actionId: string): Promise<void> {
  await isolated.runtime.pool.query(
    `update moderation_actions
        set state = 'revoked', revoked_at = now(), revoke_reason = 'unhide'
      where id = $1`,
    [actionId],
  );
}

async function seedPreferenceCollection(
  isolated: IsolatedPostgresRuntime,
  id: string,
  title: string,
  tags: readonly string[],
  language: string | null,
): Promise<void> {
  const payload = { extensions: { tags, ...(language ? { language } : {}) } };
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [id, `${id}-root`],
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at,
         payload_json, payload_schema_version, payload_authority_status)
       values ($1, $2, $3, 'bookmarks', 'public', $4, 'r1', 'c1', 'p1', $1, now(), now(),
               $5::jsonb, 1, 'backfilled')`,
      [id, OWNER, title, `${id}-root`, JSON.stringify(payload)],
    );
    await client.query(
      `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
      [`${id}-root`, id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function liveCount(isolated: IsolatedPostgresRuntime, collectionId: string): Promise<number> {
  const result = await isolated.runtime.pool.query<{ live_node_count: string | number }>(
    `select live_node_count from collections where id = $1`,
    [collectionId],
  );
  return Number(result.rows[0]?.live_node_count);
}

async function seedExploreFixture(
  isolated: IsolatedPostgresRuntime,
  window: { readonly fromDayInclusive: string; readonly toDayExclusive: string },
): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    // The Explore statement joins accounts for the creator identity (52ae9c55f,
    // cg-01); without this row every positive listing query returns empty.
    await client.query(
      `insert into accounts(id, subject_id, status) values ($1, $2, 'active')`,
      ['explore-page-owner-account', OWNER],
    );
    const collections: Array<{
      id: string;
      visibility: 'public' | 'unlisted';
      updatedAt: string;
      title: string;
      tags?: readonly string[];
    }> = [
      { id: VIEWED, visibility: 'public', updatedAt: '2026-08-20T12:00:00.000Z', title: 'Viewed Alpha Notes explore-alpha' },
      { id: QUIET, visibility: 'public', updatedAt: '2026-08-21T12:00:00.000Z', title: 'Quiet Beta Notes explore-alpha' },
      { id: STALE, visibility: 'public', updatedAt: '2026-08-18T12:00:00.000Z', title: 'Stale Gamma Notes' },
      { id: UNLISTED, visibility: 'unlisted', updatedAt: '2026-08-21T18:00:00.000Z', title: 'Unlisted Delta Notes' },
      { id: LINKS_MANY, visibility: 'public', updatedAt: '2026-08-10T12:00:00.000Z', title: 'Links Many Folders explore-links' },
      { id: LINKS_FEW, visibility: 'public', updatedAt: '2026-08-11T12:00:00.000Z', title: 'Links Few Folders explore-links' },
      {
        id: TAGGED_DESIGN, visibility: 'public', updatedAt: '2026-08-12T12:00:00.000Z',
        title: 'Tagged Design Path', tags: ['Design'],
      },
      {
        id: TAGGED_OTHER, visibility: 'public', updatedAt: '2026-08-13T12:00:00.000Z',
        title: 'Tagged Engineering Path', tags: ['Engineering'],
      },
    ];
    for (const collection of collections) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [collection.id, `${collection.id}-root`],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at,
           payload_json, payload_schema_version, payload_authority_status)
         values ($1, $2, $3, 'bookmarks', $4, $5, 'r1', 'c1', 'p1', $6, $7::timestamptz, $7::timestamptz,
                 $8::jsonb, 1, 'backfilled')`,
        [
          collection.id,
          OWNER,
          collection.title,
          collection.visibility,
          `${collection.id}-root`,
          collection.id,
          collection.updatedAt,
          JSON.stringify({ tags: collection.tags ?? [] }),
        ],
      );
      await client.query(
        `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, $2, 'r1', 'ch1')`,
        [`${collection.id}-root`, collection.id],
      );
    }
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node'), ($2, 'node')`,
        [`${LINKS_MANY}-folder-1`, `${LINKS_MANY}-folder-2`],
      );
      await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, position_token,
         resource_revision, children_revision)
       values
        ($1, $2, $3, 'folder', false, 'Nested one', 'A001', 'r1', 'ch1'),
        ($4, $2, $3, 'folder', false, 'Nested two', 'A002', 'r1', 'ch1')`,
      [`${LINKS_MANY}-folder-1`, LINKS_MANY, `${LINKS_MANY}-root`, `${LINKS_MANY}-folder-2`],
    );
    const inWindowDay = window.fromDayInclusive;
    const beforeWindow = addUtcDays(window.fromDayInclusive, -1);
    await client.query(
      `insert into publication_insight_daily (collection_id, day, event_type, node_id, count)
       values
        ($1, $2::date, 'collection_view', '', 7),
        ($3, $4::date, 'collection_view', '', 11),
        ($5, $2::date, 'collection_view', '', 4)`,
      [VIEWED, inWindowDay, STALE, beforeWindow, UNLISTED],
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values
         ('explore-viewed-tldr', 'annotation'), ('explore-quiet-private-tldr', 'annotation')`,
    );
    await client.query(
      `insert into annotations(
         id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
         visibility, resource_revision, created_at, updated_at, payload_json)
       values
         ('explore-viewed-tldr', $1::text, 'collection', $1::text, $3::text, 'tldr', 'plain', $4::jsonb, 'public',
          'rev-viewed', $2::timestamptz, $2::timestamptz,
          jsonb_build_object(
            'id', 'explore-viewed-tldr', 'collectionId', $1::text,
            'subject', jsonb_build_object('type', 'collection', 'id', $1::text),
            'creator', jsonb_build_object('id', $3::text, 'name', 'Explore Owner'),
            'type', 'tldr', 'format', 'plain', 'value', $4::jsonb, 'visibility', 'public',
            'revision', 'rev-viewed', 'createdAt', $2::text, 'updatedAt', $2::text)),
         ('explore-quiet-private-tldr', $5::text, 'collection', $5::text, $3::text, 'tldr', 'plain', $6::jsonb, 'private',
          'rev-quiet', $2::timestamptz, $2::timestamptz,
          jsonb_build_object(
            'id', 'explore-quiet-private-tldr', 'collectionId', $5::text,
            'subject', jsonb_build_object('type', 'collection', 'id', $5::text),
            'creator', jsonb_build_object('id', $3::text, 'name', 'Explore Owner'),
            'type', 'tldr', 'format', 'plain', 'value', $6::jsonb, 'visibility', 'private',
            'revision', 'rev-quiet', 'createdAt', $2::text, 'updatedAt', $2::text))`,
      [VIEWED, '2026-08-20T12:30:00.000Z', OWNER, JSON.stringify('Viewed curator pick'),
        QUIET, JSON.stringify('PRIVATE QUIET TLDR')],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
