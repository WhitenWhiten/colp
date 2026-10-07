import assert from 'node:assert/strict';
import type {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  QueryId,
  RootOperationNode,
} from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations, type DatabaseSchema } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import type {
  SearchCandidatePort,
  SearchCandidateResourceType,
  SearchPrincipal,
} from '../../../src/modules/search/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const MIGRATION_NAME = '202608011200_search_member_recall_indexes';
const PREVIOUS_STABLE_MIGRATION = '202608011100_collections_directory_filter_indexes';

const NEEDLE = 'recallneedle';
const TYPES: readonly SearchCandidateResourceType[] = ['collection', 'node', 'annotation'];
const LIMIT = 10;

const PLAN_ACCOUNT: SearchPrincipal = {
  kind: 'account', accountId: 'plan-subject', principalId: 'plan-subject',
  subjectId: 'plan-subject', securityEpoch: '1',
};
const PLAN_ANON: SearchPrincipal = { kind: 'anonymous' };

const MEMBER_INDEX_NAMES = [
  'collections_search_member_trgm_idx', 'collections_search_member_vector_idx',
  'nodes_search_member_trgm_idx', 'nodes_search_member_vector_idx',
  'annotations_search_member_trgm_idx', 'annotations_search_member_vector_idx',
  'annotations_search_member_authority_order_idx',
  'collections_search_member_owner_idx', 'collection_members_search_member_subject_idx',
] as const;

// T-09 (202609260500) drops collections_search_member_owner_idx at the head:
// collections_owned_live_updated_id_idx (owner_subject_id, updated_at DESC,
// id COLLATE "C") WHERE deleted_at IS NULL prefix-covers the owner arm of the
// membership set. The R11 upgrade/rollback test still exercises the original
// index within its own migration window.
const LIVE_MEMBER_INDEX_NAMES = MEMBER_INDEX_NAMES.filter(
  (name) => name !== 'collections_search_member_owner_idx',
);
const OWNER_SET_INDEX = 'collections_owned_live_updated_id_idx';

const SEARCH_GIN = /^(collections|nodes|annotations)_search_(member_)?(trgm|vector)_idx$/u;
const MEMBERSHIP_SET_INDEX = /^(collections_search_member_owner_idx|collections_owned_live_updated_id_idx|collection_members_search_member_subject_idx)$/u;
const PUBLIC_BRANCHES = ['branch_collection_public', 'branch_node_public',
  'branch_annotation_public'] as const;
const ACCOUNT_BRANCHES = [...PUBLIC_BRANCHES, 'branch_collection_member', 'branch_node_member',
  'branch_annotation_member'] as const;

let isolated: IsolatedPostgresRuntime;
let planClient: Awaited<ReturnType<IsolatedPostgresRuntime['runtime']['pool']['connect']>>;

describeWithPostgres('R11 member recall plan evidence at 80k volume', () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_member_recall_plan', {
      maxConnections: 6,
      applicationName: 'known-search-member-recall-plan',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedMemberRecallPlanCorpus(isolated);
    await isolated.runtime.pool.query('analyze collections');
    await isolated.runtime.pool.query('analyze nodes');
    await isolated.runtime.pool.query('analyze annotations');
    await isolated.runtime.pool.query('analyze collection_members');
    await isolated.runtime.pool.query('analyze accounts');
    planClient = await isolated.runtime.pool.connect();
    await planClient.query('set max_parallel_workers_per_gather=0');
    await planClient.query(`set pg_trgm.word_similarity_threshold='0.15'`);
  }, 360_000);

  afterAll(async () => {
    planClient?.release();
    await isolated?.close();
  });

  test('the expand migration upgrades from the previous schema and rolls back cleanly', async () => {
    const upgrade = await createIsolatedPostgresRuntime('search_member_recall_index_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      for (const name of MEMBER_INDEX_NAMES) {
        assert.equal(await indexPresent(upgrade, name), false, `${name} must not exist before R11`);
      }
      assert.equal(await indexPresent(upgrade, 'collections_search_trgm_idx'), true);

      const latest = await migrator.migrateTo(MIGRATION_NAME);
      if (latest.error) throw latest.error;
      for (const name of MEMBER_INDEX_NAMES) {
        assert.equal(await indexPresent(upgrade, name), true, `${name} must exist after R11`);
      }

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      for (const name of MEMBER_INDEX_NAMES) {
        assert.equal(await indexPresent(upgrade, name), false, `${name} must roll back`);
      }
      assert.equal(await indexPresent(upgrade, 'collections_search_trgm_idx'), true);
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('every member index definition carries the expected opclass and non-visibility partial predicate', async () => {
    const rows = await isolated.runtime.pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = current_schema() and indexname = any($1::text[])`,
      [[...MEMBER_INDEX_NAMES, OWNER_SET_INDEX]],
    );
    assert.equal(rows.rowCount, LIVE_MEMBER_INDEX_NAMES.length + 1);
    const byName = new Map(rows.rows.map((row) => [row.indexname, row.indexdef]));
    for (const name of LIVE_MEMBER_INDEX_NAMES) {
      const indexdef = byName.get(name);
      assert.ok(indexdef, `missing pg_indexes row for ${name}`);
    }
    // T-09: the single-column owner index is gone; its covering prefix index
    // must keep the exact key order and live-rows predicate.
    assert.equal(byName.has('collections_search_member_owner_idx'), false,
      'collections_search_member_owner_idx must be dropped by the T-09 cleanup');
    assert.match(byName.get(OWNER_SET_INDEX) ?? '',
      /USING btree \(owner_subject_id, updated_at DESC, .*COLLATE "C"\)?\)/i);
    assert.match(byName.get(OWNER_SET_INDEX) ?? '', /WHERE \(deleted_at IS NULL\)/i);
    assert.match(byName.get('collections_search_member_trgm_idx') ?? '', /USING gin \(search_text public\.gin_trgm_ops\)/i);
    assert.match(byName.get('collections_search_member_vector_idx') ?? '', /USING gin \(search_vector\)/i);
    assert.match(byName.get('nodes_search_member_trgm_idx') ?? '', /USING gin \(search_text public\.gin_trgm_ops\)/i);
    assert.match(byName.get('nodes_search_member_vector_idx') ?? '', /USING gin \(search_vector\)/i);
    assert.match(byName.get('annotations_search_member_trgm_idx') ?? '', /USING gin \(annotation_search_text public\.gin_trgm_ops\)/i);
    assert.match(byName.get('annotations_search_member_vector_idx') ?? '', /USING gin \(annotation_search_vector\)/i);
    assert.match(
      byName.get('annotations_search_member_authority_order_idx') ?? '',
      /USING btree \(collection_id, subject_type COLLATE "C", subject_id COLLATE "C", id COLLATE "C"\)/i,
    );
    assert.match(byName.get('collection_members_search_member_subject_idx') ?? '', /USING btree \(subject_id\)/i);

    // No member index keeps a public/inherit-only visibility restriction.
    for (const name of ['collections_search_member_trgm_idx', 'collections_search_member_vector_idx',
      OWNER_SET_INDEX]) {
      assert.doesNotMatch(byName.get(name) ?? '', /visibility\s*=\s*'public'/i);
    }
    for (const name of ['nodes_search_member_trgm_idx', 'nodes_search_member_vector_idx']) {
      assert.doesNotMatch(byName.get(name) ?? '', /visibility\s*=\s*'inherit'/i);
    }
    for (const name of ['annotations_search_member_trgm_idx', 'annotations_search_member_vector_idx',
      'annotations_search_member_authority_order_idx']) {
      assert.doesNotMatch(byName.get(name) ?? '', /visibility\s*=\s*'public'/i);
    }
  });

  test('account and anonymous candidate SQL both split recall into bounded per-branch arms with dedup', async () => {
    const accountStatement = await compileAccountStatement();
    const anonymousStatement = await compileAnonymousStatement();
    for (const branch of PUBLIC_BRANCHES) {
      assert.ok(accountStatement.sql.includes(branch), `account SQL missing ${branch}`);
      assert.ok(anonymousStatement.sql.includes(branch), `anonymous SQL missing ${branch}`);
    }
    for (const branch of ['branch_collection_member', 'branch_node_member', 'branch_annotation_member']) {
      assert.ok(accountStatement.sql.includes(branch), `account SQL missing ${branch}`);
      assert.ok(!anonymousStatement.sql.includes(branch), `anonymous SQL must not contain ${branch}`);
    }
    assert.ok(!accountStatement.sql.includes('branch_profile') && !anonymousStatement.sql.includes('branch_profile'),
      'a search that does not request profiles must not install the profile branch');
    assert.match(accountStatement.sql, /UNION ALL/u);
    assert.match(accountStatement.sql, /DISTINCT ON \(resource_type, resource_id\)/u);
    assert.match(accountStatement.sql, /member\.collection_id = c\.id/u);
    assert.match(accountStatement.sql, /OFFSET 0/u);
    assert.doesNotMatch(accountStatement.sql, /actor_collections/u);
    assert.doesNotMatch(anonymousStatement.sql, /collection_members|actor_collections|verified_actor/u);
    assert.ok((accountStatement.sql.match(/LIMIT \$/gu) ?? []).length >= 2,
      'account SQL must apply per-branch and final LIMITs');
    assert.ok((anonymousStatement.sql.match(/LIMIT \$/gu) ?? []).length >= 2,
      'anonymous SQL must apply per-branch and final LIMITs');
  });

  test('account plan uses member GINs and a candidate collection-id membership probe', async () => {
    const statement = await compileAccountStatement();
    const plan = await explain(statement);
    const evidence = assertBoundedSearchPlan(plan, {
      requiredIndexNamePatterns: [
        /^nodes_search_member_(trgm|vector)_idx$/u,
        /^annotations_search_member_(trgm|vector|authority_order)_idx$/u,
        /^collections_search_(member_)?(trgm|vector)_idx$/u,
        /^nodes_search_(member_)?(trgm|vector)_idx$/u,
        /^annotations_search_(member_)?(trgm|vector)_idx$/u,
      ],
      requiredAbsentIndexNamePatterns: [],
      branchNames: ACCOUNT_BRANCHES,
      memberBranchNames: ['branch_collection_member', 'branch_node_member', 'branch_annotation_member'],
      topLimit: LIMIT + 1,
      sortCap: (LIMIT + 1) * 8,
      ginRowCap: LIMIT * 4,
      blockCap: 30_000,
    });
    console.info(`[r11-plan] account first page rows=${evidence.rows} buffers=${evidence.blocks}`);
  }, 120_000);

  test('anonymous plan keeps the public GINs and never materializes the membership set', async () => {
    const statement = await compileAnonymousStatement();
    const plan = await explain(statement);
    const evidence = assertBoundedSearchPlan(plan, {
      requiredIndexNamePatterns: [
        /^collections_search_(member_)?(trgm|vector)_idx$/u,
        /^nodes_search_(member_)?(trgm|vector)_idx$/u,
        /^annotations_search_(member_)?(trgm|vector)_idx$/u,
      ],
      requiredAbsentIndexNamePatterns: [MEMBERSHIP_SET_INDEX],
      branchNames: PUBLIC_BRANCHES,
      memberBranchNames: [],
      topLimit: LIMIT + 1,
      sortCap: (LIMIT + 1) * 8,
      ginRowCap: LIMIT * 4,
      blockCap: 30_000,
    });
    console.info(`[r11-plan] anonymous first page rows=${evidence.rows} buffers=${evidence.blocks}`);
  }, 120_000);

  test('index-disabled and index-enabled paths return identical candidate recall', async () => {
    const statement = await compileAccountStatement();
    const enabled = await planClient.query<{ resource_type: string; resource_id: string }>(
      statement.sql, [...statement.parameters],
    );
    await planClient.query('begin');
    await planClient.query('set local enable_bitmapscan = off');
    const disabled = await planClient.query<{ resource_type: string; resource_id: string }>(
      statement.sql, [...statement.parameters],
    );
    await planClient.query('commit');
    assert.deepEqual(
      disabled.rows.map((row) => `${row.resource_type}:${row.resource_id}`),
      enabled.rows.map((row) => `${row.resource_type}:${row.resource_id}`),
    );
    assert.ok(enabled.rows.length <= LIMIT + 1, `expected at most ${LIMIT + 1} candidates, saw ${enabled.rows.length}`);
    assert.ok(enabled.rows.length > 0, 'expected the account plan corpus to recall candidates');
  });
});

/* ------------------------------------------------------------------ *
 * Compiled statement capture
 * ------------------------------------------------------------------ */

interface CompiledStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function captureCandidateCompilation(db: Kysely<DatabaseSchema>): {
  db: Kysely<DatabaseSchema>;
  last: () => CompiledStatement;
} {
  const seen: Array<{ node: RootOperationNode; queryId: QueryId }> = [];
  const wrapped = db.withPlugin({
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      seen.push({ node: args.node, queryId: args.queryId });
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  } satisfies KyselyPlugin);
  return {
    db: wrapped,
    last: () => {
      const executor = db.getExecutor();
      for (const captured of [...seen].reverse()) {
        const compiled = executor.compileQuery<Record<string, unknown>>(captured.node, captured.queryId);
        if (compiled.sql.includes('search_strip_unsafe_text')) {
          return { sql: compiled.sql, parameters: compiled.parameters };
        }
      }
      throw new Error('no candidate query was captured');
    },
  };
}

async function compileAccountStatement(): Promise<CompiledStatement> {
  return compileCandidateStatement(PLAN_ACCOUNT);
}

async function compileAnonymousStatement(): Promise<CompiledStatement> {
  return compileCandidateStatement(PLAN_ANON);
}

async function compileCandidateStatement(principal: SearchPrincipal): Promise<CompiledStatement> {
  const capture = captureCandidateCompilation(isolated!.runtime.db);
  const port: SearchCandidatePort = createPostgresSearchCandidatePort(capture.db);
  await port.listCandidates({
    query: NEEDLE,
    types: [...TYPES],
    projection: principal.kind === 'account'
      ? { kind: 'account', accountId: principal.accountId, principalId: principal.principalId,
        subjectId: principal.subjectId, securityEpoch: principal.securityEpoch }
      : { kind: 'anonymous' },
    limit: LIMIT,
    timeoutMs: 5_000,
  });
  return capture.last();
}

/* ------------------------------------------------------------------ *
 * EXPLAIN evidence helpers
 * ------------------------------------------------------------------ */

interface ExplainNode {
  readonly 'Node Type': string;
  readonly Alias?: string;
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

function branchIndexNames(branch: ExplainNode): readonly string[] {
  return [...new Set(flattenPlan(branch).flatMap((node) => (node['Index Name'] ? [node['Index Name']] : [])))];
}

function assertCollectionMemberBranchBounded(nodes: readonly ExplainNode[]): void {
  const branch = nodes.find(
    (node) => node['Node Type'] === 'Subquery Scan' && node.Alias === 'branch_collection_member');
  assert.ok(branch, 'expected recall branch branch_collection_member in plan');
  const indexNames = branchIndexNames(branch);
  // Membership is probed from the candidate collection id, so the member GIN
  // (or a primary-key lookup of that candidate) is the legal access path. The
  // public partial GIN is not: it would drop protected collections.
  const usesMemberGin = indexNames.some((name) => /^collections_search_member_(trgm|vector)_idx$/u.test(name));
  const usesActorSetLookup = indexNames.some((name) =>
    name === 'collections_pkey' || name === 'collections_id_root_node_id_key');
  assert.ok(usesMemberGin || usesActorSetLookup,
    `collection member branch must use the member GIN or a bounded actor-set lookup, saw ${JSON.stringify(indexNames)}`);
  assert.ok(!indexNames.some((name) => name === 'collections_search_trgm_idx' || name === 'collections_search_vector_idx'),
    `collection member branch must not use the public partial GIN, saw ${JSON.stringify(indexNames)}`);
}

function subtreeHasSubqueryScan(node: ExplainNode, alias: string): boolean {
  return (node['Node Type'] === 'Subquery Scan' && node.Alias === alias)
    || (node.Plans ?? []).some((child) => subtreeHasSubqueryScan(child, alias));
}

// PostgreSQL parent nodes include their descendants' buffer counters, so summing every
// flattened node double-counts. The root node's counters are the query's true buffer
// usage.
function queryBlocks(plan: ExplainPlan): number {
  return (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0);
}

async function explain(statement: CompiledStatement): Promise<ExplainPlan> {
  const result = await planClient.query<{ 'QUERY PLAN': readonly ExplainPlan[] }>(
    `explain (analyze, buffers, format json) ${statement.sql}`,
    [...statement.parameters],
  );
  const plan = result.rows[0]?.['QUERY PLAN'][0];
  assert.ok(plan, 'PostgreSQL returned no JSON plan evidence');
  return plan;
}

function assertBoundedSearchPlan(
  plan: ExplainPlan,
  expected: {
    readonly requiredIndexNamePatterns: readonly RegExp[];
    readonly requiredAbsentIndexNamePatterns: readonly RegExp[];
    readonly branchNames: readonly string[];
    readonly memberBranchNames: readonly string[];
    readonly topLimit: number;
    readonly sortCap: number;
    readonly ginRowCap: number;
    readonly blockCap: number;
  },
): { rows: number; blocks: number } {
  const nodes = flattenPlan(plan.Plan);
  const indexNames = [...new Set(nodes.flatMap((node) => (node['Index Name'] ? [node['Index Name']] : [])))];

  const seqScans = nodes.filter((node) => node['Node Type'] === 'Seq Scan').map((node) => ({
    relation: node['Relation Name'], rows: node['Actual Rows'], loops: node['Actual Loops'],
  }));
  for (const pattern of expected.requiredIndexNamePatterns) {
    assert.ok(indexNames.some((name) => pattern.test(name)),
      `expected an index scan matching ${pattern} in ${JSON.stringify(indexNames)}; seq=${JSON.stringify(seqScans)}`);
  }
  for (const pattern of expected.requiredAbsentIndexNamePatterns) {
    assert.ok(!indexNames.some((name) => pattern.test(name)),
      `unexpected index scan matching ${pattern} in ${JSON.stringify(indexNames)}`);
  }

  for (const relation of ['collections', 'nodes', 'annotations']) {
    // R11's core contract is that member recall stays index-bounded: every member
    // branch must resolve through its member-compatible GIN and authority indexes,
    // never a broad table scan. The public node branch may legitimately hash-join
    // the collection root lookup (planner-selected, preserved side of a LEFT JOIN),
    // so it is not held to a zero-scan rule; it remains bounded by its per-branch
    // LIMIT and the sort/gin/buffer caps below.
    for (const name of expected.memberBranchNames) {
      const branch = nodes.find(
        (node) => node['Node Type'] === 'Subquery Scan' && node.Alias === name);
      assert.ok(branch, `expected recall branch ${name} in plan: ${JSON.stringify(plan.Plan)}`);
      assert.ok(
        flattenPlan(branch).every((node) => !(node['Node Type'] === 'Seq Scan' && node['Relation Name'] === relation)),
        `unexpected ${relation} sequential scan in member branch ${name}: ${JSON.stringify(plan.Plan)}`,
      );
    }
  }
  if (expected.memberBranchNames.includes('branch_collection_member')) {
    assertCollectionMemberBranchBounded(nodes);
  }
  // The public collection branch must stay on its partial GIN: a full collections
  // scan there would regress anonymous and public search alike.
  const collectionPublicBranch = nodes.find(
    (node) => node['Node Type'] === 'Subquery Scan' && node.Alias === 'branch_collection_public');
  assert.ok(collectionPublicBranch, `expected recall branch branch_collection_public in plan: ${JSON.stringify(plan.Plan)}`);
  assert.ok(
    flattenPlan(collectionPublicBranch).every((node) => !(node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'collections')),
    `unexpected collections sequential scan in public collection branch: ${JSON.stringify(plan.Plan)}`,
  );

  const sorts = nodes.filter((node) => node['Node Type'] === 'Sort');
  // The recall pipeline sorts carry the normalized rank and/or the stable resource
  // identity tie keys and are bounded by the per-branch/final LIMIT. Membership-set
  // dedup sorts carry only the actor collection id and are bounded by the actor's
  // collection count, so they are excluded from the tight cap.
  const candidateSorts = sorts.filter((node) =>
    (node['Sort Key'] ?? []).some((key) => /rank|resource_type|resource_id/u.test(key)));
  assert.ok(candidateSorts.every((node) => (node['Actual Rows'] ?? 0) <= expected.sortCap),
    `unexpected unbounded candidate sort rows: ${JSON.stringify(candidateSorts)}`);
  // No sort may process corpus-scale rows (a full-collection or full-node sort).
  assert.ok(sorts.every((node) => (node['Actual Rows'] ?? 0) <= expected.sortCap * 8),
    `unexpected broad sort rows: ${JSON.stringify(sorts)}`);

  const searchGins = nodes.filter((node) => node['Index Name'] !== undefined && SEARCH_GIN.test(node['Index Name']!));
  assert.ok(searchGins.every((node) => (node['Actual Rows'] ?? 0) <= expected.ginRowCap),
    `unexpected search GIN rows: ${JSON.stringify(searchGins)}`);

  // The recall must be split into the expected per-branch arms (public and member
  // branches for each resource type). The planner may fuse sibling UNION ALL arms
  // into a nested Append, so assert the branch set, each branch's own LIMIT, and
  // the single candidates Append that aggregates them, rather than an exact arm count.
  for (const name of expected.branchNames) {
    const branchNode = nodes.find(
      (node) => node['Node Type'] === 'Subquery Scan' && node.Alias === name);
    assert.ok(branchNode, `expected recall branch ${name} in plan: ${JSON.stringify(plan.Plan)}`);
    const branchLimit = flattenPlan(branchNode).find((node) => node['Node Type'] === 'Limit');
    assert.ok(branchLimit, `expected a per-branch LIMIT under ${name}`);
    assert.ok((branchLimit['Actual Rows'] ?? 0) <= expected.topLimit,
      `branch ${name} exceeded per-branch LIMIT ${expected.topLimit}: ${JSON.stringify(branchLimit)}`);
  }
  const candidatesAppend = nodes.find((node) => node['Node Type'] === 'Append'
    && expected.branchNames.every((name) => subtreeHasSubqueryScan(node, name)));
  assert.ok(candidatesAppend,
    `expected a candidates Append spanning all ${expected.branchNames.length} recall branches: ${JSON.stringify(plan.Plan)}`);

  const blocks = queryBlocks(plan);
  assert.ok(blocks < expected.blockCap, `expected bounded buffers < ${expected.blockCap} but saw ${blocks}`);
  assert.ok((plan.Plan['Actual Rows'] ?? Number.POSITIVE_INFINITY) <= expected.topLimit,
    `expected top-level rows <= ${expected.topLimit}`);
  return { rows: Math.max(0, ...nodes.map((node) => node['Actual Rows'] ?? 0)), blocks };
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

/* ------------------------------------------------------------------ *
 * 80k fixture seeding
 * ------------------------------------------------------------------ */

async function seedMemberRecallPlanCorpus(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    // The 80k corpus insert maintains the R10 directory GINs plus the R11 member-search
    // GINs on every row, which exceeds the pool's 15s default statement_timeout on CI
    // hardware.  Lift the timeout for the seed transaction (matches the social-feed
    // fanout seeding idiom); the beforeAll wall-clock cap still bounds the whole seed.
    await client.query('set local statement_timeout = 0');
    await client.query('set constraints all deferred');

    await client.query(`
      insert into accounts(id, subject_id, status, security_epoch) values
        ('plan-subject', 'plan-subject', 'active', 1),
        ('plan-other', 'plan-other-subject', 'active', 1),
        ('plan-editor', 'plan-editor', 'active', 1)
    `);

    // Public opt-in collections: 8 needle rows (every 10,000th).
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'plan-c-pub-' || lpad(n::text, 6, '0'), 'collection' from generate_series(1, 80000) n
      union all
      select 'plan-c-pub-' || lpad(n::text, 6, '0') || '-root', 'node' from generate_series(1, 80000) n
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, allow_search_indexing, root_node_id,
         publication_slug, published_at, resource_revision, content_revision, policy_revision)
      select 'plan-c-pub-' || lpad(n::text, 6, '0'), 'plan-owner-' || lpad(n::text, 6, '0'),
        case when n % 10000 = 7 then 'recallneedle public collection ' || n::text
             else 'plan bulk public collection ' || n::text end,
        null, 'bookmarks', 'public', true, 'plan-c-pub-' || lpad(n::text, 6, '0') || '-root',
        'plan-c-pub-' || lpad(n::text, 6, '0'), current_timestamp,
        'r1', 'c1', 'p1'
      from generate_series(1, 80000) n
    `);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'plan-c-pub-' || lpad(n::text, 6, '0') || '-root',
             'plan-c-pub-' || lpad(n::text, 6, '0'), 'folder', true, 'Root', 'r1', 'ch1'
        from generate_series(1, 80000) n
    `);

    // Protected collections owned by the actor: a small fraction of the total so the
    // owner-subject authority index is the honest cheapest path for the actor set.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'plan-c-mem-' || lpad(n::text, 6, '0'), 'collection' from generate_series(1, 500) n
      union all
      select 'plan-c-mem-' || lpad(n::text, 6, '0') || '-root', 'node' from generate_series(1, 500) n
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, allow_search_indexing, root_node_id,
         resource_revision, content_revision, policy_revision)
      select 'plan-c-mem-' || lpad(n::text, 6, '0'), 'plan-subject',
        case when n % 167 = 3 then 'recallneedle member collection ' || n::text
             else 'plan bulk member collection ' || n::text end,
        null, 'bookmarks', 'protected', true, 'plan-c-mem-' || lpad(n::text, 6, '0') || '-root',
        'r1', 'c1', 'p1'
      from generate_series(1, 500) n
    `);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'plan-c-mem-' || lpad(n::text, 6, '0') || '-root',
             'plan-c-mem-' || lpad(n::text, 6, '0'), 'folder', true, 'Root', 'r1', 'ch1'
        from generate_series(1, 500) n
    `);

    // Node host collections: one public (no member path), one protected with the actor as a member.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type) values
        ('plan-node-collection', 'collection'), ('plan-node-collection-root', 'node'),
        ('plan-member-node-collection', 'collection'), ('plan-member-node-collection-root', 'node')
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, kind, visibility, allow_search_indexing, root_node_id,
         publication_slug, published_at, resource_revision, content_revision, policy_revision)
      values
        ('plan-node-collection', 'plan-other-subject', 'Plan node collection', 'bookmarks', 'public',
          true, 'plan-node-collection-root', 'plan-node-collection', current_timestamp, 'r1', 'c1', 'p1'),
        ('plan-member-node-collection', 'plan-other-subject', 'Plan member node collection', 'bookmarks',
          'protected', true, 'plan-member-node-collection-root', null, null, 'r1', 'c1', 'p1')
    `);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      values
        ('plan-node-collection-root', 'plan-node-collection', 'folder', true, 'Root', 'r1', 'ch1'),
        ('plan-member-node-collection-root', 'plan-member-node-collection', 'folder', true, 'Root', 'r1', 'ch1')
    `);
    // Membership rows: a large table with mostly-inert rows for distinct subjects, so
    // the actor's selective subject_id lookup is planned through the membership index
    // rather than a sequential scan of a one-row table.
    await client.query(`
      insert into collection_members(collection_id, subject_id, role)
      select 'plan-c-mem-' || lpad(((n % 500) + 1)::text, 6, '0'),
             'plan-member-' || lpad(n::text, 6, '0'), 'viewer'
      from generate_series(1, 30000) n
      union all
      values ('plan-member-node-collection', 'plan-subject', 'viewer')
    `);

    // Public nodes directly under a public root: 4 needle rows.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'plan-node-pub-' || lpad(n::text, 6, '0'), 'node' from generate_series(1, 40000) n
    `);
    await client.query(`
      insert into nodes
        (id, collection_id, parent_id, kind, title, url, search_url_host, position_token,
         resource_revision, children_revision)
      select 'plan-node-pub-' || lpad(n::text, 6, '0'), 'plan-node-collection',
             'plan-node-collection-root', 'bookmark',
        case when n % 10000 = 5 then 'recallneedle public node ' || n::text
             else 'plan bulk public node ' || n::text end,
        'https://plan.example.test/pub/' || n, 'plan.example.test', 'P' || lpad(n::text, 6, '0'),
        'r1', 'ch1'
      from generate_series(1, 40000) n
    `);

    // Member nodes inside the protected member collection: 1-2 needle rows.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'plan-node-mem-' || lpad(n::text, 6, '0'), 'node' from generate_series(1, 15000) n
    `);
    await client.query(`
      insert into nodes
        (id, collection_id, parent_id, kind, title, url, search_url_host, position_token,
         resource_revision, children_revision)
      select 'plan-node-mem-' || lpad(n::text, 6, '0'), 'plan-member-node-collection',
             'plan-member-node-collection-root', 'bookmark',
        case when n % 10000 = 9 then 'recallneedle member node ' || n::text
             else 'plan bulk member node ' || n::text end,
        'https://plan.example.test/mem/' || n, 'plan.example.test', 'P' || lpad(n::text, 6, '0'),
        'r1', 'ch1'
      from generate_series(1, 15000) n
    `);

    // Public annotations in the public node collection: 2 needle rows (subject_type='collection').
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'plan-anno-pub-' || lpad(n::text, 6, '0'), 'annotation' from generate_series(1, 20000) n
    `);
    await client.query(`
      insert into annotations
        (id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
         visibility, resource_revision, created_at, updated_at, payload_json)
      select id, 'plan-node-collection', 'collection', 'plan-node-collection', 'plan-editor',
             'note', 'plain', to_jsonb(value), 'public', 'r1',
             '2026-07-25T00:00:00Z'::timestamptz, '2026-07-25T00:00:00Z'::timestamptz,
             jsonb_build_object(
               'id', id, 'collectionId', 'plan-node-collection',
               'subject', jsonb_build_object('type', 'collection', 'id', 'plan-node-collection'),
               'creator', jsonb_build_object('id', 'https://known.test/profiles/editor', 'name', 'Editor'),
               'type', 'note', 'format', 'plain', 'value', to_jsonb(value),
               'visibility', 'public', 'revision', 'r1',
               'createdAt', '2026-07-25T00:00:00Z', 'updatedAt', '2026-07-25T00:00:00Z')
        from (select 'plan-anno-pub-' || lpad(n::text, 6, '0') id,
                     case when n % 10000 = 1 then 'recallneedle public annotation ' || n::text
                          else 'plan bulk public annotation ' || n::text end value
                from generate_series(1, 20000) n) seeded
    `);

    // Protected annotations in the member collection: 1 needle row.
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'plan-anno-mem-' || lpad(n::text, 6, '0'), 'annotation' from generate_series(1, 10000) n
    `);
    await client.query(`
      insert into annotations
        (id, collection_id, subject_type, subject_id, creator_principal_id, type, format, value_json,
         visibility, resource_revision, created_at, updated_at, payload_json)
      select id, 'plan-member-node-collection', 'collection', 'plan-member-node-collection', 'plan-editor',
             'note', 'plain', to_jsonb(value), 'protected', 'r1',
             '2026-07-25T00:00:00Z'::timestamptz, '2026-07-25T00:00:00Z'::timestamptz,
             jsonb_build_object(
               'id', id, 'collectionId', 'plan-member-node-collection',
               'subject', jsonb_build_object('type', 'collection', 'id', 'plan-member-node-collection'),
               'creator', jsonb_build_object('id', 'https://known.test/profiles/editor', 'name', 'Editor'),
               'type', 'note', 'format', 'plain', 'value', to_jsonb(value),
               'visibility', 'protected', 'revision', 'r1',
               'createdAt', '2026-07-25T00:00:00Z', 'updatedAt', '2026-07-25T00:00:00Z')
        from (select 'plan-anno-mem-' || lpad(n::text, 6, '0') id,
                     case when n % 10000 = 3 then 'recallneedle member annotation ' || n::text
                          else 'plan bulk member annotation ' || n::text end value
                from generate_series(1, 10000) n) seeded
    `);

    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
