import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const INDEX_NAME = 'nodes_live_sibling_position_c_idx';
const UNIQUE_INDEX_NAME = 'nodes_live_sibling_position_unique';
const PREVIOUS_STABLE_MIGRATION = '202607311000_social_feed_fanout_continuation';
const MIGRATION_NAME = '202608011000_nodes_live_sibling_position_c_idx';

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Actual Rows'?: number;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainEvidence {
  readonly Plan: PlanNode;
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
}

function flattenPlan(node: PlanNode): readonly PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function assertBoundedSiblingPlan(
  plan: ExplainEvidence | undefined,
  indexName: string,
): void {
  assert.ok(plan, 'PostgreSQL returned no JSON plan evidence');
  const nodes = flattenPlan(plan.Plan);
  const indexScan = nodes.find((node) => node['Index Name'] === indexName);
  assert.ok(indexScan, `expected ${indexName} in plan: ${JSON.stringify(plan.Plan)}`);
  assert.ok(
    indexScan['Index Cond'],
    `expected Index Cond on ${indexName}: ${JSON.stringify(indexScan)}`,
  );
  assert.ok(
    nodes.every((node) => node['Node Type'] !== 'Sort'),
    `unexpected Sort in plan: ${JSON.stringify(plan.Plan)}`,
  );
  assert.ok(
    nodes.every((node) => !(
      node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'nodes'
    )),
    `unexpected nodes sequential scan: ${JSON.stringify(plan.Plan)}`,
  );
  assert.ok((plan.Plan['Actual Rows'] ?? Number.POSITIVE_INFINITY) <= 2);
}

async function indexPresent(isolated: IsolatedPostgresRuntime, indexName: string): Promise<boolean> {
  const result = await isolated.runtime.pool.query<{ index_name: string | null }>(
    `select to_regclass($1)::text as index_name`,
    [`${isolated.schema}.${indexName}`],
  );
  return result.rows[0]?.index_name !== null;
}

async function seedSiblingFixture(
  isolated: IsolatedPostgresRuntime,
  siblingCount: number,
): Promise<{
  readonly collectionId: string;
  readonly parentId: string;
  readonly anchorToken: string;
  readonly anchorId: string;
  readonly predecessorToken: string;
  readonly predecessorId: string;
  readonly successorToken: string;
  readonly successorId: string;
  readonly tailToken: string;
  readonly tailId: string;
}> {
  const collectionId = 'sibling-c-index-collection';
  const parentId = 'sibling-c-index-parent';
  const anchorOrdinal = Math.floor(siblingCount / 2);
  const anchorToken = `P${String(anchorOrdinal).padStart(6, '0')}`;
  const anchorId = `sibling-c-index-node-${String(anchorOrdinal).padStart(6, '0')}`;
  const predecessorOrdinal = anchorOrdinal - 1;
  const successorOrdinal = anchorOrdinal + 1;
  const predecessorToken = `P${String(predecessorOrdinal).padStart(6, '0')}`;
  const predecessorId = `sibling-c-index-node-${String(predecessorOrdinal).padStart(6, '0')}`;
  const successorToken = `P${String(successorOrdinal).padStart(6, '0')}`;
  const successorId = `sibling-c-index-node-${String(successorOrdinal).padStart(6, '0')}`;
  const tailToken = `P${String(siblingCount).padStart(6, '0')}`;
  const tailId = `sibling-c-index-node-${String(siblingCount).padStart(6, '0')}`;

  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       values ($1, 'collection'), ($2, 'node')`,
      [collectionId, parentId],
    );
    await client.query(
      `insert into collections
         (id, owner_subject_id, title, kind, root_node_id,
          resource_revision, content_revision, policy_revision)
       values ($1, 'sibling-c-owner', 'Sibling C index fixture', 'bookmarks', $2,
               'r1', 'c1', 'p1')`,
      [collectionId, parentId],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, kind, is_root, title, resource_revision, children_revision)
       values ($1, $2, 'folder', true, 'Parent', 'r1', 'ch1')`,
      [parentId, collectionId],
    );
    await client.query(
      `insert into resource_id_ledger (resource_id, resource_type)
       select 'sibling-c-index-node-' || lpad(n::text, 6, '0'), 'node'
       from generate_series(1, $1) as n`,
      [siblingCount],
    );
    await client.query(
      `insert into nodes
         (id, collection_id, parent_id, kind, title, url, position_token,
          resource_revision, children_revision)
       select 'sibling-c-index-node-' || lpad(n::text, 6, '0'), $1, $2,
              'bookmark', 'Node ' || n::text, 'https://example.test/' || n::text,
              'P' || lpad(n::text, 6, '0'), 'r1', 'ch1'
       from generate_series(1, $3) as n`,
      [collectionId, parentId, siblingCount],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  return {
    collectionId,
    parentId,
    anchorToken,
    anchorId,
    predecessorToken,
    predecessorId,
    successorToken,
    successorId,
    tailToken,
    tailId,
  };
}

describeWithPostgres('live sibling C collation index', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('nodes_live_sibling_position_c_idx', {
      maxConnections: 2,
      applicationName: 'known-sibling-c-index-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('applies on latest schema and keeps the existing unique sibling index', async () => {
    const index = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = current_schema() and indexname = $1`,
      [INDEX_NAME],
    );
    assert.equal(index.rowCount, 1);
    assert.match(
      index.rows[0]?.indexdef ?? '',
      /collection_id,\s*parent_id,\s*(?:\(position_token COLLATE "C"\)|position_token COLLATE "C"),\s*id/i,
    );
    assert.match(index.rows[0]?.indexdef ?? '', /deleted_at IS NULL/i);

    const unique = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = current_schema() and indexname = $1`,
      [UNIQUE_INDEX_NAME],
    );
    assert.equal(unique.rowCount, 1);
    assert.match(unique.rows[0]?.indexdef ?? '', /UNIQUE/i);
  });

  test('upgrades from fan-out head and rolls back without leaving the C index behind', async () => {
    const upgrade = await createIsolatedPostgresRuntime('nodes_live_sibling_position_c_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      assert.equal(await indexPresent(upgrade, INDEX_NAME), false);
      assert.equal(await indexPresent(upgrade, UNIQUE_INDEX_NAME), true);

      const latest = await migrator.migrateTo(MIGRATION_NAME);
      if (latest.error) throw latest.error;
      assert.equal(await indexPresent(upgrade, INDEX_NAME), true);
      assert.equal(await indexPresent(upgrade, UNIQUE_INDEX_NAME), true);

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await indexPresent(upgrade, INDEX_NAME), false);
      assert.equal(await indexPresent(upgrade, UNIQUE_INDEX_NAME), true);

      const forward = await migrator.migrateTo(MIGRATION_NAME);
      if (forward.error) throw forward.error;
      assert.equal(await indexPresent(upgrade, INDEX_NAME), true);
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('uses the C index for predecessor, successor and tail placement probes at 10k siblings', async () => {
    const fixture = await seedSiblingFixture(isolated, 10_000);
    await isolated.runtime.pool.query('analyze nodes');

    const predecessor = await isolated.runtime.pool.query<{ id: string; position_token: string }>(
      `select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
         and (position_token collate "C", id) < ($3::text collate "C", $4)
       order by position_token collate "C" desc, id desc
       limit 1`,
      [fixture.collectionId, fixture.parentId, fixture.anchorToken, fixture.anchorId],
    );
    assert.equal(predecessor.rowCount, 1);
    assert.deepEqual(predecessor.rows[0], {
      id: fixture.predecessorId,
      position_token: fixture.predecessorToken,
    });

    const predecessorPlan = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
         and (position_token collate "C", id) < ($3::text collate "C", $4)
       order by position_token collate "C" desc, id desc
       limit 1`,
      [fixture.collectionId, fixture.parentId, fixture.anchorToken, fixture.anchorId],
    );
    assertBoundedSiblingPlan(predecessorPlan.rows[0]?.['QUERY PLAN']?.[0], INDEX_NAME);

    const successor = await isolated.runtime.pool.query<{ id: string; position_token: string }>(
      `select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
         and (position_token collate "C", id) > ($3::text collate "C", $4)
       order by position_token collate "C" asc, id asc
       limit 1`,
      [fixture.collectionId, fixture.parentId, fixture.anchorToken, fixture.anchorId],
    );
    assert.equal(successor.rowCount, 1);
    assert.deepEqual(successor.rows[0], {
      id: fixture.successorId,
      position_token: fixture.successorToken,
    });

    const successorPlan = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
         and (position_token collate "C", id) > ($3::text collate "C", $4)
       order by position_token collate "C" asc, id asc
       limit 1`,
      [fixture.collectionId, fixture.parentId, fixture.anchorToken, fixture.anchorId],
    );
    assertBoundedSiblingPlan(successorPlan.rows[0]?.['QUERY PLAN']?.[0], INDEX_NAME);

    const tail = await isolated.runtime.pool.query<{ id: string; position_token: string }>(
      `select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
       order by position_token collate "C" desc, id desc
       limit 1`,
      [fixture.collectionId, fixture.parentId],
    );
    assert.equal(tail.rowCount, 1);
    assert.deepEqual(tail.rows[0], {
      id: fixture.tailId,
      position_token: fixture.tailToken,
    });

    const tailPlan = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       select id, position_token
       from nodes
       where collection_id = $1
         and parent_id = $2
         and deleted_at is null
       order by position_token collate "C" desc, id desc
       limit 1`,
      [fixture.collectionId, fixture.parentId],
    );
    assertBoundedSiblingPlan(tailPlan.rows[0]?.['QUERY PLAN']?.[0], INDEX_NAME);
  }, 120_000);
});
