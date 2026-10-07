import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-10 Relation expand migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_relation_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with endpoint, authority and live semantic indexes', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname as name from pg_constraint where conrelid = 'relations'::regclass
      union all
      select indexname from pg_indexes where schemaname = current_schema() and tablename = 'relations'
    `);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'relations_pkey', 'relations_distinct_endpoints', 'relations_type_supported',
      'relations_visibility_supported', 'relations_payload_authority',
      'relations_live_from_idx', 'relations_live_to_idx', 'relations_live_semantic_edge_uidx',
    ]) assert.ok(names.has(expected), `missing ${expected}`);
  });

  test('upgrades previous stable, migrates down/up, and applies each direction idempotently through Kysely', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase2b_relation_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607250700_publication_relation_projection');
      const previous = await migrator.migrateTo('202607250300_publication_annotation_projection');
      if (previous.error) throw previous.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.relations') is not null as present`,
      )).rows[0]?.present, false);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      assert.equal((await migrator.migrateToLatest()).results?.length ?? 0, 0);
      const down = await migrator.migrateTo('202607250300_publication_annotation_projection');
      if (down.error) throw down.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.relations') is not null as present`,
      )).rows[0]?.present, false);
      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      assert.equal((await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.relations') is not null as present`,
      )).rows[0]?.present, true);
      await migrator.upgradeToCurrentLatest();
    } finally { await upgrade.close(); }
  }, 120_000);

  test('database enforces same-Collection live endpoints, no self edges, explicit dedup and dual authority', async () => {
    const c = 'relation-migration-collection';
    const root = 'relation-migration-root';
    const a = 'relation-migration-a';
    const b = 'relation-migration-b';
    const other = 'relation-migration-other';
    const otherRoot = 'relation-migration-other-root';
    const fixtureClient = await isolated.runtime.pool.connect();
    try {
      await fixtureClient.query('begin');
      await fixtureClient.query('set constraints all deferred');
      await fixtureClient.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'collection'),($6,'node')`,
      [c, root, a, b, other, otherRoot]);
      await fixtureClient.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
        values ($1,'subject-owner','One','bookmarks','protected',$2,'cr1','cc1','pr1',1),
               ($3,'subject-other','Two','bookmarks','protected',$4,'cr2','cc2','pr2',1)`,
      [c, root, other, otherRoot]);
      await fixtureClient.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,resource_revision,children_revision)
        values ($1,$4,null,'folder',true,'Root',null,'[]','inherit',null,'rr','rc'),
               ($2,$4,$1,'bookmark',false,'A','https://a.test','[]','inherit','A','ar','ac'),
               ($3,$4,$1,'bookmark',false,'B','https://b.test','[]','protected','B','br','bc'),
               ($5,$6,null,'folder',true,'Other',null,'[]','inherit',null,'or','oc')`,
      [root, a, b, c, otherRoot, other]);
      await fixtureClient.query('commit');
    } finally {
      await fixtureClient.query('rollback').catch(() => undefined);
      fixtureClient.release();
    }

    const insert = async (id: string, from: string, to: string, type = 'related',
      label: string | null = null, payloadOverride: Record<string, unknown> = {}) => {
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'relation')`, [id]);
      const payload = { id, collectionId: c, type, fromNodeId: from, toNodeId: to,
        ...(label === null ? {} : { label }), visibility: 'protected',
        createdAt: '2026-07-25T04:00:00Z', updatedAt: '2026-07-25T04:00:00Z',
        revision: 'relation-r1', ...payloadOverride };
      return isolated.runtime.pool.query(`insert into relations
        (id,collection_id,from_node_id,to_node_id,type,label,visibility,resource_revision,
         created_at,updated_at,payload_json) values
        ($1,$2,$3,$4,$5,$6,'protected','relation-r1',
         '2026-07-25T04:00:00Z'::timestamptz,'2026-07-25T04:00:00Z'::timestamptz,$7)`,
      [id, c, from, to, type, label, JSON.stringify(payload)]);
    };

    await assert.rejects(() => insert('relation-self', a, a),
      (error: unknown) => (error as { constraint?: string }).constraint === 'relations_distinct_endpoints');
    await assert.rejects(() => insert('relation-cross', a, otherRoot),
      (error: unknown) => (error as { code?: string }).code === '23514');
    await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp where id=$1`, [b]);
    await assert.rejects(() => insert('relation-deleted-endpoint', a, b),
      (error: unknown) => (error as { code?: string }).code === '23514');
    await isolated.runtime.pool.query(`update nodes set deleted_at=null where id=$1`, [b]);
    await insert('relation-live', a, b);
    for (const statement of [
      `update relations set payload_json='{}'::jsonb where id='relation-live'`,
      `update relations set from_node_id='${root}' where id='relation-live'`,
      `update relations set visibility='private' where id='relation-live'`,
    ]) {
      await assert.rejects(() => isolated.runtime.pool.query(statement),
        (error: unknown) => (error as { constraint?: string }).constraint === 'relations_payload_authority');
    }
    await assert.rejects(() => insert('relation-duplicate-label', a, b, 'related', 'different'),
      (error: unknown) => (error as { constraint?: string }).constraint === 'relations_live_semantic_edge_uidx');
    await insert('relation-reverse', b, a);
    await insert('relation-different-type', a, b, 'supports');
    await assert.rejects(() => insert('relation-payload-drift', a, b, 'mentions', null,
      { toNodeId: root }), (error: unknown) =>
      (error as { constraint?: string }).constraint === 'relations_payload_authority');
    await isolated.runtime.pool.query(`update relations set deleted_at=current_timestamp,
      deleted_commit_ordinal=2 where id='relation-live'`);
    await insert('relation-rebuilt', a, b);
  });
});
