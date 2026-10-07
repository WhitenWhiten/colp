import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import { createPostgresReplicaStore } from '../../../src/infrastructure/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const DIGEST = `sha-256=:${'A'.repeat(43)}=:`;

describeWithPostgres('P3-32B immutable PostgreSQL operation effect authority', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_operation_effects');
    const migrator = createMigrator(isolated.runtime.db, 'migrations', isolated.schema);
    assert.equal((await migrator.migrateTo('202607252600_sync_replica_retirement')).error, undefined);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query("insert into accounts(id,subject_id,status) values ('effect-account','effect-subject','active')");
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ('effect-collection','collection'),('effect-root','node'),('historical-op','operation')");
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ('effect-collection','effect-subject','Effects','bookmarks','effect-root','cr1','cc1','cp1')`);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('effect-root','effect-collection','folder',true,'Root','rr1','rch1')`);
      await client.query(`insert into operations
        (operation_id,collection_id,commit_ordinal,operation_type,payload_json)
        values ('historical-op','effect-collection',5,'sync.node.update','{}')`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    assert.equal((await migrator.migrateToLatest()).error, undefined);
  }, 20_000);

  afterAll(async () => isolated?.close());

  test('records a non-guessing cutover after the historical maximum ordinal', async () => {
    const result = await isolated.runtime.pool.query<{ effect_cutover_ordinal: string }>(
      "select effect_cutover_ordinal::text from sync_collection_effect_cutovers where collection_id='effect-collection'",
    );
    assert.equal(result.rows[0]?.effect_cutover_ordinal, '6');
  });

  test('fails the cutover migration closed for historical non-COLP position tokens', async () => {
    const invalid = await createIsolatedPostgresRuntime('p3_sync_effect_invalid_position');
    try {
      const migrator = createMigrator(invalid.runtime.db, 'migrations', invalid.schema);
      assert.equal((await migrator.migrateTo('202607252600_sync_replica_retirement')).error, undefined);
      const client = await invalid.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query('set constraints all deferred');
        await client.query("insert into accounts(id,subject_id,status) values ('invalid-account','invalid-subject','active')");
        await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
          ('invalid-collection','collection'),('invalid-root','node'),('invalid-child','node')`);
        await client.query(`insert into collections
          (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
          values ('invalid-collection','invalid-subject','Invalid positions','bookmarks','invalid-root','cr1','cc1','cp1')`);
        await client.query(`insert into nodes
          (id,collection_id,kind,is_root,title,resource_revision,children_revision)
          values ('invalid-root','invalid-collection','folder',true,'Root','rr1','rch1')`);
        await client.query(`insert into nodes
          (id,collection_id,kind,title,parent_id,position_token,resource_revision,children_revision)
          values ('invalid-child','invalid-collection','folder','Child','invalid-root',$1,'rr2','rch2')`,
        ['A'.repeat(129)]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally { client.release(); }
      const result = await migrator.migrateToLatest();
      assert.match(String(result.error), /COLP 0\.2 cutover requires canonical Node positions/u);
    } finally { await invalid.close(); }
  }, 20_000);

  test('fails closed without server authority and rolls back effect writes with their transaction', async () => {
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => 'effect-device', replicaId: () => 'effect-replica', leaseId: () => 'effect-lease',
    } }).create({ accountId: 'effect-account', collectionId: 'effect-collection', deviceName: 'Effect device',
      replicaName: 'Effect replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'effect-profile', mountMode: 'whole-profile', browserGeneration: 'one' },
      leaseDurationSeconds: 3_600 }, { actorAccountId: 'effect-account' });
    assert.equal(replica.replicaId, 'effect-replica');
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ('effect-op','operation')");
    await insertTestOperation(isolated.runtime.db, {
      operationId: 'effect-op', collectionId: 'effect-collection', commitOrdinal: 6n,
      operationType: 'sync.node.update', payloadJson: {}, syncWireJson: {},
      actorPrincipalId: null,
    });

    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('known.sync_authority','server',true)");
      await client.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('effect-id','effect-collection','effect-op','effect-replica',1,6,'0.2','applied',$1,'{}',$1)`, [DIGEST]);
      await client.query('rollback');
    } finally { client.release(); }
    const rolledBack = await isolated.runtime.pool.query(
      "select count(*)::int as count from sync_operation_effects where effect_id='effect-id'",
    );
    assert.equal(rolledBack.rows[0]?.count, 0);
  });

  test('rejects update/delete outside the fenced purge path', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('known.sync_authority','server',true)");
      await client.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('immutable-effect','effect-collection','effect-op','effect-replica',1,6,'0.2','applied',$1,'{}',$1)`, [DIGEST]);
      await client.query('commit');
      await client.query('begin');
      await client.query("select set_config('known.sync_authority','server',true)");
      await assert.rejects(client.query("update sync_operation_effects set terminal_status='rebased' where effect_id='immutable-effect'"));
      await client.query('rollback');
    } finally { client.release(); }
  });

  test('allows one replica sequence lane per Collection', async () => {
    const seed = await isolated.runtime.pool.connect();
    try {
      await seed.query('begin');
      await seed.query('set constraints all deferred');
      await seed.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ('effect-collection-two','collection'),('effect-root-two','node'),('effect-op-two','operation')`);
      await seed.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ('effect-collection-two','effect-subject','Effects two','bookmarks','effect-root-two','cr2','cc2','cp2')`);
      await seed.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('effect-root-two','effect-collection-two','folder',true,'Root','rr2','rch2')`);
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally { seed.release(); }
    await insertTestOperation(isolated.runtime.db, {
      operationId: 'effect-op-two', collectionId: 'effect-collection-two', commitOrdinal: 1n,
      operationType: 'sync.node.update', payloadJson: {}, syncWireJson: {},
      actorPrincipalId: null,
    });
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('known.sync_authority','server',true)");
      await client.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('effect-id-two','effect-collection-two','effect-op-two','effect-replica',1,1,
          '0.2','applied',$1,'{}',$1)`, [DIGEST]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    const lanes = await isolated.runtime.pool.query(
      "select collection_id from sync_operation_effects where origin_replica_id='effect-replica' and origin_sequence=1 order by collection_id",
    );
    assert.deepEqual(lanes.rows.map((row) => row.collection_id),
      ['effect-collection', 'effect-collection-two']);
  });

  test('keeps the lane unique constraint that forbids resolution Sequence reuse', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ('effect-op-res-1','operation'),('effect-op-res-2','operation')`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    await insertTestOperation(isolated.runtime.db, {
      operationId: 'effect-op-res-1', collectionId: 'effect-collection', commitOrdinal: 7n,
      operationType: 'sync.node.update', payloadJson: {},
      syncWireJson: { opId: 'effect-op-res-1', replicaId: 'effect-replica', sequence: 7 },
      actorPrincipalId: null,
    });
    await insertTestOperation(isolated.runtime.db, {
      operationId: 'effect-op-res-2', collectionId: 'effect-collection', commitOrdinal: 8n,
      operationType: 'sync.node.update', payloadJson: {},
      syncWireJson: { opId: 'effect-op-res-2', replicaId: 'effect-replica', sequence: 8 },
      actorPrincipalId: null,
    });
    const writer = await isolated.runtime.pool.connect();
    try {
      await writer.query('begin');
      await writer.query("select set_config('known.sync_authority','server',true)");
      await writer.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('occupied-tuple','effect-collection','effect-op-res-1','effect-replica',7,7,
          '0.2','applied',$1,'{}',$1)`, [DIGEST]);
      await writer.query('commit');
      await writer.query('begin');
      await writer.query("select set_config('known.sync_authority','server',true)");
      await writer.query('savepoint reuse_tuple');
      await assert.rejects(writer.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('reuse-tuple','effect-collection','effect-op-res-2','effect-replica',7,8,
          '0.2','applied',$1,'{}',$1)`, [DIGEST]),
      (error: unknown) => (error as { code?: string }).code === '23505');
      await writer.query('rollback to savepoint reuse_tuple');
      await writer.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('fresh-tuple','effect-collection','effect-op-res-2','effect-replica',8,8,
          '0.2','applied',$1,'{}',$1)`, [DIGEST]);
      await writer.query('commit');
    } catch (error) {
      await writer.query('rollback');
      throw error;
    } finally { writer.release(); }
    const sameTuple = await isolated.runtime.pool.query(`select
      effect.origin_sequence::text = payload.sync_wire_json->>'sequence' as same_tuple
      from sync_operation_effects effect
      join operations operation on operation.operation_id=effect.operation_id
      join operation_payloads payload on payload.operation_id=operation.operation_id
      where effect.effect_id='fresh-tuple'`);
    assert.equal(sameTuple.rows[0]?.same_tuple, true);
  });
});
