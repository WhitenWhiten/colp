import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationDirectoryStatement,
  createPostgresPublicationDirectoryReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationDirectoryPage,
  type PublicationPrincipal,
} from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const MIGRATION_NAME = '202608011100_collections_directory_filter_indexes';
const PREVIOUS_STABLE_MIGRATION = '202608011000_nodes_live_sibling_position_c_idx';
const Q_TRGM_INDEX = 'collections_publication_directory_search_trgm_idx';
const TAGS_GIN_INDEX = 'collections_publication_directory_tags_idx';
const ORDER_INDEX = 'collections_publication_directory_order_idx';

// pg_get_indexdef wraps the partial predicate in the deparsed indexdef; tolerate
// both the bare AND form and per-clause parenthesized normalization (R08 note).
const LIVE_PUBLISHED_PREDICATE =
  /\(?\s*deleted_at IS NULL\s*\)?\s+AND\s+\(?\s*publication_slug IS NOT NULL\s*\)?\s+AND\s+\(?\s*published_at IS NOT NULL\s*\)?/i;

const OWNER = 'directory-filter-owner';
const OTHER_OWNER = 'directory-filter-other';
const MEMBER = 'directory-filter-member';
const OUTSIDER = 'directory-filter-outsider';

const anon: PublicationPrincipal = { kind: 'anonymous' };
const ownerPrincipal: PublicationPrincipal = { kind: 'account', principalId: 'owner-account', subjectId: OWNER };
const memberPrincipal: PublicationPrincipal = { kind: 'account', principalId: 'member-account', subjectId: MEMBER };
const outsiderPrincipal: PublicationPrincipal = { kind: 'account', principalId: 'outsider-account', subjectId: OUTSIDER };

let isolated: IsolatedPostgresRuntime;

describeWithPostgres('Publication Directory filter indexes', () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publication_directory_filter_indexes', {
      maxConnections: 6,
      applicationName: 'known-publication-directory-filter',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedDirectoryFilterFixture(isolated);
  }, 240_000);

  afterAll(async () => isolated?.close());

  test('migration creates the generated column and both filter indexes on the live/published predicate and keeps the order index', async () => {
    const column = await isolated.runtime.pool.query<{
      is_generated: string;
      generation_expression: string | null;
    }>(`select is_generated, generation_expression
          from information_schema.columns
         where table_schema = current_schema() and table_name = 'collections'
           and column_name = 'directory_search_text'`);
    assert.equal(column.rowCount, 1);
    assert.equal(column.rows[0]?.is_generated, 'ALWAYS');
    const expression = column.rows[0]?.generation_expression ?? '';
    assert.match(expression, /lower\(/i);
    assert.match(expression, /coalesce\(title/i);
    assert.match(expression, /coalesce\(summary/i);
    assert.doesNotMatch(expression, /normalize\(|NFKC/i);

    const trgm = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = current_schema() and indexname = $1`,
      [Q_TRGM_INDEX],
    );
    assert.equal(trgm.rowCount, 1);
    assert.match(trgm.rows[0]?.indexdef ?? '', /USING gin \(directory_search_text public\.gin_trgm_ops\)/i);
    assert.match(trgm.rows[0]?.indexdef ?? '', LIVE_PUBLISHED_PREDICATE);

    const tags = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = current_schema() and indexname = $1`,
      [TAGS_GIN_INDEX],
    );
    assert.equal(tags.rowCount, 1);
    assert.match(
      tags.rows[0]?.indexdef ?? '',
      /USING gin [\s\S]*jsonb_typeof[\s\S]*extensions[\s\S]*tags/i,
    );
    assert.match(tags.rows[0]?.indexdef ?? '', LIVE_PUBLISHED_PREDICATE);

    const order = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = current_schema() and indexname = $1`,
      [ORDER_INDEX],
    );
    assert.equal(order.rowCount, 1);
    assert.match(order.rows[0]?.indexdef ?? '', /updated_at DESC/i);
  });

  test('upgrades from the previous migration and rolls back without leaving R10 objects behind', async () => {
    const upgrade = await createIsolatedPostgresRuntime('publication_directory_filter_index_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      assert.equal(await columnPresent(upgrade, 'directory_search_text'), false);
      assert.equal(await indexPresent(upgrade, Q_TRGM_INDEX), false);
      assert.equal(await indexPresent(upgrade, TAGS_GIN_INDEX), false);
      assert.equal(await indexPresent(upgrade, ORDER_INDEX), true);

      const latest = await migrator.migrateTo(MIGRATION_NAME);
      if (latest.error) throw latest.error;
      assert.equal(await columnPresent(upgrade, 'directory_search_text'), true);
      assert.equal(await indexPresent(upgrade, Q_TRGM_INDEX), true);
      assert.equal(await indexPresent(upgrade, TAGS_GIN_INDEX), true);
      assert.equal(await indexPresent(upgrade, ORDER_INDEX), true);

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await columnPresent(upgrade, 'directory_search_text'), false);
      assert.equal(await indexPresent(upgrade, Q_TRGM_INDEX), false);
      assert.equal(await indexPresent(upgrade, TAGS_GIN_INDEX), false);
      assert.equal(await indexPresent(upgrade, ORDER_INDEX), true);

      const forward = await migrator.migrateTo(MIGRATION_NAME);
      if (forward.error) throw forward.error;
      assert.equal(await indexPresent(upgrade, Q_TRGM_INDEX), true);
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('q matches title-only, summary-only, and cross-boundary substrings', async () => {
    assert.deepEqual(await matrixIds(anon, { q: 'alphabeta' }), ['bf-title']);
    assert.deepEqual(await matrixIds(anon, { q: 'zetatheta' }), ['bf-summary']);
    assert.deepEqual(await matrixIds(anon, { q: 'lo wo' }), ['bf-boundary']);
    assert.deepEqual(await matrixIds(anon, { q: 'hello world' }), ['bf-boundary']);
  });

  test('q is case-insensitive for ASCII and lowercase-accented text', async () => {
    // The decomposed row literally contains the ASCII substring 'cafe' (prefix of
    // 'cafe' + combining acute), so case-insensitive 'CAFE' matches both rows.
    assert.deepEqual(await matrixIds(anon, { q: 'CAFE' }), ['bf-nfd', 'bf-case-ascii']);
    assert.deepEqual(await matrixIds(anon, { q: 'ALPHABETA' }), ['bf-title']);
    assert.deepEqual(await matrixIds(anon, { q: 'El Niño' }), ['bf-case-accent']);
    assert.deepEqual(await matrixIds(anon, { q: 'eL nIÑo' }), ['bf-case-accent']);
  });

  test('q applies the NFC contract without NFKC compatibility expansion', async () => {
    // Half-width NFC q must NOT reach the full-width stored text (only NFKC would).
    assert.deepEqual(await matrixIds(anon, { q: 'fullwidth' }), []);
    // The full-width input survives NFC and matches the full-width stored text.
    assert.deepEqual(
      await matrixIds(anon, { q: 'ｆｕｌｌｗｉｄｔｈ' }),
      ['bf-fullwidth'],
    );
    // Precomposed NFC q matches the precomposed row and never the decomposed row.
    assert.deepEqual(await matrixIds(anon, { q: 'café' }), ['bf-nfc']);
  });

  test('q treats percent, underscore, and backslash as literal data', async () => {
    assert.deepEqual(await matrixIds(anon, { q: '50%' }), ['bf-percent']);
    // '%' is a literal data character, not a wildcard: the full literal '50% off'
    // matches only bf-percent, while the percent-free '50 off' matches nothing.
    assert.deepEqual(await matrixIds(anon, { q: '50% off' }), ['bf-percent']);
    assert.deepEqual(await matrixIds(anon, { q: '50 off' }), []);
    // '_' must not act as a single-character wildcard.
    assert.deepEqual(await matrixIds(anon, { q: '5_' }), []);
    assert.deepEqual(await matrixIds(anon, { q: 'snake_case' }), ['bf-underscore']);
    assert.deepEqual(await matrixIds(anon, { q: 'snakexcase' }), ['bf-snakexcase']);
    // '\' must not escape a pattern character; it matches the literal backslash only.
    assert.deepEqual(await matrixIds(anon, { q: 'alpha\\one' }), ['bf-backslash']);
    assert.deepEqual(await matrixIds(anon, { q: 'alphaone' }), ['bf-backslash-plain']);
  });

  test('tag filter matches string-array tags and ignores missing, empty, malformed, and duplicate values', async () => {
    assert.deepEqual(await matrixIds(anon, { tag: 'apple' }), ['bf-tag-apple', 'bf-tag-dup']);
    assert.deepEqual(await matrixIds(anon, { tag: 'banana' }), ['bf-tag-apple']);
    assert.deepEqual(await matrixIds(anon, { tag: 'nope' }), []);
    // Private, absent, empty, object, and scalar-string tag payloads must not match.
    for (const row of [
      'bf-private-tag', 'bf-tag-absent', 'bf-tag-empty',
      'bf-tag-malformed-obj', 'bf-tag-malformed-str',
    ]) {
      assert.ok(!(await matrixIds(anon, { tag: 'apple' })).includes(row));
    }
  });

  test('q and tag filters preserve protected authorization', async () => {
    assert.deepEqual(await matrixIds(anon, { q: 'protected owner' }), []);
    assert.deepEqual(await matrixIds(anon, { tag: 'secret-tag' }), []);
    assert.deepEqual(await matrixIds(anon, { tag: 'member-tag' }), []);
    assert.deepEqual(await matrixIds(ownerPrincipal, { q: 'protected owner' }), ['bf-protected-owner']);
    assert.deepEqual(await matrixIds(ownerPrincipal, { tag: 'secret-tag' }), ['bf-protected-owner']);
    assert.deepEqual(await matrixIds(ownerPrincipal, { tag: 'member-tag' }), []);
    assert.deepEqual(await matrixIds(memberPrincipal, { tag: 'member-tag' }), ['bf-protected-member']);
    assert.deepEqual(await matrixIds(outsiderPrincipal, { q: 'protected owner' }), []);
    assert.deepEqual(await matrixIds(outsiderPrincipal, { tag: 'secret-tag' }), []);
    assert.deepEqual(await matrixIds(outsiderPrincipal, { tag: 'member-tag' }), []);
  });

  test('filtered continuation pages are stable with no duplicates or skips', async () => {
    const tagIds = await fullPagedIds(anon, { tag: 'apple' }, 1);
    assert.deepEqual(tagIds, ['bf-tag-apple', 'bf-tag-dup']);
    assert.equal(new Set(tagIds).size, tagIds.length);
    const qIds = await fullPagedIds(anon, { q: 'tag' }, 2);
    // 'AlphaBetaGamma' lowercases to 'alphabetagamma', which contains the substring
    // 'tag' at the beta|gamma boundary, so it leads the q='tag' result set.
    assert.deepEqual(qIds, [
      'bf-title', 'bf-tag-apple', 'bf-tag-dup', 'bf-tag-empty',
      'bf-tag-malformed-obj', 'bf-tag-malformed-str', 'bf-tag-absent',
    ]);
    assert.equal(new Set(qIds).size, qIds.length);
  });

  test('80k q and tag plans use the filter indexes with bounded rows and buffers', async () => {
    const qPlan = await explain(
      buildPublicationDirectoryStatement({ principal: 'anonymous', filter: { q: 'needle-42' }, limit: 50 }),
    );
    const qEvidence = assertBoundedFilterPlan(qPlan, Q_TRGM_INDEX, /directory_search_text/, 200, 30_000, 51);
    console.info(`[r10-plan] q='needle-42' first page rows=${qEvidence.rows} buffers=${qEvidence.blocks}`);

    const qContinuation = await explain(
      buildPublicationDirectoryStatement(
        {
          principal: 'anonymous',
          filter: { q: 'needle-42' },
          limit: 50,
          after: { orderingUpdatedAtMicros: String(BASE_MICROS - 39007), idLocator: '0'.repeat(32) },
        },
        'bulk-039007',
      ),
    );
    const qContinuationEvidence = assertBoundedFilterPlan(
      qContinuation, Q_TRGM_INDEX, /directory_search_text/, 200, 30_000, 51,
    );
    console.info(`[r10-plan] q='needle-42' continuation rows=${qContinuationEvidence.rows} buffers=${qContinuationEvidence.blocks}`);

    const tagPlan = await explain(
      buildPublicationDirectoryStatement({ principal: 'anonymous', filter: { tag: 'bulk-tag-apple' }, limit: 50 }),
    );
    const tagEvidence = assertBoundedFilterPlan(tagPlan, TAGS_GIN_INDEX, /payload_json\s*->\s*'extensions'/i, 300, 30_000, 51);
    console.info(`[r10-plan] tag='bulk-tag-apple' first page rows=${tagEvidence.rows} buffers=${tagEvidence.blocks}`);

    const ownerPlan = await explain(
      buildPublicationDirectoryStatement(
        { principal: { subjectId: OWNER }, filter: { q: 'owner protected' }, limit: 50 },
      ),
    );
    const ownerEvidence = assertBoundedFilterPlan(ownerPlan, Q_TRGM_INDEX, /directory_search_text/, 400, 30_000, 51);
    console.info(`[r10-plan] owner q='owner protected' first page rows=${ownerEvidence.rows} buffers=${ownerEvidence.blocks}`);
  }, 120_000);

  test('80k q, tag, and q+tag full paged results match a simple reference filter', async () => {
    const rows = await readReferenceRows(isolated);
    const cases: ReadonlyArray<{
      principal: PublicationPrincipal;
      filter: { q?: string; tag?: string };
      limit: number;
    }> = [
      { principal: anon, filter: { q: 'needle-42' }, limit: 13 },
      { principal: anon, filter: { q: 'plain summary 12' }, limit: 500 },
      { principal: anon, filter: { tag: 'bulk-tag-apple' }, limit: 13 },
      { principal: anon, filter: { q: 'needle-42', tag: 'bulk-tag-apple' }, limit: 13 },
    ];
    for (const scenario of cases) {
      const expected = referenceIds(rows, scenario.principal, scenario.filter, memberIds);
      const actual = await fullPagedIds(scenario.principal, scenario.filter, scenario.limit);
      assertFullPageEqualsReference(actual, expected, JSON.stringify(scenario.filter));
    }
  }, 120_000);

  test('80k protected authorization preserves full paged results at scale', async () => {
    const rows = await readReferenceRows(isolated);
    const ownerFilter = { q: 'owner protected' } as const;
    const expectedOwner = referenceIds(rows, ownerPrincipal, ownerFilter, memberIds);
    assert.ok(expectedOwner.length >= 200, `expected at least 200 owner-protected matches, saw ${expectedOwner.length}`);
    const actualOwner = await fullPagedIds(ownerPrincipal, ownerFilter, 13);
    assertFullPageEqualsReference(actualOwner, expectedOwner, 'owner protected');
    assert.deepEqual(await fullPagedIds(anon, ownerFilter, 13), []);
    assert.deepEqual(await fullPagedIds(outsiderPrincipal, ownerFilter, 13), []);

    const memberFilter = { q: 'member secret' } as const;
    const expectedMember = referenceIds(rows, memberPrincipal, memberFilter, memberIds);
    const actualMember = await fullPagedIds(memberPrincipal, memberFilter, 13);
    assertFullPageEqualsReference(actualMember, expectedMember, 'member secret');
    assert.deepEqual(await fullPagedIds(ownerPrincipal, memberFilter, 13), []);
  }, 120_000);

  test('index-enabled and index-disabled paths return identical results for q and tag', async () => {
    const qStatement = buildPublicationDirectoryStatement({
      principal: 'anonymous', filter: { q: 'needle-42' }, limit: 500,
    });
    const tagStatement = buildPublicationDirectoryStatement({
      principal: 'anonymous', filter: { tag: 'bulk-tag-apple' }, limit: 500,
    });
    const client = await isolated.runtime.pool.connect();
    try {
      const indexedQ = await client.query<{ id: string }>(qStatement.text, [...qStatement.values]);
      const indexedTag = await client.query<{ id: string }>(tagStatement.text, [...tagStatement.values]);
      await client.query('begin');
      await client.query('set local enable_bitmapscan = off');
      const unindexedQ = await client.query<{ id: string }>(qStatement.text, [...qStatement.values]);
      const unindexedTag = await client.query<{ id: string }>(tagStatement.text, [...tagStatement.values]);
      await client.query('commit');
      assert.deepEqual(unindexedQ.rows.map((row) => row.id), indexedQ.rows.map((row) => row.id));
      assert.deepEqual(unindexedTag.rows.map((row) => row.id), indexedTag.rows.map((row) => row.id));
    } finally {
      client.release();
    }
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * Fixture seeding
 * ------------------------------------------------------------------ */

const BASE_MICROS = 1767225600000000; // 2026-01-01T00:00:00Z

interface BehaviorRow {
  readonly id: string;
  readonly visibility: 'public' | 'protected' | 'private';
  readonly owner: string;
  readonly title: string;
  readonly summary: string | null;
  /** Exact JSONB payload for payload_json; null leaves payload_json NULL. */
  readonly payloadJson: string | null;
}

const BEHAVIOR_ROWS: readonly BehaviorRow[] = [
  { id: 'bf-title', visibility: 'public', owner: OWNER, title: 'AlphaBetaGamma', summary: null, payloadJson: null },
  { id: 'bf-summary', visibility: 'public', owner: OWNER, title: 'Noise', summary: 'ZetaTheta', payloadJson: null },
  { id: 'bf-boundary', visibility: 'public', owner: OWNER, title: 'hello', summary: 'world', payloadJson: null },
  { id: 'bf-percent', visibility: 'public', owner: OWNER, title: 'discount 50% off', summary: null, payloadJson: null },
  { id: 'bf-underscore', visibility: 'public', owner: OWNER, title: 'snake_case_name', summary: null, payloadJson: null },
  { id: 'bf-snakexcase', visibility: 'public', owner: OWNER, title: 'snakexcase', summary: null, payloadJson: null },
  { id: 'bf-backslash', visibility: 'public', owner: OWNER, title: 'alpha\\one beta', summary: null, payloadJson: null },
  { id: 'bf-backslash-plain', visibility: 'public', owner: OWNER, title: 'alphaone beta', summary: null, payloadJson: null },
  // NFC precomposed é (U+00E9) row.
  { id: 'bf-nfc', visibility: 'public', owner: OWNER, title: 'café', summary: null, payloadJson: null },
  // NFD decomposed e + combining acute (U+0065 U+0301) row.
  { id: 'bf-nfd', visibility: 'public', owner: OWNER, title: 'café', summary: null, payloadJson: null },
  // Full-width lowercase letters (U+FF46..): NFKC-only compatibility source.
  { id: 'bf-fullwidth', visibility: 'public', owner: OWNER, title: 'ｆｕｌｌｗｉｄｔｈ', summary: null, payloadJson: null },
  { id: 'bf-case-accent', visibility: 'public', owner: OWNER, title: 'El Niño', summary: null, payloadJson: null },
  { id: 'bf-case-ascii', visibility: 'public', owner: OWNER, title: 'CAFE', summary: null, payloadJson: null },
  { id: 'bf-tag-apple', visibility: 'public', owner: OWNER, title: 'Tag apple row', summary: null, payloadJson: '{"tags":["apple","banana"]}' },
  { id: 'bf-tag-dup', visibility: 'public', owner: OWNER, title: 'Tag dup row', summary: null, payloadJson: '{"tags":["apple","apple"]}' },
  { id: 'bf-tag-empty', visibility: 'public', owner: OWNER, title: 'Tag empty row', summary: null, payloadJson: '{"tags":[]}' },
  { id: 'bf-tag-malformed-obj', visibility: 'public', owner: OWNER, title: 'Tag obj row', summary: null, payloadJson: '{"tags":{"apple":true}}' },
  { id: 'bf-tag-malformed-str', visibility: 'public', owner: OWNER, title: 'Tag str row', summary: null, payloadJson: '{"tags":"apple"}' },
  { id: 'bf-tag-absent', visibility: 'public', owner: OWNER, title: 'Tag absent row', summary: null, payloadJson: '{}' },
  { id: 'bf-private-tag', visibility: 'private', owner: OWNER, title: 'Tag private row', summary: null, payloadJson: '{"tags":["apple"]}' },
  { id: 'bf-protected-owner', visibility: 'protected', owner: OWNER, title: 'Protected owner row', summary: null, payloadJson: '{"tags":["secret-tag"]}' },
  { id: 'bf-protected-member', visibility: 'protected', owner: OTHER_OWNER, title: 'Protected member row', summary: null, payloadJson: '{"tags":["member-tag"]}' },
];

async function seedDirectoryFilterFixture(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    // 80k collections + roots maintain R10 GINs and the live_node_count
    // trigger on every node insert, which exceeds the pool's 15s default
    // statement_timeout. Lift it for the seed transaction (same idiom as
    // the member-recall 80k fixture); the beforeAll wall-clock cap still
    // bounds the whole seed.
    await client.query('set local statement_timeout = 0');
    await client.query('set constraints all deferred');

    // Bulk live/published public rows. n%1000=7 rows carry the needle-42 summary AND the
    // bulk-tag-apple tag; n%1000=17 rows carry the tag only. 80k distinct microseconds.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'bulk-' || lpad(n::text, 6, '0'), 'collection' from generate_series(1, 80000) n
      union all
      select 'bulk-root-' || lpad(n::text, 6, '0'), 'node' from generate_series(1, 80000) n
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status)
      select 'bulk-' || lpad(n::text, 6, '0'), $1, 'bulk seed title ' || n::text,
             case when n % 1000 = 7 then 'summary needle-42 target'
                  else 'plain summary ' || n::text end,
             'bookmarks', 'public', 'bulk-root-' || lpad(n::text, 6, '0'),
             'r1', 'c1', 'p1', 'bulk-' || lpad(n::text, 6, '0'),
             '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz - n * interval '1 microsecond',
             case when n % 1000 = 7 or n % 1000 = 17
               then jsonb_build_object('tags', jsonb_build_array('bulk-tag-apple'))
               else '{}'::jsonb end,
             1, 'backfilled'
      from generate_series(1, 80000) n
    `, [OWNER]);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'bulk-root-' || lpad(n::text, 6, '0'), 'bulk-' || lpad(n::text, 6, '0'),
             'folder', true, 'Bulk root ' || n::text, 'r1', 'ch1'
        from generate_series(1, 80000) n
    `);

    // 200 protected bulk rows owned by OWNER with a distinct tag; distinct microsecond range.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'bulk-owner-prot-' || lpad(n::text, 4, '0'), 'collection' from generate_series(1, 200) n
      union all
      select 'bulk-owner-prot-root-' || lpad(n::text, 4, '0'), 'node' from generate_series(1, 200) n
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at, payload_json,
         payload_schema_version, payload_authority_status)
      select 'bulk-owner-prot-' || lpad(n::text, 4, '0'), $1, 'owner protected title ' || n::text,
             null, 'bookmarks', 'protected', 'bulk-owner-prot-root-' || lpad(n::text, 4, '0'),
             'r1', 'c1', 'p1', 'bulk-owner-prot-' || lpad(n::text, 4, '0'),
             '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz - (100000 + n) * interval '1 microsecond',
             jsonb_build_object('tags', jsonb_build_array('bulk-owner-protected-tag')),
             1, 'backfilled'
      from generate_series(1, 200) n
    `, [OWNER]);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'bulk-owner-prot-root-' || lpad(n::text, 4, '0'), 'bulk-owner-prot-' || lpad(n::text, 4, '0'),
             'folder', true, 'Owner prot root ' || n::text, 'r1', 'ch1'
        from generate_series(1, 200) n
    `);

    // Behavior rows: distinct microsecond range far from the bulk data.
    for (const [index, row] of BEHAVIOR_ROWS.entries()) {
      const micros = BASE_MICROS - (1_000_000 + index * 1000);
      const updatedAt = new Date(micros / 1000).toISOString();
      const rootId = `${row.id}-root`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [row.id, rootId],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at, payload_json,
           payload_schema_version, payload_authority_status)
         values ($1, $2, $3, $4, 'bookmarks', $5, $6, 'r1', 'c1', 'p1', $1,
                 '2026-01-01T00:00:00Z'::timestamptz, $7::timestamptz, $8::jsonb, 1, 'backfilled')`,
        [row.id, row.owner, row.title, row.summary, row.visibility, rootId, updatedAt, row.payloadJson ?? '{}'],
      );
      await client.query(
        `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, $3, 'r1', 'ch1')`,
        [rootId, row.id, row.title],
      );
    }

    // Secret tagged rows: protected for owner/member, private never visible.
    const secrets: ReadonlyArray<{
      id: string;
      owner: string;
      visibility: 'protected' | 'private';
      title: string;
      payloadJson: string;
      member?: string;
    }> = [
      { id: 'bulk-owner-secret', owner: OWNER, visibility: 'protected', title: 'owner secret title', payloadJson: '{"tags":["bulk-owner-tag"]}' },
      { id: 'bulk-member-secret', owner: OTHER_OWNER, visibility: 'protected', title: 'member secret title', payloadJson: '{"tags":["bulk-member-tag"]}', member: MEMBER },
      { id: 'bulk-private-tag', owner: OWNER, visibility: 'private', title: 'private tagged title', payloadJson: '{"tags":["bulk-private-tag"]}' },
    ];
    for (const [index, secret] of secrets.entries()) {
      const micros = BASE_MICROS - (300_000 + index * 1000);
      const updatedAt = new Date(micros / 1000).toISOString();
      const rootId = `${secret.id}-root`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [secret.id, rootId],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at, payload_json,
           payload_schema_version, payload_authority_status)
         values ($1, $2, $3, null, 'bookmarks', $4, $5, 'r1', 'c1', 'p1', $1,
                 '2026-01-01T00:00:00Z'::timestamptz, $6::timestamptz, $7::jsonb, 1, 'backfilled')`,
        [secret.id, secret.owner, secret.title, secret.visibility, rootId, updatedAt, secret.payloadJson],
      );
      await client.query(
        `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, $3, 'r1', 'ch1')`,
        [rootId, secret.id, secret.title],
      );
      if (secret.member !== undefined) {
        await client.query(
          `insert into collection_members(collection_id, subject_id, role) values ($1, $2, 'viewer')`,
          [secret.id, secret.member],
        );
      }
    }

    await client.query(
      `insert into collection_members(collection_id, subject_id, role) values ($1, $2, 'viewer')`,
      ['bf-protected-member', MEMBER],
    );

    await client.query('commit');
    // VACUUM flushes GIN pending lists; ANALYZE alone can double-count Actual Rows.
    await isolatedRuntime.runtime.pool.query('vacuum analyze collections');
    await isolatedRuntime.runtime.pool.query('vacuum analyze nodes');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Reference filter (simple, obviously-correct contract)
 * ------------------------------------------------------------------ */

interface ReferenceRow {
  readonly id: string;
  readonly owner: string;
  readonly visibility: 'public' | 'protected' | 'private' | 'unlisted';
  readonly title: string;
  readonly summary: string | null;
  readonly tags: unknown;
  readonly micros: number;
}

const memberIds = new Set<string>(['bf-protected-member', 'bulk-member-secret']);

function referenceVisible(
  row: ReferenceRow,
  principal: PublicationPrincipal,
  members: ReadonlySet<string>,
): boolean {
  if (row.visibility === 'public') return true;
  if (row.visibility !== 'protected') return false;
  if (principal === 'anonymous') return false;
  return row.owner === principal.subjectId || members.has(row.id);
}

function referenceMatchesQ(row: ReferenceRow, q: string): boolean {
  return (`${row.title} ${row.summary ?? ''}`).toLocaleLowerCase('en-US').includes(q);
}

function referenceMatchesTag(row: ReferenceRow, tag: string): boolean {
  return Array.isArray(row.tags) && row.tags.some((value) => typeof value === 'string' && value === tag);
}

function referenceIds(
  rows: readonly ReferenceRow[],
  principal: PublicationPrincipal,
  filter: { readonly q?: string; readonly tag?: string },
  members: ReadonlySet<string>,
): string[] {
  const { q, tag } = filter;
  return rows
    .filter((row) => referenceVisible(row, principal, members))
    .filter((row) => q === undefined || referenceMatchesQ(row, q))
    .filter((row) => tag === undefined || referenceMatchesTag(row, tag))
    .sort((a, b) => b.micros - a.micros || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => row.id);
}

let cachedReference: ReferenceRow[] | undefined;

async function readReferenceRows(isolatedRuntime: IsolatedPostgresRuntime): Promise<ReferenceRow[]> {
  if (cachedReference !== undefined) return cachedReference;
  const result = await isolatedRuntime.runtime.pool.query<{
    id: string;
    owner: string;
    visibility: string;
    title: string;
    summary: string | null;
    tags: unknown;
    micros: string;
  }>(
    `select c.id,
            c.owner_subject_id as owner,
            c.visibility,
            c.title,
            c.summary,
            c.payload_json -> 'tags' as tags,
            (extract(epoch from c.updated_at) * 1000000)::bigint::text as micros
       from collections c`,
  );
  cachedReference = result.rows.map((row) => ({
    id: row.id,
    owner: row.owner,
    visibility: row.visibility as ReferenceRow['visibility'],
    title: row.title,
    summary: row.summary,
    tags: row.tags ?? null,
    micros: Number(row.micros),
  }));
  return cachedReference;
}

/* ------------------------------------------------------------------ *
 * Query helpers
 * ------------------------------------------------------------------ */

function queryPorts(isolatedRuntime: IsolatedPostgresRuntime) {
  return {
    reads: createPostgresPublicationDirectoryReadPort(isolatedRuntime.runtime),
    cursors: createPublicationCursorKeyring({
      active: { id: 'directory-filter-pg-v1', secret: Buffer.alloc(32, 71).toString('base64') },
      retained: [],
    }),
    origin: 'https://known.example',
  };
}

async function matrixIds(
  principal: PublicationPrincipal,
  filter: { q?: string; tag?: string },
): Promise<string[]> {
  const ports = queryPorts(isolated!);
  try {
    const page = await getPublicationDirectoryPage(ports, {
      principal, query: { ...filter, limit: 100 },
    });
    assert.equal(page.nextCursor, null, 'semantic matrix query must fit a single page');
    return page.directory.collections.map((collection) => collection.id);
  } finally {
    ports.cursors.destroy();
  }
}

async function fullPagedIds(
  principal: PublicationPrincipal,
  filter: { q?: string; tag?: string },
  limit: number,
): Promise<string[]> {
  const ports = queryPorts(isolated!);
  try {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getPublicationDirectoryPage(ports, {
        principal,
        query: { ...filter, limit, ...(cursor === undefined ? {} : { cursor }) },
      });
      ids.push(...page.directory.collections.map((collection) => collection.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return ids;
  } finally {
    ports.cursors.destroy();
  }
}

function assertFullPageEqualsReference(actual: string[], expected: string[], label: string): void {
  assert.deepEqual(actual, expected, `full paged results diverged from reference for ${label}`);
  assert.equal(new Set(actual).size, actual.length, `full paged results must not duplicate ids for ${label}`);
}

/* ------------------------------------------------------------------ *
 * EXPLAIN evidence helpers
 * ------------------------------------------------------------------ */

interface ExplainNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly ExplainNode[];
}

interface ExplainPlan {
  readonly Plan: ExplainNode;
}

function flattenPlan(node: ExplainNode): readonly ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function sharedBlocks(nodes: readonly ExplainNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
    0,
  );
}

async function explain(statement: { text: string; values: readonly unknown[] }): Promise<ExplainPlan> {
  const result = await isolated!.runtime.pool.query<{ 'QUERY PLAN': readonly ExplainPlan[] }>(
    `explain (analyze, buffers, format json) ${statement.text}`,
    [...statement.values],
  );
  const plan = result.rows[0]?.['QUERY PLAN'][0];
  assert.ok(plan, 'PostgreSQL returned no JSON plan evidence');
  return plan;
}

function assertBoundedFilterPlan(
  plan: ExplainPlan,
  indexName: string,
  condPattern: RegExp,
  rowCap: number,
  blockCap: number,
  limitRows: number,
): { rows: number; blocks: number } {
  const nodes = flattenPlan(plan.Plan);
  const indexScan = nodes.find((node) => node['Index Name'] === indexName);
  assert.ok(indexScan, `expected ${indexName} in plan: ${JSON.stringify(plan.Plan)}`);
  assert.ok(indexScan['Index Cond'], `expected Index Cond on ${indexName}: ${JSON.stringify(indexScan)}`);
  assert.match(indexScan['Index Cond'], condPattern);
  assert.ok(
    nodes.every((node) => !(node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'collections')),
    `unexpected unbounded collections scan: ${JSON.stringify(plan.Plan)}`,
  );
  const rows = Math.max(0, ...nodes.map((node) => node['Actual Rows'] ?? 0));
  assert.ok(rows <= rowCap, `expected bounded rows <= ${rowCap} but saw ${rows}: ${JSON.stringify(plan.Plan)}`);
  const blocks = sharedBlocks(nodes);
  assert.ok(blocks < blockCap, `expected bounded buffers < ${blockCap} but saw ${blocks}`);
  assert.ok((plan.Plan['Actual Rows'] ?? Number.POSITIVE_INFINITY) <= limitRows);
  return { rows, blocks };
}

/* ------------------------------------------------------------------ *
 * Migration introspection helpers
 * ------------------------------------------------------------------ */

async function indexPresent(isolatedRuntime: IsolatedPostgresRuntime, indexName: string): Promise<boolean> {
  const result = await isolatedRuntime.runtime.pool.query<{ index_name: string | null }>(
    `select to_regclass($1)::text as index_name`,
    [`${isolatedRuntime.schema}.${indexName}`],
  );
  return result.rows[0]?.index_name !== null;
}

async function columnPresent(isolatedRuntime: IsolatedPostgresRuntime, columnName: string): Promise<boolean> {
  const result = await isolatedRuntime.runtime.pool.query<{ count: string }>(
    `select count(*)::text as count
       from information_schema.columns
      where table_schema = current_schema() and table_name = 'collections' and column_name = $1`,
    [columnName],
  );
  return result.rows[0]?.count === '1';
}
