import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  productionMigrationNamesFromInclusive,
  productionMigrationNamesNewestFirstUntil,
} from '../../../scripts/lexical-migration-head.mjs';

const INDEX_NAME = 'nodes_live_editor_keyset_idx';

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainEvidence {
  readonly Plan: PlanNode;
  readonly 'Planning Time': number;
  readonly 'Execution Time': number;
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

describeWithPostgres('live Editor keyset expression index', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('editor_keyset', {
      maxConnections: 2,
      applicationName: 'known-editor-keyset-index-test',
    });
    const initial = await createHistoricalMigrator(isolated, '202607240100_publication_locators').migrateToLatest();
    if (initial.error) throw initial.error;
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test('applies and rolls back the live-only expression index', async () => {
    const index = await isolated.runtime.pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = current_schema() and indexname = $1`,
      [INDEX_NAME],
    );
    assert.equal(index.rowCount, 1);
    assert.match(index.rows[0]?.indexdef ?? '', /COALESCE\(parent_id, ''::text\).*COLLATE "C"/i);
    assert.match(index.rows[0]?.indexdef ?? '', /COALESCE\(position_token, ''::text\).*COLLATE "C"/i);
    assert.match(index.rows[0]?.indexdef ?? '', /deleted_at IS NULL/i);
    assert.match(index.rows[0]?.indexdef ?? '', /NOT is_root/i);

    const newerDown: string[] = [];
    while (!newerDown.includes('202607240100_publication_locators')) {
      const result = await runMigrations(isolated.runtime.db, 'down');
      newerDown.push(...result.results.map((migration) => migration.migrationName));
    }
    assert.deepEqual(newerDown, ['202607240100_publication_locators']);
    const retentionDown = await runMigrations(isolated.runtime.db, 'down');
    assert.deepEqual(retentionDown.results.map((result) => result.migrationName), [
      '202607222900_publisher_receipt_retention',
    ]);
    const down = await runMigrations(isolated.runtime.db, 'down');
    assert.deepEqual(down.results.map((result) => result.migrationName), [
      '202607222800_live_editor_keyset_index',
    ]);
    const absent = await isolated.runtime.pool.query<{ index_name: string | null }>(
      `select to_regclass($1)::text as index_name`,
      [`${isolated.schema}.${INDEX_NAME}`],
    );
    assert.equal(absent.rows[0]?.index_name, null);

    const up = await runMigrations(isolated.runtime.db, 'up');
    assert.deepEqual(up.results.map((result) => result.migrationName), [
      '202607222800_live_editor_keyset_index',
    ]);
    const retentionUp = await runMigrations(isolated.runtime.db, 'up');
    assert.deepEqual(retentionUp.results.map((result) => result.migrationName), [
      '202607222900_publisher_receipt_retention',
    ]);
    const newerUp = await runMigrations(isolated.runtime.db, 'latest');
    assert.deepEqual(newerUp.results.map((result) => result.migrationName), productionMigrationNamesFromInclusive('202607240100_publication_locators'));
  }, 120_000);

  test('uses the intended index for a representative continuation without full sort or scan', async () => {
    const collectionId = 'editor-keyset-collection';
    const rootId = 'editor-keyset-root';
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type)
         values ($1, 'collection'), ($2, 'node')`,
        [collectionId, rootId],
      );
      await client.query(
        `insert into collections
           (id, owner_subject_id, title, kind, root_node_id,
            resource_revision, content_revision, policy_revision)
         values ($1, 'editor-owner', 'Editor keyset fixture', 'bookmarks', $2,
                 'r1', 'c1', 'p1')`,
        [collectionId, rootId],
      );
      await client.query(
        `insert into nodes
           (id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, 'Root', 'r1', 'ch1')`,
        [rootId, collectionId],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type)
         select 'editor-keyset-node-' || lpad(n::text, 6, '0'), 'node'
         from generate_series(1, 6000) as n`,
      );
      await client.query(
        `insert into nodes
           (id, collection_id, parent_id, kind, title, url, position_token,
            resource_revision, children_revision)
         select 'editor-keyset-node-' || lpad(n::text, 6, '0'), $1, $2,
                'bookmark', 'Node ' || n::text, 'https://example.test/' || n::text,
                'P' || lpad(n::text, 6, '0'), 'r1', 'ch1'
         from generate_series(1, 6000) as n`,
        [collectionId, rootId],
      );
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await isolated.runtime.pool.query('analyze nodes');
    const explained = await isolated.runtime.pool.query<{ 'QUERY PLAN': ExplainEvidence[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT id, collection_id, parent_id, kind, is_root, title, url,
              description, tags, visibility, position_token, resource_revision,
              children_revision, created_at, updated_at, deleted_at,
              deleted_commit_ordinal, payload_json
       FROM nodes
       WHERE collection_id = $1
         AND NOT is_root
         AND deleted_at IS NULL
         AND (
           COALESCE(parent_id, ''::text) COLLATE "C",
           COALESCE(position_token, ''::text) COLLATE "C",
           id COLLATE "C"
         ) > (
           $2::text COLLATE "C",
           $3::text COLLATE "C",
           $4::text COLLATE "C"
         )
       ORDER BY
         COALESCE(parent_id, ''::text) COLLATE "C",
         COALESCE(position_token, ''::text) COLLATE "C",
         id COLLATE "C"
       LIMIT 101`,
      [collectionId, rootId, 'P003000', 'editor-keyset-node-003000'],
    );
    const evidence = explained.rows[0]?.['QUERY PLAN']?.[0];
    assert.ok(evidence, 'PostgreSQL returned no JSON plan evidence');
    const nodes = flattenPlan(evidence.Plan);
    assert.ok(
      nodes.some((node) => node['Index Name'] === INDEX_NAME),
      `expected ${INDEX_NAME}: ${JSON.stringify(evidence)}`,
    );
    assert.ok(
      nodes.every((node) => node['Node Type'] !== 'Sort'),
      `unexpected full sort: ${JSON.stringify(evidence)}`,
    );
    assert.ok(
      nodes.every((node) => !(
        node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'nodes'
      )),
      `unexpected nodes sequential scan: ${JSON.stringify(evidence)}`,
    );
    console.info(JSON.stringify({ evidence: 'editor-keyset-plan', plan: evidence }));
  });
});
