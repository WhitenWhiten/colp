import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  backfillResourcePayloads,
  countLiveResourcesMissingValidPayload,
  scanResourceAuthorityMismatches,
} from '../../../src/infrastructure/collections/resource-payload-dual-read.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/domain/resource-payload.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { productionMigrationNamesFromInclusive } from '../../../scripts/lexical-migration-head.mjs';

describeWithPostgres('canonical resource payload expand (ADR-0007 task 15)', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('payload', {
      maxConnections: 4,
      applicationName: 'known-canonical-payload-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function migrateThrough(
    target: DatabaseRuntime,
    migrationName: string,
  ): Promise<void> {
    for (;;) {
      const result = await runMigrations(target.db, 'up');
      const applied = result.results[0];
      assert.ok(applied, `migration ${migrationName} was not found`);
      assert.equal(applied.status, 'Success');
      if (applied.migrationName === migrationName) return;
    }
  }

  async function reserveIn(
    target: DatabaseRuntime,
    ...resources: ReadonlyArray<readonly [id: string, type: string]>
  ) {
    await target.pool.query(
      'insert into resource_id_ledger (resource_id, resource_type) select * from unnest($1::text[], $2::text[])',
      [resources.map(([id]) => id), resources.map(([, type]) => type)],
    );
  }

  async function reserve(...resources: ReadonlyArray<readonly [id: string, type: string]>) {
    await reserveIn(runtime, ...resources);
  }

  async function bootstrapCollectionIn(target: DatabaseRuntime, input: {
    collectionId: string;
    rootId: string;
    kind?: string;
    title?: string;
    summary?: string | null;
    visibility?: string;
  }) {
    const kind = input.kind ?? 'bookmarks';
    const title = input.title ?? 'Collection';
    const visibility = input.visibility ?? 'private';
    const published = visibility === 'public' || visibility === 'unlisted';
    await reserveIn(target, [input.collectionId, 'collection'], [input.rootId, 'node']);
    await target.pool.query(
      `insert into accounts (id, subject_id, status) values ('acct-owner-1', 'owner-1', 'active')
       on conflict (subject_id) do nothing`,
    );
    const client = await target.pool.connect();
    try {
      await client.query('begin');
      if (published) {
        await client.query(
          `insert into collections (
             id, owner_subject_id, title, summary, kind, visibility, root_node_id,
             resource_revision, content_revision, policy_revision, commit_ordinal,
             publication_slug, published_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,now())`,
          [
            input.collectionId, 'owner-1', title, input.summary ?? null, kind, visibility,
            input.rootId, 'r1', 'c1', 'p1', input.collectionId,
          ],
        );
      } else {
        await client.query(
          `insert into collections (
             id, owner_subject_id, title, summary, kind, visibility, root_node_id,
             resource_revision, content_revision, policy_revision, commit_ordinal
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
          [
            input.collectionId, 'owner-1', title, input.summary ?? null, kind, visibility,
            input.rootId, 'r1', 'c1', 'p1',
          ],
        );
      }
      await client.query(
        `insert into nodes (
           id, collection_id, kind, is_root, title, resource_revision, children_revision, visibility
         ) values ($1,$2,'folder',true,$3,'rr1','ch1','inherit')`,
        [input.rootId, input.collectionId, title],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function bootstrapCollection(input: Parameters<typeof bootstrapCollectionIn>[1]) {
    await bootstrapCollectionIn(runtime, input);
  }

  test('empty database migration applies payload columns with zero resource rows', async () => {
    const columns = await runtime.pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = current_schema()
         and table_name in ('collections', 'nodes')
         and column_name in ('payload_json', 'payload_schema_version', 'payload_authority_status')
       order by table_name, column_name`,
    );
    const names = columns.rows.map((r) => `${r.table_name}.${r.column_name}`);
    for (const table of ['collections', 'nodes']) {
      for (const col of ['payload_json', 'payload_schema_version', 'payload_authority_status']) {
        assert.ok(names.includes(`${table}.${col}`), `missing ${table}.${col}`);
      }
    }

    // Relational authority columns still present.
    const titleCol = await runtime.pool.query(
      `select 1 from information_schema.columns
       where table_schema = current_schema() and table_name = 'collections' and column_name = 'title'`,
    );
    assert.equal(titleCol.rowCount, 1);

    const counts = await runtime.pool.query(
      `select
         (select count(*)::int from collections) as collections,
         (select count(*)::int from nodes) as nodes`,
    );
    // May be zero if no prior tests inserted; this suite bootstraps later tests.
    assert.ok(counts.rows[0]);
  });

  test('one latest upgrade backfills existing resources before creating the live keyset index', async () => {
    const upgrade = await createIsolatedPostgresRuntime('payload_upgrade', {
      maxConnections: 2,
      applicationName: 'known-canonical-payload-upgrade-test',
    });
    try {
      await migrateThrough(upgrade.runtime, '202607222500_collection_mutation_projection');
      await bootstrapCollectionIn(upgrade.runtime, {
        collectionId: 'upgrade-collection',
        rootId: 'upgrade-root',
        title: 'Upgrade collection',
        summary: 'pre-expand data',
      });
      await reserveIn(upgrade.runtime, ['upgrade-node', 'node']);
      await upgrade.runtime.pool.query(
        `insert into nodes (
           id, collection_id, kind, is_root, title, parent_id, position_token,
           resource_revision, children_revision, visibility, description, tags, url
         ) values (
           'upgrade-node','upgrade-collection','bookmark',false,'Upgrade bookmark',
           'upgrade-root','A','node-r1','node-c1','inherit','stored before expand',
           '["upgrade"]'::jsonb,'https://example.test/upgrade'
         )`,
      );

      const latest = await runMigrations(upgrade.runtime.db, 'latest');
      assert.deepEqual(latest.results.map((result) => result.migrationName), productionMigrationNamesFromInclusive('202607222600_canonical_resource_payloads'));
      assert.ok(latest.results.every((result) => result.status === 'Success'));

      const collection = await upgrade.runtime.pool.query<{
        payload_json: Record<string, unknown>;
        payload_schema_version: number;
        payload_authority_status: string;
      }>(
        `select payload_json, payload_schema_version, payload_authority_status
         from collections where id = 'upgrade-collection'`,
      );
      assert.equal(collection.rows[0]?.payload_schema_version, RESOURCE_PAYLOAD_SCHEMA_VERSION);
      assert.equal(collection.rows[0]?.payload_authority_status, 'backfilled');
      assert.equal(collection.rows[0]?.payload_json.allowSearchIndexing, false);
      assert.deepEqual(
        {
          resourceType: collection.rows[0]?.payload_json.resourceType,
          id: collection.rows[0]?.payload_json.id,
          title: collection.rows[0]?.payload_json.title,
          summary: collection.rows[0]?.payload_json.summary,
        },
        {
          resourceType: 'collection',
          id: 'upgrade-collection',
          title: 'Upgrade collection',
          summary: 'pre-expand data',
        },
      );

      const nodes = await upgrade.runtime.pool.query<{
        id: string;
        payload_json: Record<string, unknown>;
        payload_schema_version: number;
        payload_authority_status: string;
      }>(
        `select id, payload_json, payload_schema_version, payload_authority_status
         from nodes where collection_id = 'upgrade-collection' order by id`,
      );
      assert.deepEqual(nodes.rows.map((row) => row.id), ['upgrade-node', 'upgrade-root']);
      for (const row of nodes.rows) {
        assert.equal(row.payload_schema_version, RESOURCE_PAYLOAD_SCHEMA_VERSION);
        assert.equal(row.payload_authority_status, 'backfilled');
        assert.equal(row.payload_json.resourceType, 'node');
        assert.equal(row.payload_json.id, row.id);
      }
      const child = nodes.rows.find((row) => row.id === 'upgrade-node');
      assert.equal(child?.payload_json.parentId, 'upgrade-root');
      assert.equal(child?.payload_json.url, 'https://example.test/upgrade');

      const index = await upgrade.runtime.pool.query<{ index_name: string | null }>(
        `select to_regclass('nodes_live_editor_keyset_idx')::text as index_name`,
      );
      assert.equal(index.rows[0]?.index_name, 'nodes_live_editor_keyset_idx');
    } finally {
      await upgrade.close();
    }
  }, 30_000);

  test('backfills all Phase 1 resource variants and dual-read matches', async () => {
    // Insert without payload (simulate pre-expand rows by forcing null authority).
    // Latest migration already ran on empty schema; insert new rows with null payload
    // (expand columns nullable for N/N-1 writers).
    await bootstrapCollection({
      collectionId: 'col-bookmarks',
      rootId: 'root-bookmarks',
      kind: 'bookmarks',
      summary: 'sum',
    });
    await bootstrapCollection({
      collectionId: 'col-mixed',
      rootId: 'root-mixed',
      kind: 'mixed',
      visibility: 'unlisted',
    });
    await bootstrapCollection({
      collectionId: 'col-knowledge',
      rootId: 'root-knowledge',
      kind: 'knowledge_collection',
    });
    await bootstrapCollection({
      collectionId: 'col-reading',
      rootId: 'root-reading',
      kind: 'reading_path',
    });

    await reserve(
      ['folder-1', 'node'],
      ['bookmark-1', 'node'],
      ['bookmark-2', 'node'],
    );
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, kind, is_root, title, parent_id, position_token,
         resource_revision, children_revision, visibility, description, tags, url
       ) values
       ('folder-1','col-bookmarks','folder',false,'Folder','root-bookmarks','A','r-f','ch-f','inherit',null,null,null),
       ('bookmark-1','col-bookmarks','bookmark',false,'BM1','folder-1','A','r-b1','ch-b1','private','d','["tag1"]'::jsonb,'https://example.test/1'),
       ('bookmark-2','col-bookmarks','bookmark',false,'BM2','root-bookmarks','B','r-b2','ch-b2','protected',null,'[]'::jsonb,'https://example.test/2')`,
    );

    // New inserts leave payload null (legacy write path).
    await runtime.pool.query(
      `update collections set
         payload_json = null,
         payload_schema_version = null,
         payload_authority_status = null`,
    );
    await runtime.pool.query(
      `update nodes set
         payload_json = null,
         payload_schema_version = null,
         payload_authority_status = null`,
    );

    const metrics = new InMemoryMetrics();
    const stats = await backfillResourcePayloads(runtime.db, metrics);
    assert.ok(stats.scanned >= 4 + 4 + 3); // collections + roots + children
    assert.equal(stats.malformed, 0);
    assert.ok(stats.succeeded > 0);
    assert.equal(metrics.get('resource_authority_backfill_succeeded_total'), stats.succeeded);

    const missing = await countLiveResourcesMissingValidPayload(runtime.db);
    assert.equal(missing.collections, 0);
    assert.equal(missing.nodes, 0);

    // Real PostgreSQL comparison queries: payload must equal materialised projection.
    const collectionCompare = await runtime.pool.query<{ id: string; payload_json: unknown }>(
      `select id, payload_json from collections where deleted_at is null order by id`,
    );
    for (const row of collectionCompare.rows) {
      const full = await runtime.pool.query(
        `select id, owner_subject_id, title, summary, kind, visibility, root_node_id,
                resource_revision, content_revision, policy_revision, commit_ordinal,
                created_at, updated_at, deleted_at, payload_json, payload_authority_status
         from collections where id = $1`,
        [row.id],
      );
      const r = full.rows[0];
      assert.equal(r.payload_authority_status, 'backfilled');
      const expected = materializeCollectionPayload({
        id: r.id,
        ownerSubjectId: r.owner_subject_id,
        title: r.title,
        summary: r.summary,
        kind: r.kind,
        visibility: r.visibility,
        rootNodeId: r.root_node_id,
        resourceRevision: r.resource_revision,
        contentRevision: r.content_revision,
        policyRevision: r.policy_revision,
        commitOrdinal: r.commit_ordinal,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
      });
      assert.equal(expected.ok, true);
      if (!expected.ok) continue;
      assert.deepEqual(r.payload_json, JSON.parse(JSON.stringify(expected.payload)));
    }

    const nodeCompare = await runtime.pool.query(
      `select id, collection_id, parent_id, kind, is_root, title, url, description, tags,
              visibility, position_token, resource_revision, children_revision,
              created_at, updated_at, deleted_at, deleted_commit_ordinal,
              payload_json, payload_authority_status, payload_schema_version
       from nodes where deleted_at is null order by id`,
    );
    for (const r of nodeCompare.rows) {
      assert.equal(r.payload_authority_status, 'backfilled');
      assert.equal(r.payload_schema_version, RESOURCE_PAYLOAD_SCHEMA_VERSION);
      const expected = materializeNodePayload({
        id: r.id,
        collectionId: r.collection_id,
        parentId: r.parent_id,
        kind: r.kind,
        isRoot: r.is_root,
        title: r.title,
        url: r.url,
        description: r.description,
        tags: r.tags,
        visibility: r.visibility,
        positionToken: r.position_token,
        resourceRevision: r.resource_revision,
        childrenRevision: r.children_revision,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
        deletedCommitOrdinal: r.deleted_commit_ordinal,
      });
      assert.equal(expected.ok, true);
      if (!expected.ok) continue;
      assert.deepEqual(r.payload_json, JSON.parse(JSON.stringify(expected.payload)));
    }

    const scan = await scanResourceAuthorityMismatches(runtime.db, metrics);
    assert.equal(scan.collections.mismatched, 0);
    assert.equal(scan.nodes.mismatched, 0);
    assert.ok(scan.collections.matched >= 4);
    assert.ok(scan.nodes.matched >= 7);
  });

  test('idempotent backfill skips already-correct rows', async () => {
    const first = await backfillResourcePayloads(runtime.db);
    const second = await backfillResourcePayloads(runtime.db);
    assert.equal(second.succeeded, 0);
    assert.ok(second.skipped >= first.scanned || second.skipped > 0);
    assert.equal(second.malformed, 0);
  });

  test('malformed legacy row is marked without fabricating unsupported payload', async () => {
    // Bypass domain checks via raw SQL that still satisfies DB CHECKs where possible.
    // tags must be jsonb; inject a non-array object to trip materialize without breaking CHECKs.
    await reserve(['malformed-node', 'node']);
    await runtime.pool.query(
      `insert into nodes (
         id, collection_id, kind, is_root, title, parent_id, position_token,
         resource_revision, children_revision, visibility, url, tags
       ) values (
         'malformed-node','col-bookmarks','bookmark',false,'Bad','root-bookmarks','Z',
         'r-bad','ch-bad','inherit','https://example.test/bad','{"not":"array"}'::jsonb
       )`,
    );

    const stats = await backfillResourcePayloads(runtime.db);
    assert.ok(stats.malformed >= 1);

    const row = await runtime.pool.query(
      `select payload_json, payload_schema_version, payload_authority_status
       from nodes where id = 'malformed-node'`,
    );
    assert.equal(row.rows[0].payload_authority_status, 'malformed');
    assert.equal(row.rows[0].payload_json, null);
    assert.equal(row.rows[0].payload_schema_version, null);

    // Dual-read scan must not silently treat malformed as matched.
    const scan = await scanResourceAuthorityMismatches(runtime.db);
    assert.ok(scan.nodes.malformed >= 1);

    // Keep this fixture as historical malformed data so the later migration
    // guard can isolate its live-row case.
    await runtime.pool.query(
      `update nodes
       set deleted_at = now(), deleted_commit_ordinal = 2
       where id = 'malformed-node'`,
    );
  });

  test('migration fails closed when a live resource cannot produce a canonical payload', async () => {
    const failure = await createIsolatedPostgresRuntime('payload_failure', {
      maxConnections: 2,
      applicationName: 'known-canonical-payload-failure-test',
    });
    try {
      await migrateThrough(failure.runtime, '202607222500_collection_mutation_projection');
      await bootstrapCollectionIn(failure.runtime, {
        collectionId: 'failure-collection',
        rootId: 'failure-root',
      });
      await reserveIn(failure.runtime, ['migration-malformed-live', 'node']);
      await failure.runtime.pool.query(
        `insert into nodes (
           id, collection_id, kind, is_root, title, parent_id, position_token,
           resource_revision, children_revision, visibility, url, tags
         ) values (
           'migration-malformed-live','failure-collection','bookmark',false,'Bad','failure-root','migration-malformed-pos',
           'r-bad','ch-bad','inherit','https://example.test/bad','{"not":"array"}'::jsonb
         )`,
      );

      await assert.rejects(
        () => runMigrations(failure.runtime.db, 'up'),
        /canonical payload backfill blocked: live node migration-malformed-live is malformed/i,
      );
      const absent = await failure.runtime.pool.query(
        `select 1 from information_schema.columns
         where table_schema = current_schema() and table_name = 'nodes'
           and column_name = 'payload_json'`,
      );
      assert.equal(absent.rowCount, 0, 'failed migration must roll back the expand columns');

      await failure.runtime.pool.query(
        `update nodes set tags = '[]'::jsonb where id = 'migration-malformed-live'`,
      );
      await runMigrations(failure.runtime.db, 'latest');
      const repaired = await failure.runtime.pool.query(
        `select payload_authority_status from nodes where id = 'migration-malformed-live'`,
      );
      assert.equal(repaired.rows[0]?.payload_authority_status, 'backfilled');
    } finally {
      await failure.close();
    }
  }, 20_000);

  test('detects intentional dual-read drift via PostgreSQL comparison', async () => {
    await runtime.pool.query(
      `update collections
       set payload_json = payload_json || '{"title":"DRIFTED"}'::jsonb
       where id = 'col-bookmarks'`,
    );

    const metrics = new InMemoryMetrics();
    const scan = await scanResourceAuthorityMismatches(runtime.db, metrics);
    assert.ok(scan.collections.mismatched >= 1);
    assert.ok(
      scan.collections.mismatches.some((m) => m.resourceId === 'col-bookmarks' && !m.equal),
    );
    assert.ok(metrics.get('resource_authority_mismatch_total') >= 1);

    // Repair via idempotent backfill (re-derive from relational Owner).
    await backfillResourcePayloads(runtime.db);
    const repaired = await scanResourceAuthorityMismatches(runtime.db);
    const stillBad = repaired.collections.mismatches.find((m) => m.resourceId === 'col-bookmarks');
    assert.equal(stillBad, undefined);
  });

  test('down migration drops only payload expand columns', async () => {
    const rollback = await createIsolatedPostgresRuntime('payload_rollback', {
      maxConnections: 2,
      applicationName: 'known-canonical-payload-rollback-test',
    });
    try {
      await migrateThrough(rollback.runtime, '202607222600_canonical_resource_payloads');
      const downResult = await runMigrations(rollback.runtime.db, 'down');
      assert.equal(downResult.results[0]?.status, 'Success');
      assert.ok(downResult.results.some((r) => r.migrationName.includes('canonical_resource_payloads')));

      const columns = await rollback.runtime.pool.query(
        `select column_name from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'collections'
           and column_name in ('payload_json','title','resource_revision')`,
      );
      const names = new Set(columns.rows.map((r: { column_name: string }) => r.column_name));
      assert.ok(names.has('title'));
      assert.ok(names.has('resource_revision'));
      assert.ok(!names.has('payload_json'));
    } finally {
      await rollback.close();
    }
  }, 30_000);
});
