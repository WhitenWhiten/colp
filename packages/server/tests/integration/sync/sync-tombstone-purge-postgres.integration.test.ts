import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestAuditEvent, insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresReplicaRetentionWindowPort,
  PostgresSyncTombstonePurgeCoordinator,
  SyncTombstonePurgeFenceLostError,
} from '../../../src/infrastructure/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ACCOUNT = 'purge-account';
const SUBJECT = 'purge-subject';
const COLLECTION = 'purge-collection';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BASE_TIME = new Date('2026-07-26T12:00:00.000Z');
const EFFECT_DIGEST = `sha-256=:${'A'.repeat(43)}=:`;

describeWithPostgres('P3-23 durable Tombstone purge coordinator', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_tombstone_purge', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),('purge-root','node')", [COLLECTION]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'Purge collection','bookmarks','purge-root','cr1','cc1','cp1')`, [COLLECTION, SUBJECT]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('purge-root',$1,'folder',true,'Root','rr1','rch1')`, [COLLECTION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('migrates both an empty database and the P3-22 predecessor', async () => {
    const upgrade = await createIsolatedPostgresRuntime('p3_sync_tombstone_purge_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      assert.equal((await migrator.migrateTo('202607252300_sync_acknowledgements')).error, undefined);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
      const tables = await upgrade.runtime.pool.query<{ table_name: string }>(`select table_name
        from information_schema.tables where table_schema=current_schema()
          and table_name in ('sync_collection_purge_state','sync_purged_node_id_watermarks')
        order by table_name`);
      assert.deepEqual(tables.rows.map((row) => row.table_name),
        ['sync_collection_purge_state', 'sync_purged_node_id_watermarks']);
    } finally { await upgrade.close(); }
  }, 20_000);

  async function seedTombstone(label: string, ordinal: number, purgeAfter: Date, extensions = { secret: `secret-${label}` }) {
    const target = `purge-node-${label}`;
    const operation = `purge-operation-${label}`;
    const revision = `purge-revision-${label}`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'node'),($2,'operation')`, [target, operation]);
    await isolated.runtime.pool.query(`insert into nodes
      (id,collection_id,parent_id,kind,title,url,position_token,resource_revision,children_revision,
       deleted_at,deleted_commit_ordinal)
      values ($1,$2,'purge-root','bookmark',$3,$4,$5,$6,'children-r1',$7,$8)`,
    [target, COLLECTION, `Title ${label}`, `https://example.test/${label}`, label, revision,
      new Date(purgeAfter.getTime() - RETENTION_MS), ordinal]);
    await insertTestOperation(isolated.runtime.db, {
      operationId: operation, collectionId: COLLECTION, commitOrdinal: BigInt(ordinal),
      operationType: 'delete_node', payloadJson: { retained: true }, actorPrincipalId: ACCOUNT,
    });
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'bookmark',$4,$5,$6)`, [COLLECTION, target, revision, { retained: true }, ordinal, operation]);
    await isolated.runtime.pool.query(`insert into sync_node_tombstones
      (collection_id,target_id,root_target_id,operation_id,scope,delete_revision,
       delete_commit_ordinal,delete_cursor,deleted_at,purge_after,affected_count,payload_json)
      values ($1,$2,$2,$3,'single',$4,$5,$6,$7,$8,1,$9)`, [COLLECTION, target, operation,
      revision, ordinal, `sync-delete-${ordinal}`, new Date(purgeAfter.getTime() - RETENTION_MS), purgeAfter,
      { resourceType: 'node', collectionId: COLLECTION, targetId: target, rootTargetId: target,
        operationId: operation, scope: 'single', deleteRevision: revision,
        deleteCommitOrdinal: String(ordinal), affectedCount: '1', kind: 'bookmark', extensions }]);
    await insertTestAuditEvent(isolated.runtime.db, {
      operationId: operation, collectionId: COLLECTION, principalId: ACCOUNT,
      eventType: 'node.deleted', details: { retained: true },
    });
    return { target, operation, revision, ordinal };
  }

  async function setActiveReplica(label: string, checkpoint: null | { ordinal: number; stableId: string }) {
    const replica = `purge-replica-${label}`;
    const device = `purge-device-${label}`;
    const lease = `purge-lease-${label}`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'sync_device'),($2,'sync_replica')`, [device, replica]);
    await isolated.runtime.pool.query(`insert into sync_devices(device_id,account_id,device_name,created_at)
      values ($1,$2,$3,$4)`, [device, ACCOUNT, label, BASE_TIME]);
    await isolated.runtime.pool.query(`insert into sync_replica_id_ledger
      (replica_id,account_id,device_id,collection_id,initial_lease_generation,binding_mode,
       browser_profile_id,browser_generation,reserved_at)
      values ($1,$2,$3,$4,1,'whole-profile',$5,$6,$7)`,
    [replica, ACCOUNT, device, COLLECTION, `profile-${label}`, `browser-gen-${label}`, BASE_TIME]);
    await isolated.runtime.pool.query(`insert into sync_replica_generations(replica_id,lease_generation,lease_id,issued_at)
      values ($1,1,$2,$3)`, [replica, lease, BASE_TIME]);
    const capabilities = { read: true, write: true, events: true, separator: true, alias: false,
      annotations: 'sidecar', maxBatchOperations: 1 };
    const wire = { replicaId: replica, accountId: ACCOUNT, collectionId: COLLECTION, leaseId: lease,
      leaseGeneration: '1', status: 'active', binding: { mountMode: 'whole-profile', browserProfileId: `profile-${label}`,
        browserGeneration: `browser-gen-${label}` }, capabilities,
      checkpoint: { acknowledgedCursor: checkpoint ? `cursor-${label}` : null,
        acknowledgedCommitOrdinal: checkpoint ? String(checkpoint.ordinal) : null } };
    await isolated.runtime.pool.query(`insert into sync_replicas
      (replica_id,account_id,device_id,collection_id,replica_name,kind,lease_generation,lease_id,
       binding_mode,browser_profile_id,browser_generation,adapter_profile,adapter_version,
       capabilities_json,checkpoint_cursor,checkpoint_commit_ordinal,checkpoint_stream_kind,
       checkpoint_stable_id,status,created_at,last_seen_at,lease_expires_at,wire_json)
      values ($1,$2,$3,$4,$5,'browser_extension',1,$6,'whole-profile',$7,$8,'chromium','1',
       $9,$10,$11,$12,$13,'active',$14,$14,$15,$16)`, [replica, ACCOUNT, device, COLLECTION, label, lease,
      `profile-${label}`, `browser-gen-${label}`, capabilities,
      checkpoint ? `cursor-${label}` : null, checkpoint?.ordinal ?? null,
      checkpoint ? 0 : null, checkpoint?.stableId ?? null,
      BASE_TIME, new Date(BASE_TIME.getTime() + 86_400_000), wire]);
    return replica;
  }

  function coordinator(worker = randomUUID(), fault?: string) {
    return new PostgresSyncTombstonePurgeCoordinator(isolated.runtime.db, {
      workerId: worker, batchSize: 2, leaseDurationMs: 30_000,
      faultInjector: { async afterPhase(phase) { if (phase === fault) throw new Error(`fault:${phase}`); } },
    });
  }

  test('does not purge before retention or while any active checkpoint is absent or behind; equal to the delete tuple passes', async () => {
    const before = await seedTombstone('retention-before', 199, new Date(BASE_TIME.getTime() + 1));
    await setActiveReplica('missing-checkpoint', null);
    assert.equal((await coordinator().runBatch({ now: BASE_TIME })).purgedCount, 0);
    await isolated.runtime.pool.query("update sync_replicas set status='expired', wire_json=jsonb_set(wire_json,'{status}','\"expired\"') where replica_id=$1", ['purge-replica-missing-checkpoint']);
    assert.equal((await coordinator().runBatch({ now: BASE_TIME })).purgedCount, 0);

    // The delete is the collection's last event: an active replica can at most
    // Ack to the delete tuple itself, so equality must be sufficient (FIX-M-010).
    const equal = await seedTombstone('ack-equal', 102, BASE_TIME);
    await setActiveReplica('equal', { ordinal: 102, stableId: equal.operation });
    const behindReplica = await setActiveReplica('behind', { ordinal: 101, stableId: 'older-operation' });
    assert.equal((await coordinator().runBatch({ now: BASE_TIME })).purgedCount, 0);
    const effectClient = await isolated.runtime.pool.connect();
    try {
      await effectClient.query('begin');
      await effectClient.query("select set_config('known.sync_authority','server',true)");
      await effectClient.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ($1,$2,$3,'purge-replica-equal',1,102,'0.2','applied',$4,'{}',$4)`,
      ['purge-effect-ack-equal', COLLECTION, equal.operation, EFFECT_DIGEST]);
      await effectClient.query(`insert into sync_operation_effect_pages
        (effect_id,page_number,page_count,member_count,page_json,page_digest,previous_page_digest)
        values ($1,1,1,1,$2,$3,NULL)`,
      ['purge-effect-ack-equal', { members: [] }, EFFECT_DIGEST]);
      await effectClient.query('commit');
    } finally { effectClient.release(); }
    await isolated.runtime.pool.query("update sync_replicas set status='expired', wire_json=jsonb_set(wire_json,'{status}','\"expired\"') where replica_id=$1", [behindReplica]);
    const equalResult = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(equalResult.purgedCount, 1);
    assert.equal(equalResult.purgedThrough.commitOrdinal, '102');
    assert.equal(equalResult.purgedThrough.stableId, equal.operation);
    const compacted = await isolated.runtime.pool.query<{ payload_json: { extensions: object }, payload_purged_at: Date | null }>(
      'select payload_json,payload_purged_at from sync_node_tombstones where collection_id=$1 and target_id=$2', [COLLECTION, equal.target]);
    assert.equal(compacted.rowCount, 1);
    assert.equal(compacted.rows[0]?.payload_purged_at instanceof Date, true);
    assert.deepEqual(compacted.rows[0]?.payload_json.extensions, {});
    const effects = await isolated.runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from sync_operation_effects where collection_id=$1 and commit_ordinal <= 102', [COLLECTION]);
    assert.equal(effects.rows[0]?.count, '0');
    const pages = await isolated.runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from sync_operation_effect_pages where effect_id=$1', ['purge-effect-ack-equal']);
    assert.equal(pages.rows[0]?.count, '0');

    await isolated.runtime.pool.query(`update sync_replicas set checkpoint_commit_ordinal=500,
      checkpoint_stable_id='later-operation' where status='active'`);
    const result = await coordinator().runBatch({ now: new Date(BASE_TIME.getTime() + 1) });
    assert.equal(result.purgedCount, 1);
    assert.equal(result.purgedThrough.commitOrdinal, '199');
    assert.equal(before.target.length > 0, true);
  });

  test('zero active replicas purge a bounded batch and retain authority/history', async () => {
    await isolated.runtime.pool.query("update sync_replicas set status='expired', wire_json=jsonb_set(wire_json,'{status}','\"expired\"') where status='active'");
    const recovery = await setActiveReplica('recovery-nonblocking', null);
    await isolated.runtime.pool.query("update sync_replicas set status='recovery_required', wire_json=jsonb_set(wire_json,'{status}','\"recovery_required\"') where replica_id=$1", [recovery]);
    const retired = await setActiveReplica('retired-nonblocking', null);
    await isolated.runtime.pool.query(`update sync_replicas set status='retired',retired_at=$2,
      wire_json=jsonb_set(wire_json,'{status}','"retired"') where replica_id=$1`, [retired, BASE_TIME]);
    const rows = await Promise.all([201, 202, 203].map((ordinal) => seedTombstone(`batch-${ordinal}`, ordinal, BASE_TIME)));
    const first = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(first.purgedCount, 1);
    assert.equal(first.hasMore, true);
    const second = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(second.purgedCount, 1);
    const third = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(third.purgedCount, 1);
    const target = rows[0]!;
    const tombstone = await isolated.runtime.pool.query<{ payload_json: { extensions: object } }>(
      'select payload_json from sync_node_tombstones where collection_id=$1 and target_id=$2', [COLLECTION, target.target]);
    assert.deepEqual(tombstone.rows[0]?.payload_json.extensions, {});
    for (const [table, predicate, value] of [
      ['resource_id_ledger', 'resource_id', target.target], ['operations', 'operation_id', target.operation],
      ['audit_events', 'operation_id', target.operation], ['sync_node_revision_history', 'resource_id', target.target],
    ] as const) {
      const retained = await isolated.runtime.pool.query<{ count: string }>(`select count(*)::text as count from ${table} where ${predicate}=$1`, [value]);
      assert.notEqual(retained.rows[0]?.count, '0', table);
    }
    const watermark = await isolated.runtime.pool.query('select * from sync_purged_node_id_watermarks where collection_id=$1 and target_id=$2', [COLLECTION, target.target]);
    assert.equal(watermark.rowCount, 1);

    const retention = createPostgresReplicaRetentionWindowPort('/colp/v0.1/sync/snapshot');
    const window = await isolated.runtime.db.transaction().execute((transaction) =>
      retention.load(transaction, COLLECTION));
    assert.equal(window.purgedThroughTuple?.commitOrdinal, '203');
    assert.equal(window.purgedThroughTuple?.streamKind, 0);
    assert.equal(window.purgedThroughTuple?.stableId, rows[2]!.operation);

    await isolated.runtime.pool.query('alter table sync_node_tombstones disable trigger sync_node_tombstones_immutable');
    await isolated.runtime.pool.query('delete from sync_node_tombstones where collection_id=$1 and target_id=$2',
      [COLLECTION, target.target]);
    await assert.rejects(isolated.runtime.pool.query(
      'update nodes set title=$3 where collection_id=$1 and id=$2', [COLLECTION, target.target, 'resurrected']),
    /deleted Node identity/u);
    await isolated.runtime.pool.query('alter table sync_node_tombstones enable trigger sync_node_tombstones_immutable');
  });

  test('all write-point faults roll back payload, watermarks, and boundary together', async () => {
    const phases = ['facts_loaded', 'identity_watermarks', 'payload_compacted', 'purge_state_advanced', 'before_commit'];
    for (const [index, phase] of phases.entries()) {
      const item = await seedTombstone(`fault-${phase}`, 300 + index, BASE_TIME);
      await assert.rejects(coordinator(randomUUID(), phase).runBatch({ now: BASE_TIME }), new RegExp(`fault:${phase}`));
      const state = await isolated.runtime.pool.query<{ payload_json: { extensions: object } }>(
        'select payload_json from sync_node_tombstones where collection_id=$1 and target_id=$2', [COLLECTION, item.target]);
      assert.notDeepEqual(state.rows[0]?.payload_json.extensions, {});
      const watermark = await isolated.runtime.pool.query('select 1 from sync_purged_node_id_watermarks where collection_id=$1 and target_id=$2', [COLLECTION, item.target]);
      assert.equal(watermark.rowCount, 0);
      assert.equal((await coordinator().runBatch({
        now: new Date(BASE_TIME.getTime() + 30_001),
      })).purgedCount, 1);
    }
  });

  test('two workers cannot commit through the same lease and expired lease retries safely', async () => {
    await seedTombstone('concurrent', 401, BASE_TIME);
    const first = coordinator('worker-a');
    const second = coordinator('worker-b');
    const [a, b] = await Promise.all([first.runBatch({ now: BASE_TIME }), second.runBatch({ now: BASE_TIME })]);
    assert.equal(a.purgedCount + b.purgedCount, 1);
    await seedTombstone('fence-lost', 402, BASE_TIME);
    const leased = await first.claimCollection({ now: BASE_TIME });
    assert.ok(leased);
    await isolated.runtime.pool.query(`update sync_collection_purge_state set lease_token='replacement',
      lease_generation=lease_generation+1, lease_expires_at=$2 where collection_id=$1`,
    [COLLECTION, new Date(BASE_TIME.getTime() + 60_000)]);
    await assert.rejects(first.purgeClaim(leased!, { now: BASE_TIME }), SyncTombstonePurgeFenceLostError);
  });

  test('eligibility query uses the bounded candidate index without a sequential scan', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan=off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(`explain (costs off)
        select collection_id,target_id from sync_node_tombstones
        where collection_id=$1 and purge_after <= $2 and payload_purged_at is null
        order by delete_commit_ordinal,operation_id,target_id limit 2`, [COLLECTION, BASE_TIME]);
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(text, /sync_node_tombstones_purge_candidate_idx/u);
      assert.doesNotMatch(text, /Seq Scan/u);
      await client.query('rollback');
    } finally { client.release(); }
  });
});
