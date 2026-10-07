import assert from 'node:assert/strict';
import type { Kysely, KyselyPlugin, PluginTransformQueryArgs, QueryId, RootOperationNode } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseSchema } from '../../../src/infrastructure/database/index.js';
import { createPostgresSearchCandidatePort } from '../../../src/infrastructure/search/index.js';
import {
  compareSearchCandidateTuple,
  type SearchCandidate,
  type SearchCandidateResourceType,
} from '../../../src/modules/search/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNED = 1000;
const JOINED = 1000;
const NEEDLE = 'recallneedle';
const ACCOUNT = {
  kind: 'account' as const,
  accountId: 'wide-account',
  principalId: 'wide-account',
  subjectId: 'wide-subject',
  securityEpoch: '1',
};

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Loops'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainPlan {
  readonly Plan: PlanNode;
  readonly 'Execution Time'?: number;
}

let isolated: IsolatedPostgresRuntime;
let planClient: Awaited<ReturnType<IsolatedPostgresRuntime['runtime']['pool']['connect']>>;

describeWithPostgres('U-22 candidate-scoped membership', () => {
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('search_member_candidate_scope', {
      maxConnections: 4,
      applicationName: 'known-search-member-candidate-scope',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedWideAccount(isolated);
    await isolated.runtime.pool.query('analyze collections');
    await isolated.runtime.pool.query('analyze collection_members');
    await isolated.runtime.pool.query('analyze nodes');
    await isolated.runtime.pool.query('analyze accounts');
    planClient = await isolated.runtime.pool.connect();
    await planClient.query('set max_parallel_workers_per_gather=0');
    await planClient.query(`set pg_trgm.word_similarity_threshold='0.4'`);
    await planClient.query('set statement_timeout=5000');
  }, 180_000);

  afterAll(async () => {
    planClient?.release();
    await isolated?.close();
  });

  test('profile-only does not touch the member list', async () => {
    const statement = await compile(['profile'], ACCOUNT);
    assert.doesNotMatch(statement.sql, /collection_members|actor_collections|verified_actor|branch_collection_/u);
    const plan = await explain(statement);
    assert.equal(memberNodes(plan).length, 0);
    const page = await search(['profile'], ACCOUNT, NEEDLE, 1500);
    assert.equal(page.items.length, 0);
  });

  test('anonymous search has no member query and keeps public hits only', async () => {
    const statement = await compile(['collection', 'node', 'annotation'], { kind: 'anonymous' });
    assert.doesNotMatch(statement.sql, /collection_members|actor_collections|verified_actor|branch_\w+_member/u);
    const plan = await explain(statement);
    assert.equal(memberNodes(plan).length, 0);
    const page = await search(['collection', 'node', 'annotation'], { kind: 'anonymous' }, NEEDLE, 1500);
    const ids = page.items.map((item) => item.resourceId);
    assert.ok(ids.includes('pub-needle'));
    assert.ok(!ids.some((id) => id === 'own-1' || id === 'join-2' || id === 'forbidden-needle'));
  });

  test('a wide account probes membership by candidate collection id inside 1500ms', async () => {
    const statement = await compile(['collection', 'node', 'annotation'], ACCOUNT);
    assert.match(statement.sql, /member\.collection_id = c\.id/u);
    assert.match(statement.sql, /OFFSET 0/u);
    assert.match(statement.sql, /verified_actor AS MATERIALIZED/u);
    assert.doesNotMatch(statement.sql, /actor_collections/u);
    const plan = await explain(statement);
    const reads = assertCandidateScopedMembership(plan, { maxMemberReads: JOINED + 1 });
    const page = await search(['collection', 'node', 'annotation'], ACCOUNT, NEEDLE, 1500);
    const ids = page.items.map((item) => `${item.resourceType}:${item.resourceId}`);
    for (const id of ['collection:own-1', 'collection:join-2', 'collection:pub-needle', 'node:needle-node-own', 'node:needle-node-join']) {
      assert.ok(ids.includes(id), `missing ${id} in ${ids.join(',')}`);
    }
    assert.ok(!ids.includes('collection:forbidden-needle'));
    assert.deepEqual([...page.items].sort(compareSearchCandidateTuple), [...page.items]);
    const stale = await search(['collection'], { ...ACCOUNT, securityEpoch: '9' }, NEEDLE, 1500);
    assert.deepEqual(stale.items.map((item) => item.resourceId), ['pub-needle']);
    const broad = await search(['collection'], ACCOUNT, 'plan', 1500);
    assert.ok(broad.items.length > 0);
    const broadPlan = await explain(await compile(['collection'], ACCOUNT, 'plan'));
    const broadReads = assertCandidateScopedMembership(broadPlan);
    console.info(`[u22-scope] needle memberReads=${reads.memberReads} blocks=${reads.blocks} ms=${reads.ms}; broad memberReads=${broadReads.memberReads} blocks=${broadReads.blocks} ms=${broadReads.ms}`);
  }, 60_000);
});

function assertCandidateScopedMembership(plan: ExplainPlan, bound?: { readonly maxMemberReads: number }): {
  memberReads: number;
  blocks: number;
  ms: number;
} {
  const nodes = flatten(plan.Plan);
  const members = memberNodes(plan);
  assert.ok(members.length > 0, 'expected a collection_members probe');
  let memberReads = 0;
  for (const node of members) {
    if (node['Node Type'] === 'Seq Scan') {
      assert.fail(`collection_members sequential scan: ${JSON.stringify(node)}`);
    }
    if (node['Index Name']) {
      assert.match(node['Index Cond'] ?? '', /collection_id/u, JSON.stringify(node));
      assert.notEqual(node['Index Name'], 'collection_members_search_member_subject_idx');
    }
    memberReads += (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);
  }
  if (bound) {
    assert.ok(memberReads < bound.maxMemberReads,
      `membership read ${memberReads} covered the account list of ${bound.maxMemberReads}`);
  }
  assert.ok(!nodes.some((node) => node['Index Name'] === 'collections_owned_live_updated_id_idx'),
    'owner index must not materialize the account collection list');
  const ms = plan['Execution Time'] ?? Number.POSITIVE_INFINITY;
  assert.ok(ms < 1500, `explain execution ${ms}ms exceeded the default search budget`);
  const blocks = (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0);
  return { memberReads, blocks, ms };
}

async function search(
  types: readonly SearchCandidateResourceType[],
  projection: { kind: 'anonymous' } | typeof ACCOUNT,
  query: string,
  timeoutMs: number,
): Promise<{ items: SearchCandidate[]; hasMore: boolean }> {
  const port = createPostgresSearchCandidatePort(isolated.runtime.db);
  return port.listCandidates({ query, types: [...types], projection, limit: 20, timeoutMs });
}

async function compile(
  types: readonly SearchCandidateResourceType[],
  projection: { kind: 'anonymous' } | typeof ACCOUNT,
  query = NEEDLE,
): Promise<{ sql: string; parameters: readonly unknown[] }> {
  const seen: Array<{ node: RootOperationNode; queryId: QueryId }> = [];
  const db = isolated.runtime.db.withPlugin({
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      seen.push({ node: args.node, queryId: args.queryId });
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  } satisfies KyselyPlugin);
  await searchOn(db, types, projection, query);
  const executor = isolated.runtime.db.getExecutor();
  for (const captured of [...seen].reverse()) {
    const compiled = executor.compileQuery(captured.node, captured.queryId);
    if (compiled.sql.includes('search_strip_unsafe_text')) {
      return { sql: compiled.sql, parameters: compiled.parameters };
    }
  }
  throw new Error('no candidate query was captured');
}

async function searchOn(
  db: Kysely<DatabaseSchema>,
  types: readonly SearchCandidateResourceType[],
  projection: { kind: 'anonymous' } | typeof ACCOUNT,
  query: string,
): Promise<void> {
  await createPostgresSearchCandidatePort(db).listCandidates({
    query, types: [...types], projection, limit: 20, timeoutMs: 1500,
  });
}

async function explain(statement: { sql: string; parameters: readonly unknown[] }): Promise<ExplainPlan> {
  const result = await planClient.query<{ 'QUERY PLAN': readonly ExplainPlan[] }>(
    `explain (analyze, buffers, format json) ${statement.sql}`,
    [...statement.parameters],
  );
  const plan = result.rows[0]?.['QUERY PLAN'][0];
  assert.ok(plan, 'PostgreSQL returned no JSON plan');
  return plan;
}

function memberNodes(plan: ExplainPlan): PlanNode[] {
  return flatten(plan.Plan).filter((node) => node['Relation Name'] === 'collection_members');
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

async function seedWideAccount(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local statement_timeout=0');
    await client.query('set constraints all deferred');
    await client.query(`insert into accounts(id, subject_id, status, security_epoch)
      values ('wide-account','wide-subject','active',1)`);
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'own-' || n::text, 'collection' from generate_series(1, ${OWNED}) n
      union all select 'own-' || n::text || '-root', 'node' from generate_series(1, ${OWNED}) n
      union all select 'join-' || n::text, 'collection' from generate_series(1, ${JOINED}) n
      union all select 'join-' || n::text || '-root', 'node' from generate_series(1, ${JOINED}) n
      union all select id, kind from (values
        ('forbidden-needle','collection'), ('forbidden-needle-root','node'),
        ('pub-needle','collection'), ('pub-needle-root','node'),
        ('needle-node-own','node'), ('needle-node-join','node')
      ) extra(id, kind)
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, kind, visibility, allow_search_indexing, root_node_id,
         resource_revision, content_revision, policy_revision)
      select 'own-' || n::text, 'wide-subject',
        case when n % 500 = 1 then '${NEEDLE} owned ' || n::text else 'plan bulk owned ' || n::text end,
        'bookmarks', 'protected', true, 'own-' || n::text || '-root', 'r1', 'c1', 'p1'
      from generate_series(1, ${OWNED}) n
      union all
      select 'join-' || n::text, 'other-subject',
        case when n % 500 = 2 then '${NEEDLE} joined ' || n::text else 'plan bulk joined ' || n::text end,
        'bookmarks', 'protected', true, 'join-' || n::text || '-root', 'r1', 'c1', 'p1'
      from generate_series(1, ${JOINED}) n
      union all
      select 'forbidden-needle', 'other-subject', '${NEEDLE} forbidden', 'bookmarks', 'protected', true,
        'forbidden-needle-root', 'r1', 'c1', 'p1'
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, kind, visibility, allow_search_indexing, root_node_id,
         publication_slug, published_at, resource_revision, content_revision, policy_revision)
      values ('pub-needle', 'public-owner', '${NEEDLE} public', 'bookmarks', 'public', true,
        'pub-needle-root', 'pub-needle', current_timestamp, 'r1', 'c1', 'p1')
    `);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'own-' || n::text || '-root', 'own-' || n::text, 'folder', true, 'Root', 'r1', 'ch1'
        from generate_series(1, ${OWNED}) n
      union all
      select 'join-' || n::text || '-root', 'join-' || n::text, 'folder', true, 'Root', 'r1', 'ch1'
        from generate_series(1, ${JOINED}) n
      union all
      select id, collection_id, 'folder', true, 'Root', 'r1', 'ch1' from (values
        ('forbidden-needle-root','forbidden-needle'), ('pub-needle-root','pub-needle')
      ) roots(id, collection_id)
    `);
    await client.query(`
      insert into collection_members(collection_id, subject_id, role)
      select 'join-' || n::text, 'wide-subject', 'viewer' from generate_series(1, ${JOINED}) n
      union all
      select 'own-' || n::text, 'noise-' || n::text, 'viewer' from generate_series(1, ${OWNED}) n
    `);
    await client.query(`
      insert into nodes
        (id, collection_id, parent_id, kind, title, url, search_url_host, position_token,
         resource_revision, children_revision)
      values
        ('needle-node-own', 'own-1', 'own-1-root', 'bookmark', '${NEEDLE} owned node',
          'https://plan.example.test/own', 'plan.example.test', 'P000001', 'r1', 'ch1'),
        ('needle-node-join', 'join-2', 'join-2-root', 'bookmark', '${NEEDLE} joined node',
          'https://plan.example.test/join', 'plan.example.test', 'P000002', 'r1', 'ch1')
    `);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
