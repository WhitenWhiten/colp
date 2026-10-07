import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresReplicaStore,
  ReplicaIdAlreadyReservedError,
  ReplicaIntegrityError,
  ReplicaScopeNotFoundError,
} from '../../../src/infrastructure/sync/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import type { ReplicaCreateInput } from '../../../src/modules/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const capabilities = {
  read: true, write: true, events: true, separator: false, alias: false,
  annotations: 'sidecar' as const, maxBatchOperations: 100,
};

function createInput(
  accountId: string,
  collectionId: string,
  overrides: Partial<ReplicaCreateInput> = {},
): ReplicaCreateInput {
  return {
    accountId, collectionId, deviceName: 'Laptop', replicaName: 'Chrome',
    kind: 'browser_extension' as const,
    adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities,
    binding: { browserProfileId: `profile-${accountId}`, mountMode: 'whole-profile' as const,
      browserGeneration: 'installation-1' },
    leaseDurationSeconds: 3_600,
    ...overrides,
  };
}

function createReplica(
  store: ReturnType<typeof createPostgresReplicaStore>,
  input: ReplicaCreateInput,
) {
  return store.create(input, { actorAccountId: input.accountId });
}

describeWithPostgres('P3-05 authoritative Replica PostgreSQL port', () => {
  let isolated: IsolatedPostgresRuntime;
  let counter = 0;
  const ids = {
    deviceId: () => `device-${++counter}`,
    replicaId: () => `replica-${++counter}`,
    leaseId: () => `lease-${++counter}`,
  };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_replica', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedAccountAndCollection('account-a', 'subject-a', 'collection-a', 'root-a');
    await seedAccountAndCollection('account-b', 'subject-b', 'collection-b', 'root-b');
  }, 20_000);

  afterAll(async () => isolated?.close());

  async function seedAccountAndCollection(account: string, subject: string, collection: string, root: string) {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into accounts (id,subject_id) values ($1,$2)', [account, subject]);
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')", [collection, root]);
      await client.query("insert into collections(id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision) values ($1,$2,'C','bookmarks',$3,'r1','c1','p1')", [collection, subject, root]);
      await client.query("insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision) values ($1,$2,'folder',true,'Root','r1','ch1')", [root, collection]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  test('migrates from empty and creates the complete authoritative table set', async () => {
    const rows = await isolated.runtime.pool.query<{ table_name: string }>(`
      select table_name from information_schema.tables where table_schema=current_schema()
        and table_name like 'sync_%' order by table_name`);
    assert.deepEqual(rows.rows.map((row) => row.table_name), [
      'sync_ack_receipts', 'sync_bootstrap_snapshot_conflict_cuts', 'sync_bootstrap_snapshot_conflict_receipts',
      'sync_bootstrap_snapshot_conflicts', 'sync_bootstrap_snapshot_nodes', 'sync_bootstrap_snapshot_pages',
      'sync_bootstrap_snapshots',
      'sync_collection_effect_cutovers', 'sync_collection_purge_state',
      'sync_conflict_resolution_receipts', 'sync_conflicts',
      'sync_delete_group_members', 'sync_devices', 'sync_extension_credentials',
      'sync_history_floors',
      'sync_node_revision_history',
      'sync_node_tombstones',
      'sync_operation_effect_pages', 'sync_operation_effects',
      'sync_pull_cursor_evidence', 'sync_pull_cursor_lineage', 'sync_pull_cursor_recovery_proofs',
      'sync_pull_page_evidence',
      'sync_purged_node_id_watermarks',
      'sync_recovery_ack_receipts', 'sync_recovery_capabilities',
      'sync_replica_generations',
      'sync_replica_id_ledger', 'sync_replica_retirement_receipts', 'sync_replicas', 'sync_resolution_authors', 'sync_restored_tombstones',
      'sync_sequence_lanes',
      'sync_sequence_operation_claims', 'sync_sequence_receipts', 'sync_session_bindings',
      'sync_session_idempotency_receipts', 'sync_session_scopes', 'sync_sessions',
    ]);
  });

  test('upgrades the previous stable migration without rebuilding existing authority', async () => {
    const upgrade = await createIsolatedPostgresRuntime('p3_replica_upgrade');
    try {
      let latest = '';
      while (latest !== '202607251100_profile_annotation_search') {
        const result = await runMigrations(upgrade.runtime.db, 'up');
        latest = result.results[0]?.migrationName ?? '';
        assert.notEqual(latest, '', 'migration chain ended before the previous stable migration');
      }
      assert.equal((await upgrade.runtime.pool.query("select to_regclass('sync_replicas') name")).rows[0]?.name, null);
      const result = await runMigrations(upgrade.runtime.db, 'up');
      assert.deepEqual(result.results.map((item) => item.migrationName), ['202607251200_sync_replica_facts']);
      assert.equal((await upgrade.runtime.pool.query("select to_regclass('sync_replicas')::text name")).rows[0]?.name,
        'sync_replicas');
    } finally {
      await upgrade.close();
    }
  }, 20_000);

  test('supports multiple devices per account and multiple Replicas per device', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    const first = await createReplica(store, createInput('account-a', 'collection-a'));
    const secondDevice = await createReplica(store, createInput('account-a', 'collection-a'));
    const sameDevice = await createReplica(store, createInput('account-a', 'collection-a', { deviceId: first.deviceId }));
    assert.notEqual(first.deviceId, secondDevice.deviceId);
    assert.equal(first.deviceId, sameDevice.deviceId);
    assert.notEqual(first.replicaId, sameDevice.replicaId);
    assert.equal(first.leaseGeneration, '1');
    assert.equal(first.status, 'active');
  });

  test('loads only under the exact account and Collection scope and checks deadline in database time', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    const created = await createReplica(store, createInput('account-a', 'collection-a'));
    assert.equal((await store.load({ accountId: 'account-a', collectionId: 'collection-a',
      replicaId: created.replicaId }))?.leaseValid, true);
    assert.equal(await store.load({ accountId: 'account-b', collectionId: 'collection-a',
      replicaId: created.replicaId }), null);
    assert.equal(await store.load({ accountId: 'account-a', collectionId: 'collection-b',
      replicaId: created.replicaId }), null);
    const boundary = await isolated.runtime.pool.connect();
    try {
      await boundary.query('begin');
      await boundary.query(
        'update sync_replicas set lease_expires_at=current_timestamp where replica_id=$1',
        [created.replicaId],
      );
      const exact = await boundary.query<{ valid: boolean }>(
        'select lease_expires_at > current_timestamp as valid from sync_replicas where replica_id=$1',
        [created.replicaId],
      );
      assert.equal(exact.rows[0]?.valid, false, 'equal database timestamps are outside the lease');
      await boundary.query('commit');
    } catch (error) {
      await boundary.query('rollback');
      throw error;
    } finally {
      boundary.release();
    }
    assert.equal((await store.load({ accountId: 'account-a', collectionId: 'collection-a',
      replicaId: created.replicaId }))?.leaseValid, false, 'deadline is exclusive at database now');
  });

  test('conceals an existing device from a different account', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    const created = await createReplica(store, createInput('account-a', 'collection-a'));
    await assert.rejects(
      createReplica(store, createInput('account-b', 'collection-b', { deviceId: created.deviceId })),
      ReplicaScopeNotFoundError,
    );
  });

  test('conceals an existing Collection from an account without owner or membership authority', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    await assert.rejects(
      createReplica(store, createInput('account-b', 'collection-a')),
      ReplicaScopeNotFoundError,
    );
    await isolated.runtime.pool.query(
      "insert into collection_members(collection_id,subject_id,role) values ('collection-a','subject-b','viewer')",
    );
    const memberReplica = await createReplica(store, createInput('account-b', 'collection-a'));
    assert.equal(memberReplica.accountId, 'account-b');
    assert.equal(memberReplica.collectionId, 'collection-a');
  });

  test('uses database uniqueness as the final concurrent-create and lifetime-reuse defense', async () => {
    const seed = await createPostgresReplicaStore(isolated.runtime.db, { ids })
      .create(createInput('account-a', 'collection-a'), { actorAccountId: 'account-a' });
    const collisionIds = { deviceId: () => 'device-collision', replicaId: () => 'replica-collision',
      leaseId: () => 'lease-collision' };
    const firstStore = createPostgresReplicaStore(isolated.runtime.db, { ids: collisionIds });
    const secondStore = createPostgresReplicaStore(isolated.runtime.db, { ids: collisionIds });
    const settled = await Promise.allSettled([
      firstStore.create(createInput('account-a', 'collection-a', { deviceId: seed.deviceId }), { actorAccountId: 'account-a' }),
      secondStore.create(createInput('account-a', 'collection-a', { deviceId: seed.deviceId }), { actorAccountId: 'account-a' }),
    ]);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected'
      && result.reason instanceof ReplicaIdAlreadyReservedError).length, 1);

    await isolated.runtime.pool.query("update sync_replicas set status='retired', retired_at=current_timestamp where replica_id='replica-collision'");
    for (const [accountId, collectionId, suffix] of [
      ['account-a', 'collection-a', 'same-account'],
      ['account-b', 'collection-b', 'other-account'],
    ] as const) {
      const reused = createPostgresReplicaStore(isolated.runtime.db, { ids: {
        deviceId: () => `device-${suffix}`, replicaId: () => 'replica-collision',
        leaseId: () => `lease-${suffix}`,
      } });
      await assert.rejects(reused.create(createInput(accountId, collectionId), { actorAccountId: accountId }),
        ReplicaIdAlreadyReservedError);
    }
    const lifetime = await isolated.runtime.pool.query(
      "select account_id,collection_id from sync_replica_id_ledger where replica_id='replica-collision'",
    );
    assert.deepEqual(lifetime.rows[0], { account_id: 'account-a', collection_id: 'collection-a' });
  });

  test('enforces non-reusable generation and relational binding constraints', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    const created = await createReplica(store, createInput('account-a', 'collection-a', {
      binding: { browserProfileId: 'profile-mounted', mountMode: 'mounted-folder',
        browserGeneration: 'installation-mounted' },
    }));
    await assert.rejects(isolated.runtime.pool.query(
      'insert into sync_replica_generations(replica_id,lease_generation,lease_id) values ($1,1,$2)',
      [created.replicaId, 'other-lease'],
    ), /unique|duplicate/i);
    await assert.rejects(isolated.runtime.pool.query(
      'update sync_replica_generations set lease_id=$2 where replica_id=$1 and lease_generation=1',
      [created.replicaId, 'rewritten-lease'],
    ), /immutable/i);
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_replica_generations where replica_id=$1 and lease_generation=1',
      [created.replicaId],
    ), /immutable/i);
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_replicas set binding_mode='invalid' where replica_id=$1", [created.replicaId],
    ), /check|violates/i);
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_replicas set capabilities_json=jsonb_set(capabilities_json,'{read}','\"yes\"') where replica_id=$1",
      [created.replicaId],
    ), /check|violates/i);
    await assert.rejects(isolated.runtime.pool.query(
      'update sync_replica_id_ledger set account_id=$2 where replica_id=$1',
      [created.replicaId, 'account-b'],
    ), /immutable/i);
  });

  test('fails closed when JSON wire facts disagree with relational columns', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    const created = await createReplica(store, createInput('account-a', 'collection-a'));
    await isolated.runtime.pool.query(
      "update sync_replicas set wire_json=jsonb_set(wire_json,'{collectionId}','\"collection-b\"') where replica_id=$1",
      [created.replicaId],
    );
    await assert.rejects(store.load({ accountId: 'account-a', collectionId: 'collection-a',
      replicaId: created.replicaId }), ReplicaIntegrityError);
  });

  test('fails closed when a valid relational fact is changed without the wire payload', async () => {
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids });
    const created = await createReplica(store, createInput('account-a', 'collection-a'));
    await isolated.runtime.pool.query(
      "update sync_replicas set adapter_version='2.0.0' where replica_id=$1",
      [created.replicaId],
    );
    await assert.rejects(store.load({ accountId: 'account-a', collectionId: 'collection-a',
      replicaId: created.replicaId }), ReplicaIntegrityError);
  });

  test('rolls device, lifetime, generation, and current facts back together on failure', async () => {
    const rollbackIds = { deviceId: () => 'device-rollback', replicaId: () => 'replica-rollback',
      leaseId: () => 'lease-rollback' };
    const store = createPostgresReplicaStore(isolated.runtime.db, {
      ids: rollbackIds,
      faultInjector: { afterPhase(phase) { if (phase === 'replica') throw new Error('forced rollback'); } },
    });
    await assert.rejects(createReplica(store, createInput('account-a', 'collection-a')), /forced rollback/);
    for (const [table, column, value] of [
      ['resource_id_ledger', 'resource_id', 'device-rollback'],
      ['resource_id_ledger', 'resource_id', 'replica-rollback'],
      ['sync_devices', 'device_id', 'device-rollback'],
      ['sync_replica_id_ledger', 'replica_id', 'replica-rollback'],
      ['sync_replica_generations', 'replica_id', 'replica-rollback'],
      ['sync_replicas', 'replica_id', 'replica-rollback'],
    ] as const) {
      assert.equal((await isolated.runtime.pool.query(`select 1 from ${table} where ${column}=$1`, [value])).rowCount, 0);
    }
  });
});
