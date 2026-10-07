import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresReplicaRetirementApplication } from '../../../src/infrastructure/sync/index.js';
import { SyncRetireError } from '../../../src/modules/sync/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  bootSyncSessionPostgres,
  type SyncSessionPostgresHarness,
} from '../../support/sync-session-postgres.js';

describeWithPostgres('retire requires a live Session and lifecycle equality on an active Replica', () => {
  let harness: SyncSessionPostgresHarness;

  beforeAll(async () => {
    harness = await bootSyncSessionPostgres('p3_retire_liveness');
  }, 60_000);

  afterAll(async () => harness?.close());

  test('replays a completed retirement after that Session has been terminated', async () => {
    const replica = await harness.createReplica('owner');
    const issued = await harness.issuer().issue(harness.command('owner', replica));
    const aligned = await facts(harness, issued.envelope.sessionId);
    assert.equal(aligned.session_status, 'active');
    assert.equal(aligned.replica_status, 'active');
    assert.equal(aligned.same_lifecycle, true);
    const application = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db);
    const request = {
      credential: harness.evidence('owner'), sessionId: issued.envelope.sessionId,
      idempotencyKey: `retire-live-${randomUUID()}`, requestFingerprint: 'retire-live-v1',
    };
    await application.retireExtension(request);
    assert.equal((await facts(harness, issued.envelope.sessionId)).session_status, 'terminated');
    await application.retireExtension(request);
    await assert.rejects(
      application.retireExtension({ ...request, requestFingerprint: 'retire-live-reused' }),
      (error: unknown) => error instanceof SyncRetireError && error.code === 'idempotency_key_reused',
    );
    await assertStored(harness.isolated.runtime.pool, replica.replicaId, 'retired', '1');
  });

  test('rejects a terminated or lifecycle-superseded Session on an active Replica', async () => {
    const application = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db);
    const terminated = await harness.createReplica('owner');
    const terminatedIssued = await harness.issuer().issue(harness.command('owner', terminated));
    await harness.isolated.runtime.pool.query(`update sync_sessions set status='terminated',
      termination_reason='administrative', terminated_at=current_timestamp where session_id=$1`,
    [terminatedIssued.envelope.sessionId]);
    await denyUntouched(application, harness, terminatedIssued.envelope.sessionId,
      terminated.replicaId, 'retire-terminated');
    await assertStored(harness.isolated.runtime.pool, terminated.replicaId, 'active', '0');

    const stale = await harness.createReplica('owner');
    const staleIssued = await harness.issuer().issue(harness.command('owner', stale));
    await harness.isolated.runtime.pool.query(
      'update sync_replicas set lifecycle_revision=lifecycle_revision+1 where replica_id=$1',
      [stale.replicaId]);
    const drifted = await facts(harness, staleIssued.envelope.sessionId);
    assert.equal(drifted.replica_status, 'active');
    assert.equal(drifted.session_status, 'active');
    assert.equal(drifted.same_lifecycle, false);
    const revision = await harness.isolated.runtime.pool.query<{ lifecycle_revision: string }>(
      'select lifecycle_revision::text from sync_replicas where replica_id=$1', [stale.replicaId]);
    const alignedRevision = revision.rows[0]?.lifecycle_revision;
    assert.ok(alignedRevision);
    const liveIssued = await harness.issuer().issue(harness.command('owner', stale, {
      expectedLifecycleRevision: alignedRevision,
    }));
    const aligned = await facts(harness, liveIssued.envelope.sessionId);
    assert.equal(aligned.session_status, 'active');
    assert.equal(aligned.replica_status, 'active');
    assert.equal(aligned.same_lifecycle, true);
    await denyUntouched(application, harness, staleIssued.envelope.sessionId,
      stale.replicaId, 'retire-stale-lifecycle');
    assert.equal((await facts(harness, staleIssued.envelope.sessionId)).session_status, 'active');
    assert.equal((await facts(harness, liveIssued.envelope.sessionId)).session_status, 'active');
    assert.equal((await facts(harness, liveIssued.envelope.sessionId)).same_lifecycle, true);
    await assertStored(harness.isolated.runtime.pool, stale.replicaId, 'active', '0');
  });

  test('rejects an expired Session for an active Replica and for recovery', async () => {
    const application = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db);
    const expired = await harness.createReplica('owner');
    const expiredIssued = await harness.issuer({ sessionDurationSeconds: 1 })
      .issue(harness.command('owner', expired));
    const recovery = await harness.createReplica('owner');
    const recoveryIssued = await harness.issuer({ sessionDurationSeconds: 1 })
      .issue(harness.command('owner', recovery));
    await setReplicaStatus(harness.isolated.runtime.pool, recovery.replicaId, 'recovery_required');
    await harness.isolated.runtime.pool.query('select pg_sleep(1.05)');
    for (const sessionId of [expiredIssued.envelope.sessionId, recoveryIssued.envelope.sessionId]) {
      const row = await harness.isolated.runtime.pool.query<{ status: string; expired: boolean }>(
        'select status, expires_at <= current_timestamp expired from sync_sessions where session_id=$1',
        [sessionId]);
      assert.deepEqual(row.rows[0], { status: 'active', expired: true });
    }
    await denyUntouched(application, harness, expiredIssued.envelope.sessionId,
      expired.replicaId, 'retire-expired');
    await denyUntouched(application, harness, recoveryIssued.envelope.sessionId,
      recovery.replicaId, 'retire-recovery-expired');
    await assertStored(harness.isolated.runtime.pool, expired.replicaId, 'active', '0');
    await assertStored(harness.isolated.runtime.pool, recovery.replicaId, 'recovery_required', '0');
  });

  test('rejects a terminated Session when the Replica requires recovery', async () => {
    const replica = await harness.createReplica('owner');
    const issued = await harness.issuer().issue(harness.command('owner', replica));
    await setReplicaStatus(harness.isolated.runtime.pool, replica.replicaId, 'recovery_required');
    await harness.isolated.runtime.pool.query(`update sync_sessions set status='terminated',
      termination_reason='administrative', terminated_at=current_timestamp where session_id=$1`,
    [issued.envelope.sessionId]);
    await denyUntouched(
      createPostgresReplicaRetirementApplication(harness.isolated.runtime.db),
      harness, issued.envelope.sessionId, replica.replicaId, 'retire-recovery-terminated',
    );
    await assertStored(harness.isolated.runtime.pool, replica.replicaId, 'recovery_required', '0');
  });

  test('retires recovery_required and expired Replicas from a live Session', async () => {
    const application = createPostgresReplicaRetirementApplication(harness.isolated.runtime.db);
    const recovery = await harness.createReplica('owner');
    const recoveryIssued = await harness.issuer().issue(harness.command('owner', recovery));
    await harness.isolated.runtime.pool.query(`update sync_replicas set status='recovery_required',
      lifecycle_revision=lifecycle_revision+1,
      wire_json=jsonb_set(wire_json,'{status}',to_jsonb('recovery_required'::text),true)
      where replica_id=$1`, [recovery.replicaId]);
    const drifted = await facts(harness, recoveryIssued.envelope.sessionId);
    assert.equal(drifted.session_status, 'active');
    assert.equal(drifted.replica_status, 'recovery_required');
    assert.equal(drifted.same_lifecycle, false);
    await application.retireExtension({
      credential: harness.evidence('owner'), sessionId: recoveryIssued.envelope.sessionId,
      idempotencyKey: `retire-recovery-${randomUUID()}`, requestFingerprint: 'retire-recovery-drift',
    });
    await assertStored(harness.isolated.runtime.pool, recovery.replicaId, 'retired', '1');

    const expiredReplica = await harness.createReplica('owner');
    const expiredIssued = await harness.issuer().issue(harness.command('owner', expiredReplica));
    await setReplicaStatus(harness.isolated.runtime.pool, expiredReplica.replicaId, 'expired');
    const live = await facts(harness, expiredIssued.envelope.sessionId);
    assert.equal(live.session_status, 'active');
    assert.equal(live.same_lifecycle, true);
    await application.retireExtension({
      credential: harness.evidence('owner'), sessionId: expiredIssued.envelope.sessionId,
      idempotencyKey: `retire-expired-replica-${randomUUID()}`,
      requestFingerprint: 'retire-expired-replica',
    });
    await assertStored(harness.isolated.runtime.pool, expiredReplica.replicaId, 'retired', '1');
  });
});

function retireInput(harness: SyncSessionPostgresHarness, sessionId: string, fingerprint: string) {
  return {
    credential: harness.evidence('owner'), sessionId,
    idempotencyKey: `retire-${randomUUID()}`, requestFingerprint: fingerprint,
  };
}

function deny(
  application: ReturnType<typeof createPostgresReplicaRetirementApplication>,
  harness: SyncSessionPostgresHarness,
  sessionId: string,
  fingerprint: string,
) {
  return assert.rejects(
    application.retireExtension(retireInput(harness, sessionId, fingerprint)),
    (error: unknown) => error instanceof SyncRetireError && error.code === 'resource_not_found',
  );
}

async function denyUntouched(
  application: ReturnType<typeof createPostgresReplicaRetirementApplication>,
  harness: SyncSessionPostgresHarness,
  sessionId: string,
  replicaId: string,
  fingerprint: string,
) {
  const beforeStatus = (await facts(harness, sessionId)).session_status;
  const active = await activeSessionCount(harness.isolated.runtime.pool, replicaId);
  await deny(application, harness, sessionId, fingerprint);
  const afterStatus = (await facts(harness, sessionId)).session_status;
  assert.equal(afterStatus, beforeStatus);
  if (beforeStatus === 'active') assert.equal(afterStatus, 'active');
  assert.equal(await activeSessionCount(harness.isolated.runtime.pool, replicaId), active);
}

async function activeSessionCount(pool: Pool, replicaId: string) {
  const row = await pool.query<{ active: string }>(
    `select count(*)::text active from sync_sessions where replica_id=$1 and status='active'`,
    [replicaId]);
  const active = row.rows[0]?.active;
  assert.ok(active);
  return active;
}

async function setReplicaStatus(pool: Pool, replicaId: string, status: 'expired' | 'recovery_required') {
  await pool.query(`update sync_replicas set status=$2,
    wire_json=jsonb_set(wire_json,'{status}',to_jsonb($2::text),true) where replica_id=$1`,
  [replicaId, status]);
}

async function facts(harness: SyncSessionPostgresHarness, sessionId: string) {
  const row = await harness.isolated.runtime.pool.query<{
    session_status: string; replica_status: string; same_lifecycle: boolean;
  }>(`select s.status session_status, r.status replica_status,
      (s.lifecycle_revision = r.lifecycle_revision) same_lifecycle
    from sync_sessions s join sync_replicas r on r.replica_id = s.replica_id
    where s.session_id=$1`, [sessionId]);
  const factsRow = row.rows[0];
  assert.ok(factsRow);
  return factsRow;
}

async function assertStored(pool: Pool, replicaId: string, status: string, receipts: string) {
  const row = await pool.query<{ status: string; receipts: string }>(`select
    (select status from sync_replicas where replica_id=$1) status,
    (select count(*)::text from sync_replica_retirement_receipts where replica_id=$1) receipts`,
  [replicaId]);
  assert.deepEqual(row.rows[0], { status, receipts });
}
