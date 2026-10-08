import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { isVerifiedSyncSession } from '@know-n/colp/sync';
import {
  appendOperationWithPayload,
  createPostgresLedgerArchiveSegmentRepository,
  createPostgresSyncHistoryFloorRepository,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaRetirementApplication,
  createPostgresReplicaRetentionWindowPort,
  SyncSessionIssueError,
  type SyncSessionIssueFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import { createPostgresReplicaStore } from '../../../src/infrastructure/sync/index.js';
import type { ReplicaRecord } from '../../../src/modules/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  AUDIENCE,
  CLIENT_ID,
  ISSUER,
  capabilities,
  bootSyncSessionPostgres,
  type SyncSessionPostgresHarness,
} from '../../support/sync-session-postgres.js';

describeWithPostgres('P3-07 durable Sync Session issuance', () => {
  let harness: SyncSessionPostgresHarness;

  beforeAll(async () => {
    harness = await bootSyncSessionPostgres('p3_sync_session');
  }, 20_000);

  afterAll(async () => harness?.close());

  test('migrates empty and upgrades exactly from P3-06', async () => {
    const tables = await harness.isolated.runtime.pool.query<{ table_name: string }>(`
      select table_name from information_schema.tables where table_schema=current_schema()
      and table_name like 'sync_session%' order by table_name`);
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      'sync_session_bindings', 'sync_session_idempotency_receipts', 'sync_session_scopes', 'sync_sessions',
    ]);
    assert.equal((await harness.isolated.runtime.pool.query(
      "select to_regclass('sync_extension_credentials')::text name",
    )).rows[0]?.name, 'sync_extension_credentials');
    const upgrade = await createIsolatedPostgresRuntime('p3_session_upgrade');
    try {
      let latest = '';
      while (latest !== '202607251300_sync_replica_lifecycle') {
        const result = await runMigrations(upgrade.runtime.db, 'up');
        latest = result.results[0]?.migrationName ?? '';
        assert.notEqual(latest, '');
      }
      const upgradeClient = await upgrade.runtime.pool.connect();
      try {
        await upgradeClient.query('begin');
        await upgradeClient.query("insert into accounts(id,subject_id,status) values ('upgrade-account','upgrade-subject','active')");
        await upgradeClient.query(`insert into account_identities(id,account_id,issuer,subject)
          values ('upgrade-identity','upgrade-account',$1,'upgrade-oidc')`, [ISSUER]);
        await upgradeClient.query(`insert into resource_id_ledger(resource_id,resource_type)
          values ('upgrade-collection','collection'),('upgrade-root','node')`);
        await upgradeClient.query(`insert into collections
          (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
          values ('upgrade-collection','upgrade-subject','Upgrade','bookmarks','upgrade-root','r1','c1','p1')`);
        await upgradeClient.query(`insert into nodes
          (id,collection_id,kind,is_root,title,resource_revision,children_revision)
          values ('upgrade-root','upgrade-collection','folder',true,'Root','r1','ch1')`);
        await upgradeClient.query('commit');
      } catch (error) {
        await upgradeClient.query('rollback');
        throw error;
      } finally {
        upgradeClient.release();
      }
      const upgradeReplica = await createPostgresReplicaStore(upgrade.runtime.db, { ids: {
        deviceId: () => 'upgrade-device', replicaId: () => 'upgrade-replica',
        leaseId: () => 'upgrade-lease',
      } }).create({
        accountId: 'upgrade-account', collectionId: 'upgrade-collection', deviceName: 'Upgrade device',
        replicaName: 'Upgrade replica', kind: 'browser_extension',
        adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities,
        binding: { browserProfileId: 'upgrade-profile', mountMode: 'whole-profile',
          browserGeneration: 'upgrade-installation' }, leaseDurationSeconds: 3_600,
      }, { actorAccountId: 'upgrade-account' });
      const result = await runMigrations(upgrade.runtime.db, 'up');
      assert.deepEqual(result.results.map((item) => item.migrationName), ['202607251400_sync_sessions']);
      assert.equal((await upgrade.runtime.pool.query(
        'select 1 from sync_replicas where replica_id=$1', [upgradeReplica.replicaId],
      )).rowCount, 1);
      const down = await runMigrations(upgrade.runtime.db, 'down');
      assert.deepEqual(down.results.map((item) => item.migrationName), ['202607251400_sync_sessions']);
      const removed = await upgrade.runtime.pool.query(
        "select to_regclass('sync_sessions') name, to_regclass('sync_extension_credentials') credential",
      );
      assert.deepEqual(removed.rows[0], { name: null, credential: null });
      assert.equal((await upgrade.runtime.pool.query(
        'select 1 from sync_replicas where replica_id=$1', [upgradeReplica.replicaId],
      )).rowCount, 1);
    } finally { await upgrade.close(); }
  }, 20_000);

  test('issues the first Session for an existing active Replica and returns a package-minted context', async () => {
    const replica = await harness.createReplica('owner');
    const result = await harness.issuer().issue(harness.command('owner', replica));
    assert.equal(result.state, 'issued');
    assert.equal(isVerifiedSyncSession(result.session), true);
    assert.equal(result.envelope.replicaLease.generation, '1');
    assert.equal(result.envelope.maxBatchOperations, 1);
    assert.deepEqual(result.envelope.endpointCapabilities,
      ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict']);
    assert.notEqual(result.envelope.batchBindingSecret, result.envelope.endpointCapability);
    const stored = await harness.isolated.runtime.pool.query(
      'select secret_digest,capability_digest from sync_sessions where session_id=$1',
      [result.envelope.sessionId],
    );
    assert.equal(stored.rowCount, 1);
    assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(
      `${result.envelope.batchBindingSecret}|${result.envelope.endpointCapability}`,
    ));
  });

  test('exact replay survives a fresh issuer and creates no second side effect', async () => {
    const replica = await harness.createReplica('editor');
    const input = harness.command('editor', replica, { idempotencyKey: 'editor-replay', requestFingerprint: 'fp-editor' });
    const first = await harness.issuer().issue(input);
    const before = await harness.isolated.runtime.pool.query(`select
      (select count(*) from sync_sessions) sessions,
      (select count(*) from sync_session_idempotency_receipts) receipts,
      (select count(*) from sync_replicas where replica_id=$1) replicas,
      (select count(*) from sync_replica_generations where replica_id=$1) generations,
      (select count(*) from audit_events where event_type='sync.session.issued') audits`,
    [replica.replicaId]);
    const replay = await harness.issuer().issue(input);
    const after = await harness.isolated.runtime.pool.query(`select
      (select count(*) from sync_sessions) sessions,
      (select count(*) from sync_session_idempotency_receipts) receipts,
      (select count(*) from sync_replicas where replica_id=$1) replicas,
      (select count(*) from sync_replica_generations where replica_id=$1) generations,
      (select count(*) from audit_events where event_type='sync.session.issued') audits`,
    [replica.replicaId]);
    assert.equal(replay.state, 'replayed');
    assert.deepEqual(replay.envelope, first.envelope);
    assert.equal(isVerifiedSyncSession(replay.session), true);
    assert.deepEqual(after.rows[0], before.rows[0]);
    await assert.rejects(
      harness.issuer().issue({ ...input, requestFingerprint: 'different-fingerprint' }),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'idempotency_key_reuse',
    );
    await assert.rejects(harness.issuer({ replayEncryptionKey: Buffer.alloc(32, 9) }).issue(input),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'integrity_failure');
    await assert.rejects(harness.issuer({ replayEncryptionKeyVersion: 8 }).issue(input),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'integrity_failure');
  });

  test('replay rebuilds cursor and revision hints from current facts while keeping identity byte-stable', async () => {
    const replica = await harness.createReplica('owner');
    const input = harness.command('owner', replica, { idempotencyKey: 'replay-facts', requestFingerprint: 'replay-facts-fp' });
    const first = await harness.issuer().issue(input);
    assert.equal(first.state, 'issued');
    try {
      await harness.isolated.runtime.pool.query(`update sync_replicas set checkpoint_cursor='spc2.replay-advanced',
        checkpoint_commit_ordinal=1, checkpoint_stream_kind=1, checkpoint_stable_id='spc2.replay-advanced',
        wire_json=wire_json || jsonb_build_object('checkpoint',
          jsonb_build_object('acknowledgedCursor','spc2.replay-advanced','acknowledgedCommitOrdinal','1'))
        where replica_id=$1`, [replica.replicaId]);
      await harness.isolated.runtime.pool.query(
        "update collections set content_revision='c2-replay' where id='collection-owner'");
      const replay = await harness.issuer().issue(input);
      assert.equal(replay.state, 'replayed');
      assert.equal(replay.session.sessionId, first.session.sessionId);
      assert.equal(replay.envelope.collectionCursor, 'spc2.replay-advanced');
      assert.equal(replay.envelope.collectionRevision, 'c2-replay');
      assert.equal(replay.envelope.replicaLease.acknowledgedCursor, 'spc2.replay-advanced');
      assert.equal(replay.envelope.sessionId, first.envelope.sessionId);
      assert.equal(replay.envelope.expiresAt, first.envelope.expiresAt);
      assert.equal(replay.envelope.serverTime, first.envelope.serverTime);
      assert.equal(replay.envelope.batchBindingSecret, first.envelope.batchBindingSecret);
      assert.equal(replay.envelope.endpointCapability, first.envelope.endpointCapability);
      assert.equal(replay.envelope.endpointCapabilities.join(','),
        first.envelope.endpointCapabilities.join(','));
    } finally {
      await harness.isolated.runtime.pool.query(
        "update collections set content_revision='c1' where id='collection-owner'");
    }
  });

  test('replay after the Replica enters recovery renegotiates instead of serving stale capabilities', async () => {
    const replica = await harness.createReplica('owner');
    const input = harness.command('owner', replica, { idempotencyKey: 'replay-recovery', requestFingerprint: 'replay-recovery-fp' });
    const first = await harness.issuer().issue(input);
    assert.equal(first.state, 'issued');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='recovery_required',
      wire_json=wire_json || jsonb_build_object('status','recovery_required') where replica_id=$1`,
    [replica.replicaId]);
    const error = await harness.issuer().issue(input).then(
      () => null,
      (value: unknown) => value,
    );
    assert.ok(error instanceof SyncSessionIssueError);
    assert.equal(error.code, 'session_revoked');
    assert.doesNotMatch(error.message, new RegExp(
      `${first.envelope.batchBindingSecret}|${first.envelope.endpointCapability}`,
    ));
    const terminated = await harness.isolated.runtime.pool.query(
      'select status,termination_reason from sync_sessions where session_id=$1', [first.envelope.sessionId],
    );
    assert.deepEqual(terminated.rows[0], { status: 'terminated', termination_reason: 'scope_reduced' });
  });

  test('replay after the Replica lease lapses renegotiates instead of serving stale capabilities', async () => {
    const replica = await harness.createReplica('owner');
    const input = harness.command('owner', replica, { idempotencyKey: 'replay-lease-lapse', requestFingerprint: 'replay-lease-lapse-fp' });
    const first = await harness.issuer().issue(input);
    assert.equal(first.state, 'issued');
    await harness.isolated.runtime.pool.query(
      "update sync_replicas set lease_expires_at=current_timestamp,\n        last_seen_at=current_timestamp - interval '1 second' where replica_id=$1",
      [replica.replicaId],
    );
    await assert.rejects(harness.issuer().issue(input),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'session_revoked');
  });

  test('database uniqueness selects one winner for two-connection concurrent issuance', async () => {
    const replica = await harness.createReplica('owner');
    const input = harness.command('owner', replica, { idempotencyKey: 'concurrent-key', requestFingerprint: 'fp-concurrent' });
    const settled = await Promise.all([harness.issuer().issue(input), harness.issuer().issue(input)]);
    assert.equal(settled.filter((result) => result.state === 'issued').length, 1);
    assert.equal(settled.filter((result) => result.state === 'replayed').length, 1);
    assert.deepEqual(settled[0]!.envelope, settled[1]!.envelope);
  });

  test('owner and editor are authorized while viewer and cross-Collection requests are concealed', async () => {
    for (const account of ['owner', 'editor'] as const) {
      const replica = await harness.createReplica(account);
      assert.equal((await harness.issuer().issue(harness.command(account, replica))).session.status, 'active');
    }
    const viewerReplica = await harness.createReplica('viewer');
    const viewer = await harness.issuer().issue(harness.command('viewer', viewerReplica, {
      requestedScopes: ['sync:bootstrap', 'sync:pull'],
    }));
    assert.deepEqual(viewer.session.authorizationScopes, ['sync:bootstrap', 'sync:pull']);
    assert.deepEqual(viewer.envelope.endpointCapabilities, ['syncSnapshot', 'syncPull', 'syncAck']);
    const viewerWriteReplica = await harness.createReplica('viewer');
    await assert.rejects(harness.issuer().issue(harness.command('viewer', viewerWriteReplica)),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'not_found');
    const outsiderReplica = await harness.createReplica('outsider', 'collection-other');
    await assert.rejects(harness.issuer().issue({ ...harness.command('outsider', outsiderReplica), collectionId: 'collection-owner' }),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'not_found');
  });

  test('requested scopes derive endpoint capabilities and never grant an unrequested write endpoint', async () => {
    const replica = await harness.createReplica('editor');
    const pullOnly = await harness.issuer().issue(harness.command('editor', replica, {
      requestedScopes: ['sync:pull'],
    }));
    assert.deepEqual(pullOnly.session.authorizationScopes, ['sync:pull']);
    assert.deepEqual(pullOnly.envelope.endpointCapabilities, ['syncPull', 'syncAck']);
  });

  test('exact replay rechecks policy and Replica generation instead of trusting the old receipt', async () => {
    const policyReplica = await harness.createReplica('editor');
    const policyInput = harness.command('editor', policyReplica, {
      idempotencyKey: 'replay-policy', requestFingerprint: 'replay-policy-fp',
    });
    await harness.issuer().issue(policyInput);
    await harness.isolated.runtime.pool.query("update collections set policy_revision='p-replay-denied' where id='collection-owner'");
    try {
      await assert.rejects(harness.issuer().issue(policyInput),
        (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'session_revoked');
    } finally {
      await harness.isolated.runtime.pool.query("update collections set policy_revision='p1' where id='collection-owner'");
    }

    const generationReplica = await harness.createReplica('owner');
    const generationInput = harness.command('owner', generationReplica, {
      idempotencyKey: 'replay-generation', requestFingerprint: 'replay-generation-fp',
    });
    await harness.issuer().issue(generationInput);
    await harness.isolated.runtime.pool.query(`insert into sync_replica_generations
      (replica_id,lease_generation,lease_id,issued_at) values ($1,2,'lease-replay-changed',current_timestamp)`,
    [generationReplica.replicaId]);
    await harness.isolated.runtime.pool.query(`update sync_replicas set lease_generation=lease_generation+1,
      lease_id='lease-replay-changed',lifecycle_revision=lifecycle_revision+1,
      wire_json=wire_json || jsonb_build_object('leaseGeneration',(lease_generation+1)::text,
        'leaseId','lease-replay-changed') where replica_id=$1`, [generationReplica.replicaId]);
    await assert.rejects(harness.issuer().issue(generationInput),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'session_revoked');
  });

  test('rejects stale generation/revision and exact mounted-folder mismatch without renewing lease', async () => {
    const replica = await harness.createReplica('owner');
    const before = await harness.isolated.runtime.pool.query(
      'select last_seen_at,lease_expires_at,lease_generation,lifecycle_revision from sync_replicas where replica_id=$1',
      [replica.replicaId],
    );
    for (const patch of [
      { expectedLeaseGeneration: '2' }, { expectedLifecycleRevision: '1' },
      { binding: { ...replica.binding, browserGeneration: 'wrong-installation' } },
    ]) {
      await assert.rejects(harness.issuer().issue(harness.command('owner', replica, patch)),
        (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'stale_replica');
    }
    const after = await harness.isolated.runtime.pool.query(
      'select last_seen_at,lease_expires_at,lease_generation,lifecycle_revision from sync_replicas where replica_id=$1',
      [replica.replicaId],
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  test('expired, recovery-required, and retired Replicas fail closed at the database deadline boundary', async () => {
    const boundary = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(
      'update sync_replicas set lease_expires_at=current_timestamp where replica_id=$1',
      [boundary.replicaId],
    );
    await assert.rejects(harness.issuer().issue(harness.command('owner', boundary)),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'replica_expired');
    for (const [status, code] of [
      ['expired', 'replica_expired'], ['recovery_required', 'replica_recovery_required'],
      ['retired', 'replica_retired'],
    ] as const) {
      const replica = await harness.createReplica('owner');
      await harness.isolated.runtime.pool.query(`update sync_replicas set status=$2,
        lease_expires_at=case when $2='expired' then current_timestamp else lease_expires_at end,
        retired_at=case when $2='retired' then current_timestamp else null end,
        wire_json=jsonb_set(wire_json,'{status}',to_jsonb($2::text),true)
        where replica_id=$1`, [replica.replicaId, status]);
      await assert.rejects(harness.issuer().issue(harness.command('owner', replica)),
        (error: unknown) => error instanceof SyncSessionIssueError && error.code === code);
    }
  });

  test('re-negotiates an expired Replica only when the retention window remains complete', async () => {
    const replica = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      last_seen_at=current_timestamp - interval '2 hours',
      lease_expires_at=current_timestamp - interval '1 hour',
      checkpoint_cursor='cursor-4',checkpoint_commit_ordinal=4,
      checkpoint_stream_kind=0,checkpoint_stable_id='legacy-operation-4',
      wire_json=wire_json || jsonb_build_object('status','expired','checkpoint',
        jsonb_build_object('acknowledgedCursor','cursor-4','acknowledgedCommitOrdinal','4'))
      where replica_id=$1`,
    [replica.replicaId]);
    const resumed = await harness.issuer({
      resumedLeaseId: () => 'lease-resumed-session',
      retentionWindow: { async load(_transaction: unknown, collectionId: string) {
        return { collectionId, earliestPull: { cursor: 'cursor-4', commitOrdinal: '4' },
          purgedThrough: { cursor: 'cursor-3', commitOrdinal: '3' },
          snapshotUrl: '/sync/snapshots/current' };
      } },
    }).issue(harness.command('owner', replica));
    assert.equal(resumed.envelope.replicaLease.generation, '2');
    assert.equal(resumed.envelope.replicaLease.leaseId, 'lease-resumed-session');
    const stored = await harness.isolated.runtime.pool.query(
      'select status,lease_generation,lifecycle_revision from sync_replicas where replica_id=$1',
      [replica.replicaId],
    );
    assert.deepEqual(stored.rows[0], {
      status: 'active', lease_generation: '2', lifecycle_revision: '1',
    });

    const stale = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      last_seen_at=current_timestamp - interval '2 hours',
      lease_expires_at=current_timestamp - interval '1 hour',
      wire_json=jsonb_set(wire_json,'{status}','"expired"') where replica_id=$1`,
    [stale.replicaId]);
    const recoverySession = await harness.issuer({
      retentionWindow: { async load(_transaction: unknown, collectionId: string) {
        return { collectionId, earliestPull: { cursor: 'cursor-4', commitOrdinal: '4' },
          purgedThrough: { cursor: 'cursor-3', commitOrdinal: '3' },
          snapshotUrl: '/sync/snapshots/current' };
      } },
    }).issue(harness.command('owner', stale));
    assert.equal(recoverySession.envelope.replicaLease.state, 'active');
    assert.deepEqual(recoverySession.session.authorizationScopes, ['sync:bootstrap']);
    assert.deepEqual(recoverySession.envelope.endpointCapabilities, ['syncSnapshot']);
    const recovery = await harness.isolated.runtime.pool.query(
      'select status,lease_generation,lifecycle_revision from sync_replicas where replica_id=$1', [stale.replicaId],
    );
    assert.deepEqual(recovery.rows[0], { status: 'recovery_required', lease_generation: '1', lifecycle_revision: '1' });
    assert.equal((await harness.isolated.runtime.pool.query(
      'select 1 from sync_sessions where replica_id=$1', [stale.replicaId],
    )).rowCount, 1);
  });

  test('routes an active row past its lease deadline through the locked recovery decision', async () => {
    const replica = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set
      lease_expires_at=current_timestamp + interval '1 second' where replica_id=$1`, [replica.replicaId]);
    await waitForCondition(async () => {
      const result = await harness.isolated.runtime.pool.query<{ expired: boolean }>(`
        select lease_expires_at <= current_timestamp as expired
        from sync_replicas where replica_id=$1
      `, [replica.replicaId]);
      return result.rows[0]?.expired === true;
    }, {
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      description: 'the PostgreSQL sync replica lease to expire',
    });
    const recovery = await harness.issuer({ retentionWindow: { async load(_transaction: unknown, collectionId: string) {
      return { collectionId, earliestPull: { cursor: null, commitOrdinal: '1' },
        purgedThrough: { cursor: null, commitOrdinal: '1' }, snapshotUrl: '/sync/snapshots/current' };
    } } }).issue(harness.command('owner', replica));
    assert.deepEqual(recovery.session.authorizationScopes, ['sync:bootstrap']);
    assert.equal(recovery.envelope.replicaLease.generation, replica.leaseGeneration);
    const stored = await harness.isolated.runtime.pool.query(
      'select status,lease_generation,lifecycle_revision from sync_replicas where replica_id=$1', [replica.replicaId]);
    assert.deepEqual(stored.rows[0], { status: 'recovery_required', lease_generation: '1', lifecycle_revision: '1' });
  });

  test('requires recovery when an expired checkpoint is behind the purge tuple at the same ordinal', async () => {
    const replica = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      last_seen_at=current_timestamp - interval '2 hours',
      lease_expires_at=current_timestamp - interval '1 hour',checkpoint_cursor='cursor-before',
      checkpoint_commit_ordinal=9,checkpoint_stream_kind=0,checkpoint_stable_id='operation-a',
      wire_json=wire_json || jsonb_build_object('status','expired','checkpoint',
        jsonb_build_object('acknowledgedCursor','cursor-before','acknowledgedCommitOrdinal','9'))
      where replica_id=$1`, [replica.replicaId]);
    const recovery = await harness.issuer({
      retentionWindow: { async load(_transaction: unknown, collectionId: string) {
        const tuple = { commitOrdinal: '9', streamKind: 0 as const, stableId: 'operation-z' };
        return { collectionId, earliestPull: { cursor: null, commitOrdinal: '9' },
          purgedThrough: { cursor: null, commitOrdinal: '9' }, earliestPullTuple: tuple,
          purgedThroughTuple: tuple, snapshotUrl: '/sync/snapshots/current' };
      } },
    }).issue(harness.command('owner', replica));
    assert.deepEqual(recovery.session.authorizationScopes, ['sync:bootstrap']);
    assert.equal(recovery.envelope.replicaLease.generation, replica.leaseGeneration);
  });

  test('uses archived history floor for expired Replica recovery while an at-floor checkpoint resumes', async () => {
    async function historyFixture(label: string, checkpointOrdinal: 9 | 10) {
      const collection = `history-session-${label}`;
      const root = `history-session-root-${label}`;
      const client = await harness.isolated.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query(`insert into resource_id_ledger(resource_id,resource_type)
          values ($1,'collection'),($2,'node')`, [collection, root]);
        await client.query(`insert into collections
          (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
          values ($1,'owner-subject','History Session','bookmarks',$2,'r1','c1','p1')`, [collection, root]);
        await client.query(`insert into nodes
          (id,collection_id,kind,is_root,title,resource_revision,children_revision)
          values ($1,$2,'folder',true,'Root','r1','ch1')`, [root, collection]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
        const operationId = `history-session-operation-${ordinal}-${label}`;
        await harness.isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
          values ($1,'operation')`, [operationId]);
        await harness.isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(
          transaction,
          {
            operationId, collectionId: collection, commitOrdinal: BigInt(ordinal),
            operationType: 'history_floor_test', payloadJson: {},
            syncWireJson: { operationId }, actorPrincipalId: null,
          },
        ));
      }
      const replica = await harness.createReplica('owner', collection);
      await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
        last_seen_at=current_timestamp-interval '2 hours',
        lease_expires_at=current_timestamp-interval '1 hour',
        checkpoint_cursor=$2,checkpoint_commit_ordinal=$3::bigint,checkpoint_stream_kind=0,
        checkpoint_stable_id=$4,
        wire_json=wire_json || jsonb_build_object('status','expired','checkpoint',
          jsonb_build_object('acknowledgedCursor',$2::text,'acknowledgedCommitOrdinal',$3::text))
        where replica_id=$1`, [replica.replicaId, `history-cursor-${label}`, String(checkpointOrdinal),
        `history-session-operation-${checkpointOrdinal}-${label}`]);

      const archive = createPostgresLedgerArchiveSegmentRepository(harness.isolated.runtime.db);
      let segment = await archive.create({ segmentId: randomUUID(), ledgerFamily: 'operation',
        sourceRelation: 'public.operation_payloads', sourceScope: `collection:${collection}`,
        sourceKeyKind: 'bigint', sourceKeyComparator: 'signed-bigint-ascending-v1',
        sourceKeyBounds: { lowerInclusive: 1n, upperExclusive: 11n }, rowCount: 10n,
        sourceBytes: 256n, contentDigest: `sha256:${'c'.repeat(64)}`,
        archiveObjectUri: `s3://known-sync-history/${label}.parquet`,
        archiveObjectEtag: `history-etag-${label}`, archiveSchemaVersion: 1,
        kmsKeyId: 'kms:known:sync-history-v1' });
      for (const targetState of ['sealed', 'exported', 'verified'] as const) {
        segment = await archive.transition({ segmentId: segment.segmentId,
          expectedState: segment.state, expectedRevision: segment.stateRevision,
          targetState, evidence: { test: label } });
      }
      await createPostgresSyncHistoryFloorRepository(harness.isolated.runtime.db).advance({ collectionId: collection,
        position: { commitOrdinal: '10', streamKind: 'operation',
          stableId: `history-session-operation-10-${label}` },
        archiveSegmentId: segment.segmentId, expectedStateRevision: '0' });
      return replica;
    }

    const retentionWindow = createPostgresReplicaRetentionWindowPort('/sync/snapshots/current');
    const behind = await historyFixture('behind', 9);
    const recovery = await harness.issuer({ retentionWindow }).issue(harness.command('owner', behind));
    assert.deepEqual(recovery.session.authorizationScopes, ['sync:bootstrap']);
    assert.equal((await harness.isolated.runtime.pool.query<{ status: string }>(
      'select status from sync_replicas where replica_id=$1', [behind.replicaId])).rows[0]?.status,
    'recovery_required');

    const atFloor = await historyFixture('at-floor', 10);
    const resumed = await harness.issuer({ retentionWindow,
      resumedLeaseId: () => 'history-floor-resumed-lease' }).issue(harness.command('owner', atFloor));
    assert.equal(resumed.envelope.replicaLease.generation, '2');
    assert.equal(resumed.envelope.replicaLease.leaseId, 'history-floor-resumed-lease');
    assert.equal((await harness.isolated.runtime.pool.query<{ status: string }>(
      'select status from sync_replicas where replica_id=$1', [atFloor.replicaId])).rows[0]?.status,
    'active');
  });

  test('credential audience, scope, expiry, revocation, subject, and account security epoch fail closed', async () => {
    const cases: Array<[string, (value: VerifiedExtensionCredential) => unknown]> = [
      ['wrong audience', (value) => ({ ...value, audience: 'other-api' })],
      ['missing scope', (value) => ({ ...value, scopes: [] })],
      ['expired', (value) => ({ ...value, credentialExpiresAt: new Date(0), evidenceExpiresAt: new Date(0) })],
      ['wrong subject', (value) => ({ ...value, subject: 'missing-subject' })],
    ];
    for (const [, mutate] of cases) {
      const replica = await harness.createReplica('owner');
      await assert.rejects(harness.issuer().issue(harness.command('owner', replica, { credential: mutate(harness.evidence('owner')) })),
        (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid');
    }

    const revokedReplica = await harness.createReplica('owner');
    const revokedInput = harness.command('owner', revokedReplica, { idempotencyKey: 'revoked-seed', requestFingerprint: 'revoked-fp' });
    const issued = await harness.issuer().issue(revokedInput);
    await harness.isolated.runtime.pool.query(
      'update sync_extension_credentials set revoked_at=current_timestamp where credential_id=$1',
      [harness.evidence('owner').credentialId],
    );
    await assert.rejects(harness.issuer().issue(revokedInput),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid');
    const deniedReplica = await harness.createReplica('owner');
    const deniedBefore = await harness.isolated.runtime.pool.query(
      'select last_seen_at,lease_expires_at,lifecycle_revision from sync_replicas where replica_id=$1',
      [deniedReplica.replicaId],
    );
    await assert.rejects(harness.issuer().issue(harness.command('owner', deniedReplica)),
      (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid');
    const deniedAfter = await harness.isolated.runtime.pool.query(
      'select last_seen_at,lease_expires_at,lifecycle_revision from sync_replicas where replica_id=$1',
      [deniedReplica.replicaId],
    );
    assert.deepEqual(deniedAfter.rows[0], deniedBefore.rows[0]);
    await assert.rejects(harness.issuer().verify({
      credential: harness.evidence('owner'), sessionId: issued.envelope.sessionId,
      collectionId: revokedReplica.collectionId, replicaId: revokedReplica.replicaId,
    }), (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid');

    await assert.rejects(harness.isolated.runtime.pool.query(
      'update sync_extension_credentials set revoked_at=null where credential_id=$1',
      [harness.evidence('owner').credentialId],
    ));
    harness.replaceCredential('owner', await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: 'owner-oidc',
      credentialId: `credential-owner-rotated-${randomUUID()}`,
    }));
    const epochReplica = await harness.createReplica('owner');
    const epoch = await harness.issuer().issue(harness.command('owner', epochReplica));
    await harness.isolated.runtime.pool.query('update accounts set security_epoch=security_epoch+1 where id=\'owner\'');
    await assert.rejects(harness.issuer().verify({ credential: harness.evidence('owner'), sessionId: epoch.envelope.sessionId,
      collectionId: epochReplica.collectionId, replicaId: epochReplica.replicaId }),
    (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid');
    await harness.isolated.runtime.pool.query("update accounts set security_epoch=0 where id='owner'");
  });

  test('Session expiry is independent from Replica lease expiry and terminates durably at equality', async () => {
    const replica = await harness.createReplica('editor');
    const short = harness.issuer({ sessionDurationSeconds: 1 });
    const issued = await short.issue(harness.command('editor', replica));
    await harness.isolated.runtime.pool.query('select pg_sleep(1.05)');
    await assert.rejects(short.verify({ credential: harness.evidence('editor'), sessionId: issued.envelope.sessionId,
      collectionId: replica.collectionId, replicaId: replica.replicaId }),
    (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'session_expired');
    const facts = await harness.isolated.runtime.pool.query(
      'select status,termination_reason from sync_sessions where session_id=$1', [issued.envelope.sessionId],
    );
    assert.deepEqual(facts.rows[0], { status: 'terminated', termination_reason: 'lease_expired' });
    assert.equal((await harness.isolated.runtime.pool.query(
      `select 1 from audit_events event
        join audit_event_payloads payload on payload.event_id=event.id
        where event.event_type='sync.session.terminated' and payload.details_json->>'sessionId'=$1`,
      [issued.envelope.sessionId],
    )).rowCount, 1);
  });

  test('a Collection policy revision change revokes the captured authorization grant', async () => {
    const replica = await harness.createReplica('editor');
    const issued = await harness.issuer().issue(harness.command('editor', replica));
    await harness.isolated.runtime.pool.query(
      "update collections set policy_revision='p2' where id='collection-owner'",
    );
    try {
      await assert.rejects(harness.issuer().verify({
        credential: harness.evidence('editor'), sessionId: issued.envelope.sessionId,
        collectionId: replica.collectionId, replicaId: replica.replicaId,
      }), (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'session_revoked');
      const stored = await harness.isolated.runtime.pool.query(
        'select termination_reason from sync_sessions where session_id=$1',
        [issued.envelope.sessionId],
      );
      assert.equal(stored.rows[0]?.termination_reason, 'scope_reduced');
    } finally {
      await harness.isolated.runtime.pool.query(
        "update collections set policy_revision='p1' where id='collection-owner'",
      );
    }
  });

  test('every injected write failure rolls back receipt, Session, lease, and Audit atomically', async () => {
    for (const phase of ['receipt', 'session', 'binding', 'lease', 'audit', 'finalize'] as SyncSessionIssueFaultPhase[]) {
      const replica = await harness.createReplica('owner');
      const before = await harness.isolated.runtime.pool.query(
        'select last_seen_at,lease_expires_at,lifecycle_revision from sync_replicas where replica_id=$1',
        [replica.replicaId],
      );
      const failing = harness.issuer({ faultInjector: { afterPhase(value: SyncSessionIssueFaultPhase) {
        if (value === phase) throw new Error(`fault-${phase}`);
      } } });
      await assert.rejects(failing.issue(harness.command('owner', replica)), new RegExp(`fault-${phase}`));
      const rows = await harness.isolated.runtime.pool.query(`select
        (select count(*) from sync_sessions where replica_id=$1) sessions,
        (select count(*) from sync_session_idempotency_receipts where replica_id=$1) receipts,
        (select count(*) from audit_events event
          join audit_event_payloads payload on payload.event_id=event.id
          where event.event_type='sync.session.issued'
          and payload.details_json->>'replicaId'=$1) audits`,
      [replica.replicaId]);
      assert.deepEqual(rows.rows[0], { sessions: '0', receipts: '0', audits: '0' });
      const after = await harness.isolated.runtime.pool.query(
        'select last_seen_at,lease_expires_at,lifecycle_revision from sync_replicas where replica_id=$1',
        [replica.replicaId],
      );
      assert.deepEqual(after.rows[0], before.rows[0]);
    }
  });

  test('rolls back an expired-resume generation when Session issuance fails after its claim', async () => {
    const replica = await harness.createReplica('owner');
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      last_seen_at=current_timestamp - interval '2 hours',
      lease_expires_at=current_timestamp - interval '1 hour',
      checkpoint_cursor='cursor-4',checkpoint_commit_ordinal=4,
      checkpoint_stream_kind=0,checkpoint_stable_id='legacy-operation-4',
      wire_json=wire_json || jsonb_build_object('status','expired','checkpoint',
        jsonb_build_object('acknowledgedCursor','cursor-4','acknowledgedCommitOrdinal','4'))
      where replica_id=$1`, [replica.replicaId]);
    const failing = harness.issuer({
      resumedLeaseId: () => 'lease-resume-rollback',
      retentionWindow: { async load(_transaction: unknown, collectionId: string) {
        return { collectionId, earliestPull: { cursor: 'cursor-4', commitOrdinal: '4' },
          purgedThrough: { cursor: 'cursor-3', commitOrdinal: '3' },
          snapshotUrl: '/sync/snapshots/current' };
      } },
      faultInjector: { afterPhase(phase: SyncSessionIssueFaultPhase) {
        if (phase === 'generation') throw new Error('fault-generation');
      } },
    });
    await assert.rejects(failing.issue(harness.command('owner', replica)), /fault-generation/);
    const stored = await harness.isolated.runtime.pool.query(`select
      (select status from sync_replicas where replica_id=$1) status,
      (select lease_generation::text from sync_replicas where replica_id=$1) generation,
      (select lifecycle_revision::text from sync_replicas where replica_id=$1) revision,
      (select count(*)::text from sync_replica_generations where replica_id=$1) generation_rows,
      (select count(*)::text from sync_sessions where replica_id=$1) sessions`, [replica.replicaId]);
    assert.deepEqual(stored.rows[0], {
      status: 'expired', generation: '1', revision: '0', generation_rows: '1', sessions: '0',
    });
  });

  test('relational constraints reject scope, generation, and dual-read binding attacks', async () => {
    const replica = await harness.createReplica('editor');
    const issued = await harness.issuer().issue(harness.command('editor', replica));
    await assert.rejects(harness.isolated.runtime.pool.query(
      'update sync_session_bindings set collection_id=\'collection-other\' where session_id=$1',
      [issued.envelope.sessionId],
    ));
    await assert.rejects(harness.isolated.runtime.pool.query(
      'update sync_sessions set binding_json=jsonb_set(binding_json,\'{collectionId}\',\'"collection-other"\') where session_id=$1',
      [issued.envelope.sessionId],
    ));
    await assert.rejects(harness.isolated.runtime.pool.query(
      "update sync_session_idempotency_receipts set result_digest='tampered' where session_id=$1",
      [issued.envelope.sessionId],
    ));
    await assert.rejects(harness.isolated.runtime.pool.query(
      "update sync_sessions set status='active',termination_reason=null,terminated_at=null where session_id=$1",
      [issued.envelope.sessionId],
    ));
    const receipt = await harness.isolated.runtime.pool.query(
      'select result_key_version from sync_session_idempotency_receipts where session_id=$1',
      [issued.envelope.sessionId],
    );
    assert.equal(receipt.rows[0]?.result_key_version, 7);
    const secrets = [issued.envelope.batchBindingSecret, issued.envelope.endpointCapability];
    const audit = await harness.isolated.runtime.pool.query(
      `select payload.details_json::text body from audit_events event
        join audit_event_payloads payload on payload.event_id=event.id
        where event.event_type='sync.session.issued' and payload.details_json->>'sessionId'=$1`,
      [issued.envelope.sessionId],
    );
    const databaseProjection = await harness.isolated.runtime.pool.query(`select concat_ws('|',
      (select jsonb_agg(to_jsonb(s))::text from sync_sessions s where session_id=$1),
      (select jsonb_agg(to_jsonb(c))::text from sync_extension_credentials c),
      (select jsonb_agg(to_jsonb(r))::text from sync_session_idempotency_receipts r where session_id=$1),
      (select jsonb_agg(to_jsonb(payload.details_json))::text from audit_events event
        join audit_event_payloads payload on payload.event_id=event.id
        where event.event_type like 'sync.%' and payload.details_json->>'sessionId'=$1)) body`,
    [issued.envelope.sessionId]);
    for (const secret of secrets) {
      assert.doesNotMatch(audit.rows[0]?.body ?? '', new RegExp(secret));
      assert.doesNotMatch(databaseProjection.rows[0]?.body ?? '', new RegExp(secret));
    }
  });

  test('retires an active Replica with its Sessions, immutable receipt and one redacted Audit', async () => {
    const replica = await harness.createReplica('owner');
    const issued = await harness.issuer().issue(harness.command('owner', replica));
    const application = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db);
    const request = { credential: harness.evidence('owner'), sessionId: issued.envelope.sessionId,
      idempotencyKey: `retire-${randomUUID()}`, requestFingerprint: 'retire-active-v1' };
    await application.retireExtension(request);
    await application.retireExtension(request);
    await assert.rejects(application.retireExtension({ ...request, requestFingerprint: 'retire-reused' }),
      /idempotency|reuse/iu);

    const state = await harness.isolated.runtime.pool.query(`select
      (select status from sync_replicas where replica_id=$1) replica_status,
      (select retired_at is not null from sync_replicas where replica_id=$1) has_retired_at,
      (select status from sync_sessions where session_id=$2) session_status,
      (select count(*)::text from sync_replica_retirement_receipts where replica_id=$1) receipts,
      (select count(*)::text from audit_events event
        join audit_event_payloads payload on payload.event_id=event.id
        where event.event_type like 'sync.replica.lifecycle.%_to_retired'
        and payload.details_json->>'replicaId'=$1) audits`, [replica.replicaId, issued.envelope.sessionId]);
    assert.deepEqual(state.rows[0], { replica_status: 'retired', has_retired_at: true,
      session_status: 'terminated', receipts: '1', audits: '1' });
    const audit = await harness.isolated.runtime.pool.query<{ body: string }>(`select payload.details_json::text body
      from audit_events event
      join audit_event_payloads payload on payload.event_id=event.id
      where event.event_type like 'sync.replica.lifecycle.%_to_retired'
      and payload.details_json->>'replicaId'=$1`, [replica.replicaId]);
    assert.doesNotMatch(audit.rows[0]?.body ?? '',
      /credential-owner|retire-active-v1|browserProfileId|leaseId|deviceName|url|title|indexeddb/iu);
    await assert.rejects(harness.isolated.runtime.pool.query(
      'update sync_replica_retirement_receipts set result_digest=$3 where replica_id=$1 and idempotency_key=$2',
      [replica.replicaId, request.idempotencyKey, '0'.repeat(64)],
    ), /immutable/iu);
    await assert.rejects(harness.isolated.runtime.pool.query(
      'delete from sync_replica_retirement_receipts where replica_id=$1 and idempotency_key=$2',
      [replica.replicaId, request.idempotencyKey],
    ), /immutable/iu);
    assert.equal((await harness.isolated.runtime.pool.query(
      'select count(*)::text count from sync_replica_retirement_receipts where replica_id=$1',
      [replica.replicaId],
    )).rows[0]?.count, '1');
  });

  test('retires expired and recovery_required Replicas through the same authority transaction', async () => {
    for (const lifecycle of ['expired', 'recovery_required'] as const) {
      const replica = await harness.createReplica('owner');
      const issued = await harness.issuer().issue(harness.command('owner', replica));
      await harness.isolated.runtime.pool.query(`update sync_replicas set status=$2,
        wire_json=jsonb_set(wire_json,'{status}',to_jsonb($2::text),true)
        where replica_id=$1`, [replica.replicaId, lifecycle]);
      await createPostgresReplicaRetirementApplication(harness.isolated.runtime.db).retireExtension({
        credential: harness.evidence('owner'), sessionId: issued.envelope.sessionId,
        idempotencyKey: `retire-${lifecycle}-${randomUUID()}`,
        requestFingerprint: `retire-${lifecycle}-v1`,
      });
      const stored = await harness.isolated.runtime.pool.query<{ status: string; retired_at: Date | null }>(
        'select status,retired_at from sync_replicas where replica_id=$1', [replica.replicaId]);
      assert.equal(stored.rows[0]?.status, 'retired');
      assert.ok(stored.rows[0]?.retired_at instanceof Date);
    }
  });

  test('reinstall creates a fresh Replica and imported retired identity fails closed across accounts', async () => {
    const oldReplica = await harness.createReplica('owner');
    const oldSession = await harness.issuer().issue(harness.command('owner', oldReplica));
    await createPostgresReplicaRetirementApplication(harness.isolated.runtime.db).retireExtension({
      credential: harness.evidence('owner'), sessionId: oldSession.envelope.sessionId,
      idempotencyKey: `retire-reinstall-${randomUUID()}`, requestFingerprint: 'retire-before-reinstall',
    });
    const replacement = await harness.createReplica('owner');
    assert.notEqual(replacement.replicaId, oldReplica.replicaId);
    assert.notEqual(replacement.binding.browserGeneration, oldReplica.binding.browserGeneration);
    await assert.rejects(harness.issuer().issue(harness.command('owner', oldReplica, {
      idempotencyKey: `old-backup-${randomUUID()}`, requestFingerprint: 'imported-indexeddb-backup',
    })), /retired/iu);
    await assert.rejects(harness.issuer().issue(harness.command('outsider', oldReplica, {
      idempotencyKey: `cross-account-old-${randomUUID()}`, requestFingerprint: 'cross-account-old-id',
    })), /not_found|not found|unauthorized|conceal/iu);
    await assert.rejects(createPostgresReplicaStore(harness.isolated.runtime.db, { ids: {
      deviceId: () => 'restored-device', replicaId: () => oldReplica.replicaId,
      leaseId: () => 'restored-lease',
    } }).create(createInputForRetiredRestore('owner', oldReplica), { actorAccountId: 'owner' }), /exists|reserved|unique/iu);
  });

  test('rolls back Replica, Session, receipt and Audit at every retirement fault boundary', async () => {
    for (const phase of ['receipt', 'replica', 'sessions', 'audit'] as const) {
      const replica = await harness.createReplica('owner');
      const issued = await harness.issuer().issue(harness.command('owner', replica));
      const application = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db, {
        faultInjector: { afterPhase(current) { if (current === phase) throw new Error(`fault-${phase}`); } },
      });
      await assert.rejects(application.retireExtension({ credential: harness.evidence('owner'),
        sessionId: issued.envelope.sessionId, idempotencyKey: `fault-${phase}-${randomUUID()}`,
        requestFingerprint: `fault-${phase}` }), new RegExp(`fault-${phase}`));
      const state = await harness.isolated.runtime.pool.query(`select
        (select status from sync_replicas where replica_id=$1) replica_status,
        (select status from sync_sessions where session_id=$2) session_status,
        (select count(*)::text from sync_replica_retirement_receipts where replica_id=$1) receipts,
        (select count(*)::text from audit_events event
          join audit_event_payloads payload on payload.event_id=event.id
          where event.event_type like 'sync.replica.lifecycle.%_to_retired'
          and payload.details_json->>'replicaId'=$1) audits`, [replica.replicaId, issued.envelope.sessionId]);
      assert.deepEqual(state.rows[0], { replica_status: 'active', session_status: 'active',
        receipts: '0', audits: '0' });
    }
  });

  test('serializes retirement against an in-flight Session issue on independent connections', async () => {
    const replica = await harness.createReplica('owner');
    const first = await harness.issuer().issue(harness.command('owner', replica));
    const current = await harness.isolated.runtime.db.selectFrom('sync_replicas')
      .select(['lease_generation', 'lifecycle_revision']).where('replica_id', '=', replica.replicaId)
      .executeTakeFirstOrThrow();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const retirementEntered = new Promise<void>((resolve) => { entered = resolve; });
    const retirement = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db, {
      faultInjector: { async afterPhase(phase) {
        if (phase === 'replica') { entered(); await blocked; }
      } },
    }).retireExtension({ credential: harness.evidence('owner'), sessionId: first.envelope.sessionId,
      idempotencyKey: `retire-session-race-${randomUUID()}`, requestFingerprint: 'retire-session-race' });
    await retirementEntered;
    const issue = harness.issuer().issue(harness.command('owner', replica, {
      idempotencyKey: `issue-during-retire-${randomUUID()}`,
      requestFingerprint: 'issue-during-retire',
      expectedLeaseGeneration: BigInt(current.lease_generation).toString(),
      expectedLifecycleRevision: BigInt(current.lifecycle_revision).toString(),
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await retirement;
    await assert.rejects(issue, /retired|stale|not_found/iu);
    const state = await harness.isolated.runtime.pool.query(`select
      (select status from sync_replicas where replica_id=$1) replica_status,
      (select count(*)::text from sync_sessions where replica_id=$1 and status='active') active_sessions,
      (select count(*)::text from sync_replica_retirement_receipts where replica_id=$1) receipts`,
    [replica.replicaId]);
    assert.deepEqual(state.rows[0], { replica_status: 'retired', active_sessions: '0', receipts: '1' });
  });
});

function createInputForRetiredRestore(accountId: string, replica: ReplicaRecord) {
  return {
    accountId, collectionId: replica.collectionId, deviceName: 'Restored browser', replicaName: 'Chrome',
    kind: 'browser_extension' as const, adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities, binding: { browserProfileId: replica.binding.browserProfileId,
      mountMode: replica.binding.mountMode, browserGeneration: replica.binding.browserGeneration },
    leaseDurationSeconds: 3_600,
  };
}
