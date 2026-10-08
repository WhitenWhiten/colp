import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('P2B-04 Annotation expand migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_annotation_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('migrates an empty database with all Annotation constraints and live indexes', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname as name from pg_constraint
       where conrelid = 'annotations'::regclass
      union all
      select indexname from pg_indexes
       where schemaname = current_schema() and tablename = 'annotations'
    `);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'annotations_pkey', 'annotations_collection_subject_shape',
      'annotations_creator_nonempty', 'annotations_revision_format',
      'annotations_payload_object', 'annotations_live_subject_count_idx',
      'annotations_live_collection_updated_idx',
    ]) assert.ok(names.has(expected), `missing ${expected}`);
  });

  test('upgrades the previous stable production migration without test-created shadow tables', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase2b_annotation_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202607250300_publication_annotation_projection');
      const previous = await migrator.migrateTo('202607242200_public_profile_projection');
      if (previous.error) throw previous.error;
      const absent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.annotations') is not null as present`,
      );
      assert.equal(absent.rows[0]?.present, false);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const present = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.annotations') is not null as present`,
      );
      assert.equal(present.rows[0]?.present, true);
      const down = await migrator.migrateTo('202607242200_public_profile_projection');
      if (down.error) throw down.error;
      const removed = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.annotations') is not null as present`,
      );
      assert.equal(removed.rows[0]?.present, false);
      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      const restored = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.annotations') is not null as present`,
      );
      assert.equal(restored.rows[0]?.present, true);
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('database rejects cascades, malformed owner columns and payload/row authority drift', async () => {
    const fk = await isolated.runtime.pool.query<{ delete_rule: string }>(`
      select rc.delete_rule
        from information_schema.referential_constraints rc
       where rc.constraint_schema = current_schema()
         and rc.constraint_name in ('annotations_collection_fk', 'annotations_ledger_fk')
    `);
    assert.ok(fk.rows.length >= 2);
    assert.ok(fk.rows.every((row) => row.delete_rule === 'RESTRICT'));

    const collectionId = 'annotation-migration-collection';
    const rootId = 'annotation-migration-root';
    const nodeId = 'annotation-migration-node';
    const otherCollectionId = 'annotation-migration-other';
    const otherRootId = 'annotation-migration-other-root';
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'collection'),($5,'node')`,
      [collectionId, rootId, nodeId, otherCollectionId, otherRootId]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
        values ($1,'subject-owner','One','bookmarks','private',$2,'cr1','cc1','pr1',1),
               ($3,'subject-other','Two','bookmarks','private',$4,'cr2','cc2','pr2',1)`,
      [collectionId, rootId, otherCollectionId, otherRootId]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,resource_revision,children_revision)
        values ($1,$3,null,'folder',true,'Root',null,'[]','inherit',null,'rr1','rc1'),
               ($2,$3,$1,'bookmark',false,'Node','https://example.test','[]','inherit','U','nr1','nc1'),
               ($4,$5,null,'folder',true,'Other',null,'[]','inherit',null,'or1','oc1')`,
      [rootId, nodeId, collectionId, otherRootId, otherCollectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    const insertAnnotation = async (id: string, overrides: Record<string, unknown> = {}) => {
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
        values ($1,'annotation')`, [id]);
      const row = {
        collectionId, subjectType: 'node', subjectId: nodeId, creator: 'principal-owner',
        type: 'note', format: 'plain', value: 'value', visibility: 'private', revision: 'ar1',
        ...overrides,
      };
      const payloadRevision = typeof overrides.payloadRevision === 'string'
        ? overrides.payloadRevision
        : row.revision;
      const payload = { id, collectionId: row.collectionId, subject: { type: row.subjectType, id: row.subjectId },
        creator: { id: 'https://known.test/profiles/owner', name: 'Owner' }, type: row.type,
        format: row.format, value: row.value, visibility: row.visibility, revision: payloadRevision,
        createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z' };
      return isolated.runtime.pool.query(`insert into annotations
        (id,collection_id,subject_type,subject_id,creator_principal_id,type,format,value_json,
         visibility,resource_revision,created_at,updated_at,payload_json)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,current_timestamp,current_timestamp,$11)`,
      [id, row.collectionId, row.subjectType, row.subjectId, row.creator, row.type, row.format,
        JSON.stringify(row.value), row.visibility, row.revision, JSON.stringify(payload)]);
    };

    await assert.rejects(() => insertAnnotation('annotation-cross-subject', { subjectId: otherRootId }),
      (error: unknown) => (error as { code?: string }).code === '23514');
    await assert.rejects(() => insertAnnotation('annotation-empty-creator', { creator: '' }),
      (error: unknown) => (error as { constraint?: string }).constraint === 'annotations_creator_nonempty');
    await assert.rejects(() => insertAnnotation('annotation-invalid-type', { type: 'reading_state' }),
      (error: unknown) => (error as { constraint?: string }).constraint === 'annotations_type_supported');
    await assert.rejects(() => insertAnnotation('annotation-payload-drift', {
      revision: 'ar2', payloadRevision: 'different-revision',
    }), (error: unknown) => (error as { constraint?: string }).constraint === 'annotations_payload_authority');
    await insertAnnotation('annotation-valid');
    for (const statement of [
      `update annotations set payload_json='{}'::jsonb where id='annotation-valid'`,
      `update annotations set format='markdown' where id='annotation-valid'`,
      `update annotations set value_json='"different"'::jsonb where id='annotation-valid'`,
    ]) {
      await assert.rejects(() => isolated.runtime.pool.query(statement),
        (error: unknown) => (error as { constraint?: string }).constraint === 'annotations_payload_authority');
    }
    await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp where id=$1`, [nodeId]);
    await assert.rejects(() => insertAnnotation('annotation-deleted-subject'),
      (error: unknown) => (error as { code?: string }).code === '23514');

    await assert.rejects(() => isolated.runtime.pool.query(`delete from collections where id=$1`, [collectionId]),
      (error: unknown) => (error as { code?: string }).code === '23503');
    await assert.rejects(() => isolated.runtime.pool.query(`delete from resource_id_ledger where resource_id='annotation-valid'`),
      (error: unknown) => (error as { code?: string }).code === 'P0001');
  });
});
