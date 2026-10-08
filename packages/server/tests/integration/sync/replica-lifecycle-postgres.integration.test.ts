import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaLifecycleService,
  createPostgresReplicaStore,
  type PostgresReplicaLifecycleOptions,
  type ReplicaLifecycleFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import type {
  ReplicaCreateInput,
  ReplicaLifecycleScope,
  ReplicaRenewalOutcome,
} from '../../../src/modules/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const capabilities = {
  read: true, write: true, events: true, separator: false, alias: false,
  annotations: 'sidecar' as const, maxBatchOperations: 1,
};

function createInput(accountId: string, collectionId: string): ReplicaCreateInput {
  return {
    accountId, collectionId, deviceName: 'Laptop', replicaName: 'Chrome',
    kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities, binding: { browserProfileId: `profile-${accountId}`, mountMode: 'whole-profile',
      browserGeneration: 'installation-1' }, leaseDurationSeconds: 3_600,
  };
}

describeWithPostgres('P3-06 authoritative Replica lifecycle', () => {
  let isolated: IsolatedPostgresRuntime;
  let idCounter = 0;
  let leaseCounter = 0;
  const ids = {
    deviceId: () => `device-p306-${++idCounter}`,
    replicaId: () => `replica-p306-${++idCounter}`,
    leaseId: () => `lease-create-p306-${++idCounter}`,
  };

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_replica_lifecycle', { maxConnections: 14 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedAccountAndCollection('account-a', 'subject-a', 'collection-a', 'root-a');
  }, 20_000);

  afterAll(async () => isolated?.close());

  async function seedAccountAndCollection(account: string, subject: string, collection: string, root: string) {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into accounts (id,subject_id) values ($1,$2)', [account, subject]);
      await client.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [collection, root],
      );
      await client.query(
        "insert into collections(id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision) values ($1,$2,'C','bookmarks',$3,'r1','c1','p1')",
        [collection, subject, root],
      );
      await client.query(
        "insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision) values ($1,$2,'folder',true,'Root','r1','ch1')",
        [root, collection],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function createReplica() {
    return createPostgresReplicaStore(isolated.runtime.db, { ids })
      .create(createInput('account-a', 'collection-a'), { actorAccountId: 'account-a' });
  }

  function scope(replicaId: string, generation = '1', revision = '0'): ReplicaLifecycleScope {
    return { accountId: 'account-a', collectionId: 'collection-a', replicaId,
      expectedLeaseGeneration: generation, expectedLifecycleRevision: revision };
  }

  function service(overrides: PostgresReplicaLifecycleOptions = {}) {
    return createPostgresReplicaLifecycleService(isolated.runtime.db, {
      leaseId: () => `lease-lifecycle-p306-${++leaseCounter}`,
      retentionWindow: {
        async load(_transaction, collectionId) {
          return { collectionId, earliestPull: { cursor: 'earliest', commitOrdinal: '4' },
            purgedThrough: { cursor: 'purged', commitOrdinal: '3' }, snapshotUrl: '/snapshots/current' };
        },
      },
      ...overrides,
    });
  }

  async function row(replicaId: string) {
    const result = await isolated.runtime.pool.query<{
      status: string; lease_generation: string; lease_id: string; lifecycle_revision: string;
      last_seen_at: Date; lease_expires_at: Date; retired_at: Date | null; wire_json: Record<string, unknown>;
    }>('select status,lease_generation,lease_id,lifecycle_revision,last_seen_at,lease_expires_at,retired_at,wire_json from sync_replicas where replica_id=$1', [replicaId]);
    assert.equal(result.rowCount, 1);
    return result.rows[0]!;
  }

  async function auditCount(replicaId: string) {
    const result = await isolated.runtime.pool.query<{ count: string }>(
      "select count(*)::text count from audit_events event join audit_event_payloads payload on payload.event_id=event.id where payload.details_json->>'replicaId'=$1",
      [replicaId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function lifecycleAudits(replicaId: string) {
    const result = await isolated.runtime.pool.query<{
      event_type: string; details_json: Record<string, unknown>;
    }>(`select event.event_type,payload.details_json from audit_events event
      join audit_event_payloads payload on payload.event_id=event.id
      where payload.details_json->>'replicaId'=$1 order by event.id`, [replicaId]);
    return result.rows;
  }

  async function assertSingleMinimalAudit(
    replicaId: string,
    eventType: string,
    from: string,
    to: string,
  ): Promise<void> {
    const audits = await lifecycleAudits(replicaId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.event_type, eventType);
    assert.deepEqual(Object.keys(audits[0]?.details_json ?? {}).sort(), [
      'collectionId', 'from', 'leaseGeneration', 'lifecycleRevision',
      'previousLeaseGeneration', 'replicaId', 'to',
    ]);
    assert.equal(audits[0]?.details_json.from, from);
    assert.equal(audits[0]?.details_json.to, to);
    assert.doesNotMatch(JSON.stringify(audits[0]),
      /account-a|device-p306|lease-(?:create|lifecycle)|chromium-bookmarks|profile-account/i);
  }

  async function waitForReplicaRowLockWait(): Promise<void> {
    // The collection replica gate is taken before the Replica row, so the
    // competing command waits on pg_advisory_xact_lock and never reaches
    // the sync_replicas statement while the first transaction is paused.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await isolated.runtime.pool.query<{ waiting: boolean }>(`
        select exists (
          select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()
            and (query ilike '%sync_replicas%' or query ilike '%pg_advisory_xact_lock%')
        ) waiting`);
      if (waiting.rows[0]?.waiting) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('the competing lifecycle command never waited on the collection replica gate');
  }

  function transactionGate() {
    let enter!: () => void;
    let release!: () => void;
    return {
      entered: new Promise<void>((resolve) => { enter = resolve; }),
      released: new Promise<void>((resolve) => { release = resolve; }),
      enter,
      release,
    };
  }

  test('empty migration installs the lifecycle fence and terminal trigger', async () => {
    const column = await isolated.runtime.pool.query(`select 1 from information_schema.columns
      where table_schema=current_schema() and table_name='sync_replicas'
        and column_name='lifecycle_revision' and column_default='0'`);
    assert.equal(column.rowCount, 1);
    const trigger = await isolated.runtime.pool.query(`select 1 from pg_trigger
      where tgrelid='sync_replicas'::regclass and tgname='sync_replicas_terminal_retirement'
        and not tgisinternal`);
    assert.equal(trigger.rowCount, 1);
  });

  test('upgrades exactly from P3-05 and preserves existing Replica rows', async () => {
    const upgrade = await createIsolatedPostgresRuntime('p3_replica_lifecycle_upgrade');
    try {
      let latest = '';
      while (latest !== '202607251200_sync_replica_facts') {
        const result = await runMigrations(upgrade.runtime.db, 'up');
        latest = result.results[0]?.migrationName ?? '';
        assert.notEqual(latest, '');
      }
      assert.equal((await upgrade.runtime.pool.query(
        "select 1 from information_schema.columns where table_schema=current_schema() and table_name='sync_replicas' and column_name='lifecycle_revision'",
      )).rowCount, 0);
      const client = await upgrade.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query("insert into accounts(id,subject_id) values ('upgrade-account','upgrade-subject')");
        await client.query("insert into resource_id_ledger(resource_id,resource_type) values ('upgrade-collection','collection'),('upgrade-root','node'),('upgrade-device','sync_device'),('upgrade-replica','sync_replica')");
        await client.query("insert into collections(id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision) values ('upgrade-collection','upgrade-subject','C','bookmarks','upgrade-root','r1','c1','p1')");
        await client.query("insert into nodes(id,collection_id,kind,is_root,title,resource_revision,children_revision) values ('upgrade-root','upgrade-collection','folder',true,'Root','r1','ch1')");
        await client.query("insert into sync_devices(device_id,account_id,device_name) values ('upgrade-device','upgrade-account','Laptop')");
        await client.query(`insert into sync_replica_id_ledger(replica_id,account_id,device_id,collection_id,
          initial_lease_generation,binding_mode,browser_profile_id,browser_generation)
          values ('upgrade-replica','upgrade-account','upgrade-device','upgrade-collection',1,
            'whole-profile','upgrade-profile','upgrade-installation')`);
        await client.query("insert into sync_replica_generations(replica_id,lease_generation,lease_id) values ('upgrade-replica',1,'upgrade-lease')");
        const upgradeWire = {
          replicaId: 'upgrade-replica', deviceId: 'upgrade-device', accountId: 'upgrade-account',
          collectionId: 'upgrade-collection', replicaName: 'Chrome', kind: 'browser_extension',
          leaseId: 'upgrade-lease', leaseGeneration: '1',
          adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities,
          binding: { browserProfileId: 'upgrade-profile', mountMode: 'whole-profile',
            browserGeneration: 'upgrade-installation' },
          checkpoint: { acknowledgedCursor: null, acknowledgedCommitOrdinal: null }, status: 'active',
        };
        await client.query(`insert into sync_replicas(replica_id,account_id,device_id,collection_id,
          replica_name,kind,lease_generation,lease_id,binding_mode,browser_profile_id,browser_generation,
          adapter_profile,adapter_version,capabilities_json,status,lease_expires_at,wire_json)
          values ('upgrade-replica','upgrade-account','upgrade-device','upgrade-collection','Chrome',
            'browser_extension',1,'upgrade-lease','whole-profile','upgrade-profile','upgrade-installation',
            'chromium-bookmarks-v1','1.0.0',$1,'active',current_timestamp + interval '1 hour',$2)`,
        [capabilities, upgradeWire]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      const result = await runMigrations(upgrade.runtime.db, 'up');
      assert.deepEqual(result.results.map((item) => item.migrationName), ['202607251300_sync_replica_lifecycle']);
      assert.equal((await upgrade.runtime.pool.query(
        "select 1 from information_schema.columns where table_schema=current_schema() and table_name='sync_replicas' and column_name='lifecycle_revision'",
      )).rowCount, 1);
      const preserved = await upgrade.runtime.pool.query<{ lifecycle_revision: string; status: string }>(
        "select lifecycle_revision,status from sync_replicas where replica_id='upgrade-replica'",
      );
      assert.deepEqual(preserved.rows, [{ lifecycle_revision: '0', status: 'active' }]);
      const down = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(down.results.map((item) => item.migrationName),
        ['202607251300_sync_replica_lifecycle']);
      assert.equal((await upgrade.runtime.pool.query(
        "select 1 from information_schema.columns where table_schema=current_schema() and table_name='sync_replicas' and column_name='lifecycle_revision'",
      )).rowCount, 0);
      assert.equal((await upgrade.runtime.pool.query(`select 1 from pg_trigger
        where tgrelid='sync_replicas'::regclass and tgname='sync_replicas_terminal_retirement'
          and not tgisinternal`)).rowCount, 0);
      assert.equal((await upgrade.runtime.pool.query(
        "select 1 from sync_replicas where replica_id='upgrade-replica' and status='active'",
      )).rowCount, 1);
    } finally { await upgrade.close(); }
  }, 20_000);

  test('renews only an active authorized successful command and uses database time', async () => {
    const replica = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set last_seen_at=current_timestamp - interval '1 minute' where replica_id=$1",
      [replica.replicaId],
    );
    const before = await row(replica.replicaId);
    const result = await service().renew({ scope: scope(replica.replicaId),
      outcome: 'authorized_success', leaseDurationSeconds: 7_200 });
    assert.equal(result.state, 'committed');
    const after = await row(replica.replicaId);
    assert.equal(after.status, 'active');
    assert.equal(after.lease_generation, '1');
    assert.equal(after.lifecycle_revision, '1');
    assert.ok(after.last_seen_at > before.last_seen_at);
    assert.ok(after.lease_expires_at > before.lease_expires_at);
    assert.equal((after.wire_json as { status?: unknown }).status, 'active');
    await assertSingleMinimalAudit(replica.replicaId, 'sync.replica.lease_renewed', 'active', 'active');
    assert.equal((await createPostgresReplicaStore(isolated.runtime.db, { ids }).load({
      accountId: 'account-a', collectionId: 'collection-a', replicaId: replica.replicaId,
    }))?.lifecycleRevision, '1');
  });

  test('unauthorized, malformed, gap, stale, failed, and policy-denied requests never touch facts or Audit', async () => {
    const outcomes: ReplicaRenewalOutcome[] = [
      'unauthorized', 'schema_rejected', 'request_failed', 'sequence_gap', 'stale', 'policy_rejected',
    ];
    for (const outcome of outcomes) {
      const replica = await createReplica();
      const before = await row(replica.replicaId);
      const result = await service().renew({ scope: scope(replica.replicaId), outcome,
        leaseDurationSeconds: 7_200 });
      assert.equal(result.state, 'denied');
      const after = await row(replica.replicaId);
      assert.deepEqual(after, before);
      assert.equal(await auditCount(replica.replicaId), 0);
    }
    const replica = await createReplica();
    const before = await row(replica.replicaId);
    await assert.rejects(service().renew({ scope: scope(replica.replicaId),
      outcome: 'authorized_success', leaseDurationSeconds: 0 }), /duration/i);
    assert.deepEqual(await row(replica.replicaId), before);
  });

  test('conceals cross-account and cross-Collection lifecycle lookup without side effects', async () => {
    const replica = await createReplica();
    const before = await row(replica.replicaId);
    for (const hiddenScope of [
      { ...scope(replica.replicaId), accountId: 'other-account' },
      { ...scope(replica.replicaId), collectionId: 'other-collection' },
    ]) {
      const result = await service().renew({ scope: hiddenScope, outcome: 'authorized_success',
        leaseDurationSeconds: 7_200 });
      assert.equal(result.state, 'denied');
      if (result.state === 'denied') assert.equal(result.code, 'replica_not_found');
    }
    assert.deepEqual(await row(replica.replicaId), before);
    assert.equal(await auditCount(replica.replicaId), 0);
  });

  test('deadline before remains active while equal and after are expired by database authority', async () => {
    const beforeDeadline = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set lease_expires_at=current_timestamp + interval '1 day', wire_json=jsonb_set(wire_json,'{status}','\"active\"') where replica_id=$1",
      [beforeDeadline.replicaId],
    );
    assert.equal((await service().expireDue({ limit: 10 })).expiredReplicaIds.includes(beforeDeadline.replicaId), false);

    const atDeadline = await createReplica();
    const boundary = await isolated.runtime.pool.connect();
    try {
      await boundary.query('begin');
      const exact = await boundary.query<{ equal: boolean }>(
        'update sync_replicas set lease_expires_at=current_timestamp where replica_id=$1 returning lease_expires_at=current_timestamp as equal',
        [atDeadline.replicaId],
      );
      assert.equal(exact.rows[0]?.equal, true, 'deadline equality is established by one database transaction clock');
      await boundary.query('commit');
    } catch (error) {
      await boundary.query('rollback');
      throw error;
    } finally { boundary.release(); }
    const expiredAt = await service().expireDue({ limit: 10 });
    assert.ok(expiredAt.expiredReplicaIds.includes(atDeadline.replicaId));
    assert.equal((await row(atDeadline.replicaId)).status, 'expired');
    await assertSingleMinimalAudit(atDeadline.replicaId,
      'sync.replica.lifecycle.active_to_expired', 'active', 'expired');

    const afterDeadline = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set last_seen_at=current_timestamp - interval '2 seconds', lease_expires_at=current_timestamp - interval '1 second' where replica_id=$1",
      [afterDeadline.replicaId],
    );
    assert.ok((await service().expireDue({ limit: 10 })).expiredReplicaIds.includes(afterDeadline.replicaId));
  });

  test('expiration batches are concurrent-safe and idempotent', async () => {
    const replicas = await Promise.all([createReplica(), createReplica(), createReplica()]);
    await isolated.runtime.pool.query(
      "update sync_replicas set lease_expires_at=current_timestamp where replica_id=any($1::text[])",
      [replicas.map((item) => item.replicaId)],
    );
    const [left, right] = await Promise.all([service().expireDue({ limit: 10 }), service().expireDue({ limit: 10 })]);
    const claimed = [...left.expiredReplicaIds, ...right.expiredReplicaIds];
    assert.equal(new Set(claimed).size, replicas.length);
    assert.equal(claimed.length, replicas.length);
    assert.deepEqual((await service().expireDue({ limit: 10 })).expiredReplicaIds, []);
    for (const replica of replicas) assert.equal(await auditCount(replica.replicaId), 1);
  });

  test('expired resume with retained history issues one fresh monotonic generation', async () => {
    const replica = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set status='expired', checkpoint_cursor='cursor-4', checkpoint_commit_ordinal=4, checkpoint_stream_kind=0, checkpoint_stable_id='legacy-operation-4', wire_json=jsonb_set(jsonb_set(jsonb_set(wire_json,'{status}','\"expired\"'),'{checkpoint,acknowledgedCursor}','\"cursor-4\"'),'{checkpoint,acknowledgedCommitOrdinal}','\"4\"') where replica_id=$1",
      [replica.replicaId],
    );
    const result = await service().resume({ scope: scope(replica.replicaId),
      outcome: 'authorized_success', leaseDurationSeconds: 3_600 });
    assert.equal(result.state, 'committed');
    const after = await row(replica.replicaId);
    assert.equal(after.status, 'active');
    assert.equal(after.lease_generation, '2');
    assert.equal(after.lifecycle_revision, '1');
    assert.notEqual(after.lease_id, replica.leaseId);
    const generations = await isolated.runtime.pool.query(
      'select lease_generation,lease_id from sync_replica_generations where replica_id=$1 order by lease_generation',
      [replica.replicaId],
    );
    assert.deepEqual(generations.rows.map((item) => String(item.lease_generation)), ['1', '2']);
    await assertSingleMinimalAudit(replica.replicaId,
      'sync.replica.lifecycle.expired_to_active', 'expired', 'active');
    assert.equal((await createPostgresReplicaStore(isolated.runtime.db, { ids }).load({
      accountId: 'account-a', collectionId: 'collection-a', replicaId: replica.replicaId,
    }))?.leaseGeneration, '2');
  });

  test('two old-generation resume commands have one winner and one stable stale rejection', async () => {
    const replica = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set status='expired', checkpoint_cursor='cursor-4', checkpoint_commit_ordinal=4, checkpoint_stream_kind=0, checkpoint_stable_id='legacy-operation-4', wire_json=jsonb_set(jsonb_set(jsonb_set(wire_json,'{status}','\"expired\"'),'{checkpoint,acknowledgedCursor}','\"cursor-4\"'),'{checkpoint,acknowledgedCommitOrdinal}','\"4\"') where replica_id=$1",
      [replica.replicaId],
    );
    const results = await Promise.all([
      service().resume({ scope: scope(replica.replicaId), outcome: 'authorized_success',
        leaseDurationSeconds: 3_600 }),
      service().resume({ scope: scope(replica.replicaId), outcome: 'authorized_success',
        leaseDurationSeconds: 3_600 }),
    ]);
    assert.equal(results.filter((item) => item.state === 'committed').length, 1);
    assert.equal(results.filter((item) => item.state === 'denied'
      && item.code === 'stale_replica').length, 1);
    assert.equal((await row(replica.replicaId)).lease_generation, '2');
    assert.equal((await isolated.runtime.pool.query(
      'select 1 from sync_replica_generations where replica_id=$1', [replica.replicaId],
    )).rowCount, 2);
  });

  test('expired resume with lost history becomes recovery_required without minting a generation', async () => {
    const replica = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set status='expired', checkpoint_cursor='cursor-2', checkpoint_commit_ordinal=2, checkpoint_stream_kind=0, checkpoint_stable_id='legacy-operation-2', wire_json=jsonb_set(jsonb_set(jsonb_set(wire_json,'{status}','\"expired\"'),'{checkpoint,acknowledgedCursor}','\"cursor-2\"'),'{checkpoint,acknowledgedCommitOrdinal}','\"2\"') where replica_id=$1",
      [replica.replicaId],
    );
    const result = await service().resume({ scope: scope(replica.replicaId),
      outcome: 'authorized_success', leaseDurationSeconds: 3_600 });
    assert.deepEqual(result.state === 'denied' ? { state: result.state, code: result.code,
      snapshotUrl: result.snapshotUrl } : result,
    { state: 'denied', code: 'stale_replica', snapshotUrl: '/snapshots/current' });
    const after = await row(replica.replicaId);
    assert.equal(after.status, 'recovery_required');
    assert.equal(after.lease_generation, '1');
    assert.equal((await isolated.runtime.pool.query(
      'select 1 from sync_replica_generations where replica_id=$1', [replica.replicaId],
    )).rowCount, 1);
    await assertSingleMinimalAudit(replica.replicaId,
      'sync.replica.lifecycle.expired_to_recovery_required', 'expired', 'recovery_required');
    assert.equal((await createPostgresReplicaStore(isolated.runtime.db, { ids }).load({
      accountId: 'account-a', collectionId: 'collection-a', replicaId: replica.replicaId,
    }))?.status, 'recovery_required');
  });

  test('rejects every forbidden edge and old generation or lifecycle revision without side effects', async () => {
    const replica = await createReplica();
    const initial = await row(replica.replicaId);
    const invalidResume = await service().resume({ scope: scope(replica.replicaId),
      outcome: 'authorized_success', leaseDurationSeconds: 3_600 });
    assert.equal(invalidResume.state, 'denied');
    if (invalidResume.state === 'denied') assert.equal(invalidResume.code, 'invalid_replica_state');
    assert.deepEqual(await row(replica.replicaId), initial);
    assert.equal(await auditCount(replica.replicaId), 0);
    const staleGeneration = await service().renew({ scope: scope(replica.replicaId, '2'),
      outcome: 'authorized_success', leaseDurationSeconds: 7_200 });
    assert.equal(staleGeneration.state, 'denied');
    if (staleGeneration.state === 'denied') assert.equal(staleGeneration.code, 'stale_replica');
    assert.deepEqual(await row(replica.replicaId), initial);
    assert.equal(await auditCount(replica.replicaId), 0);
    const renewed = await service().renew({ scope: scope(replica.replicaId),
      outcome: 'authorized_success', leaseDurationSeconds: 7_200 });
    assert.equal(renewed.state, 'committed');
    const afterRenew = await row(replica.replicaId);
    const staleRevision = await service().retire({ scope: scope(replica.replicaId),
      outcome: 'authorized_success' });
    assert.equal(staleRevision.state, 'denied');
    if (staleRevision.state === 'denied') assert.equal(staleRevision.code, 'stale_replica');
    assert.deepEqual(await row(replica.replicaId), afterRenew);
    assert.equal(await auditCount(replica.replicaId), 1);
  });

  test('retire is terminal in application, repository, and database trigger layers', async () => {
    const replica = await createReplica();
    const retired = await service().retire({ scope: scope(replica.replicaId), outcome: 'authorized_success' });
    assert.equal(retired.state, 'committed');
    const stored = await row(replica.replicaId);
    assert.equal(stored.status, 'retired');
    assert.ok(stored.retired_at instanceof Date);
    await assertSingleMinimalAudit(replica.replicaId,
      'sync.replica.lifecycle.active_to_retired', 'active', 'retired');
    const again = await service().resume({ scope: scope(replica.replicaId, '1', '1'),
      outcome: 'authorized_success', leaseDurationSeconds: 3_600 });
    assert.equal(again.state, 'denied');
    if (again.state === 'denied') assert.equal(again.code, 'replica_retired');
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_replicas set status='active',retired_at=null where replica_id=$1", [replica.replicaId],
    ), /terminal|retired/i);
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_replicas set retired_at=retired_at + interval '1 second' where replica_id=$1",
      [replica.replicaId],
    ), /terminal|retired/i);
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_replicas set last_seen_at=last_seen_at + interval '1 millisecond' where replica_id=$1",
      [replica.replicaId],
    ), /terminal|retired/i);
    await assert.rejects(isolated.runtime.pool.query(
      "update sync_replicas set wire_json=jsonb_set(wire_json,'{status}','\"active\"') where replica_id=$1",
      [replica.replicaId],
    ), /terminal|retired/i);
    const loaded = await createPostgresReplicaStore(isolated.runtime.db, { ids }).load({
      accountId: 'account-a', collectionId: 'collection-a', replicaId: replica.replicaId,
    });
    assert.equal(loaded?.status, 'retired', 'P3-05 dual-read remains valid after retirement');
  });

  test('covers allowed and forbidden edges from expired and recovery_required states', async () => {
    const expiredToRetired = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set status='expired',wire_json=jsonb_set(wire_json,'{status}','\"expired\"') where replica_id=$1",
      [expiredToRetired.replicaId],
    );
    assert.equal((await service().retire({ scope: scope(expiredToRetired.replicaId),
      outcome: 'authorized_success' })).state, 'committed');

    const expiredToRecovery = await createReplica();
    await isolated.runtime.pool.query(
      "update sync_replicas set status='expired',wire_json=jsonb_set(wire_json,'{status}','\"expired\"') where replica_id=$1",
      [expiredToRecovery.replicaId],
    );
    assert.equal((await service().requireRecovery({ scope: scope(expiredToRecovery.replicaId) })).state,
      'committed');

    const recoveryToRetired = await createReplica();
    await service().requireRecovery({ scope: scope(recoveryToRetired.replicaId) });
    assert.equal((await service().retire({ scope: scope(recoveryToRetired.replicaId, '1', '1'),
      outcome: 'authorized_success' })).state, 'committed');

    const recoveryForbidden = await createReplica();
    await service().requireRecovery({ scope: scope(recoveryForbidden.replicaId) });
    for (const result of [
      await service().renew({ scope: scope(recoveryForbidden.replicaId, '1', '1'),
        outcome: 'authorized_success', leaseDurationSeconds: 7_200 }),
      await service().resume({ scope: scope(recoveryForbidden.replicaId, '1', '1'),
        outcome: 'authorized_success', leaseDurationSeconds: 3_600 }),
      await service().requireRecovery({ scope: scope(recoveryForbidden.replicaId, '1', '1') }),
    ]) {
      assert.equal(result.state, 'denied');
      if (result.state === 'denied') assert.ok(
        result.code === 'stale_replica' || result.code === 'invalid_replica_state',
      );
    }
  });

  test('two independent connections visibly row-lock serialize retire against renew', async () => {
    for (const firstCommand of ['renew', 'retire'] as const) {
      const replica = await createReplica();
      const gate = transactionGate();
      const first = service({ faultInjector: { async afterPhase(phase) {
        if (phase === 'replica') {
          gate.enter();
          await gate.released;
        }
      } } });
      const second = service();
      const firstResult = firstCommand === 'renew'
        ? first.renew({ scope: scope(replica.replicaId), outcome: 'authorized_success',
          leaseDurationSeconds: 7_200 })
        : first.retire({ scope: scope(replica.replicaId), outcome: 'authorized_success' });
      await gate.entered;
      const secondResult = firstCommand === 'renew'
        ? second.retire({ scope: scope(replica.replicaId), outcome: 'authorized_success' })
        : second.renew({ scope: scope(replica.replicaId), outcome: 'authorized_success',
          leaseDurationSeconds: 7_200 });
      try { await waitForReplicaRowLockWait(); } finally { gate.release(); }
      const settled = await Promise.all([firstResult, secondResult]);
      assert.equal(settled[0].state, 'committed');
      assert.equal(settled[1].state, 'denied');
      if (settled[1].state === 'denied') assert.equal(settled[1].code, 'stale_replica');
      const final = await row(replica.replicaId);
      assert.equal(final.status, firstCommand === 'retire' ? 'retired' : 'active');
      assert.equal(await auditCount(replica.replicaId), 1);
    }
  });

  test('Audit, generation, and Replica facts roll back atomically at every injected phase', async () => {
    for (const phase of ['generation', 'replica', 'audit', 'coordinator'] as ReplicaLifecycleFaultPhase[]) {
      const replica = await createReplica();
      await isolated.runtime.pool.query(
        "update sync_replicas set status='expired', checkpoint_cursor='cursor-4', checkpoint_commit_ordinal=4, checkpoint_stream_kind=0, checkpoint_stable_id='legacy-operation-4', wire_json=jsonb_set(jsonb_set(jsonb_set(wire_json,'{status}','\"expired\"'),'{checkpoint,acknowledgedCursor}','\"cursor-4\"'),'{checkpoint,acknowledgedCommitOrdinal}','\"4\"') where replica_id=$1",
        [replica.replicaId],
      );
      const before = await row(replica.replicaId);
      await assert.rejects(service({ faultInjector: { afterPhase(candidate) {
        if (candidate === phase) throw new Error(`forced-${phase}`);
      } } }).resume({ scope: scope(replica.replicaId), outcome: 'authorized_success',
        leaseDurationSeconds: 3_600 }), new RegExp(`forced-${phase}`));
      assert.deepEqual(await row(replica.replicaId), before);
      assert.equal(await auditCount(replica.replicaId), 0);
      assert.equal((await isolated.runtime.pool.query(
        'select 1 from sync_replica_generations where replica_id=$1', [replica.replicaId],
      )).rowCount, 1);
    }
  });

  test('explicit recovery-required transition is audited and complete recovery is not exposed', async () => {
    const replica = await createReplica();
    const result = await service().requireRecovery({ scope: scope(replica.replicaId) });
    assert.equal(result.state, 'committed');
    assert.equal((await row(replica.replicaId)).status, 'recovery_required');
    assert.equal(await auditCount(replica.replicaId), 1);
    assert.equal('completeRecovery' in service(), false, 'P3-06 must not implement Snapshot recovery');
  });
});
