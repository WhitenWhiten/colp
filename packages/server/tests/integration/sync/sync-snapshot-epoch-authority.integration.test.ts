import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresSharedExposureFactsPort,
  runMigrations,
  createAttachmentExposurePolicyAdapter,
} from '../../../src/infrastructure/database/index.js';
import {
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncSessionIssuer,
  SYNC_BOOTSTRAP_SNAPSHOT_AUTHORITY_SQL,
  SYNC_BOOTSTRAP_SNAPSHOT_SESSION_LOCK_SQL,
} from '../../../src/infrastructure/sync/index.js';
import { SyncBootstrapSnapshotError } from '../../../src/modules/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describeWithPostgres('COLP Snapshot re-authorizes the account security epoch', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('snap_epoch_auth');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => { await isolated?.close(); });

  test('a Snapshot whose locked session epoch is stale must not materialize the tree', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'nv05', undefined, false, undefined, '0.2', 3);
    const application = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      attachmentExposure: createAttachmentExposurePolicyAdapter(
        createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const live = await application.query({
      origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 10 },
    });
    assert.ok(live.nodes.length >= 1, 'control: snapshot must materialize before the epoch bump');

    await isolated.runtime.pool.query(
      'update accounts set security_epoch = security_epoch + 1 where id = $1',
      [fixture.accountId],
    );
    await assert.rejects(
      application.query({
        origin: ORIGIN, credential: fixture.credential,
        request: { sessionId: fixture.sessionId, limit: 10 },
      }),
      (error: unknown) => error instanceof SyncBootstrapSnapshotError && error.code === 'resource_not_found',
    );

    await assert.rejects(createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 91), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    }).verify({ credential: fixture.credential, sessionId: fixture.sessionId,
      collectionId: fixture.collectionId, replicaId: fixture.replicaId,
    }));
  }, 60_000);

  test('the open snapshot transaction locks the session row before the account row', async () => {
    const sessionLock = sqlWithoutComments(SYNC_BOOTSTRAP_SNAPSHOT_SESSION_LOCK_SQL);
    const authoritySql = sqlWithoutComments(SYNC_BOOTSTRAP_SNAPSHOT_AUTHORITY_SQL);
    assert.match(sessionLock, /\bfrom\s+sync_sessions\b/iu);
    assert.match(sessionLock, /\bwhere\s+session_id=\$1\s+for\s+update\b/iu);
    assert.doesNotMatch(sessionLock, /\b(?:skip\s+locked|nowait|accounts)\b/iu);
    assert.match(authoritySql, /\bfor\s+update\s+of\s+a\b/iu);
    assert.doesNotMatch(authoritySql, /\b(?:skip\s+locked|nowait)\b/iu);
    assert.match(authoritySql, /r\.status='recovery_required' or \(r\.status='active' and r\.lease_expires_at > current_timestamp\s+and s\.lifecycle_revision = r\.lifecycle_revision\)/u);

    const fixture = await seedRecoveryFixture(isolated, 'snap-lock', undefined, false, undefined, '0.2', 1);
    const holder = await isolated.runtime.pool.connect();
    try {
      const probe = await isolated.runtime.pool.connect();
      try {
        await holder.query('begin isolation level repeatable read');
        try {
          const lockedSession = await holder.query<{ session_id: string }>(
            SYNC_BOOTSTRAP_SNAPSHOT_SESSION_LOCK_SQL, [fixture.sessionId]);
          assert.equal(lockedSession.rows.length, 1);
          assert.equal(lockedSession.rows[0]?.session_id, fixture.sessionId);
          await assert.rejects(
            probe.query(
              'select session_id from sync_sessions where session_id = $1 for key share nowait',
              [fixture.sessionId],
            ),
            (error: unknown) => isSqlState(error, '55P03'),
          );
          const unlockedAccount = await probe.query(
            'select id from accounts where id = $1 for key share nowait', [fixture.accountId]);
          assert.equal(unlockedAccount.rows.length, 1);

          const authority = await holder.query<{ account_id: string }>(SYNC_BOOTSTRAP_SNAPSHOT_AUTHORITY_SQL, [
            fixture.sessionId, fixture.credential.issuer, fixture.credential.credentialId,
            fixture.credential.subject, fixture.credential.credentialDigest,
          ]);
          assert.equal(authority.rows.length, 1);
          assert.equal(authority.rows[0]?.account_id, fixture.accountId);
          await assert.rejects(
            probe.query('select id from accounts where id = $1 for key share nowait', [fixture.accountId]),
            (error: unknown) => isSqlState(error, '55P03'),
          );
        } finally {
          await holder.query('rollback');
        }
      } finally {
        probe.release();
      }
    } finally {
      holder.release();
    }
  }, 60_000);

  test('an active session is refused after the replica lifecycle revision moves', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'snap-life', undefined, false, undefined, '0.2', 1);
    const application = snapshotApplication(isolated);
    const request = {
      origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 10 },
    };
    const live = await application.query(request);
    assert.ok(live.nodes.length >= 1, 'control: a matching active lifecycle must still snapshot');

    await isolated.runtime.pool.query(
      'update sync_replicas set lifecycle_revision = lifecycle_revision + 1 where replica_id = $1',
      [fixture.replicaId],
    );
    assert.deepEqual(await admissionFacts(isolated, fixture.sessionId), {
      replica_status: 'active', session_status: 'active', same_lifecycle: false,
      same_lease: true, same_policy: true, same_epoch: true, lease_live: true,
    });
    const before = await snapshotCount(isolated, fixture.sessionId);
    await assert.rejects(
      application.query(request),
      (error: unknown) => error instanceof SyncBootstrapSnapshotError && error.code === 'resource_not_found',
    );
    assert.equal(await snapshotCount(isolated, fixture.sessionId), before,
      'a refused active snapshot must not write another row');
  }, 60_000);

  test('recovery_required still snapshots when the lifecycle revision does not match', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'snap-life-rec', undefined, false, undefined, '0.2', 1);
    await isolated.runtime.pool.query(
      `update sync_replicas set status = 'recovery_required',
        lifecycle_revision = lifecycle_revision + 1,
        wire_json = jsonb_set(wire_json, '{status}', to_jsonb('recovery_required'::text), true)
        where replica_id = $1`,
      [fixture.replicaId],
    );
    assert.deepEqual(await admissionFacts(isolated, fixture.sessionId), {
      replica_status: 'recovery_required', session_status: 'active', same_lifecycle: false,
      same_lease: true, same_policy: true, same_epoch: true, lease_live: true,
    });
    const page = await snapshotApplication(isolated).query({
      origin: ORIGIN, credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 10 },
    });
    assert.ok(page.nodes.length >= 1);
    assert.equal(await snapshotCount(isolated, fixture.sessionId), 1);
    assert.equal((await admissionFacts(isolated, fixture.sessionId)).same_lifecycle, false,
      'snapshot admission must not realign the lifecycle revisions');
  }, 60_000);
});

function sqlWithoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/--[^\r\n]*/gu, ' ');
}

function isSqlState(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function snapshotApplication(runtime: IsolatedPostgresRuntime) {
  return createPostgresSyncBootstrapSnapshotApplication(runtime.runtime, {
    cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
    attachmentExposure: createAttachmentExposurePolicyAdapter(
      createPostgresSharedExposureFactsPort(runtime.runtime)),
  });
}

async function admissionFacts(runtime: IsolatedPostgresRuntime, sessionId: string) {
  const row = await runtime.runtime.pool.query<{
    replica_status: string; session_status: string; same_lifecycle: boolean;
    same_lease: boolean; same_policy: boolean; same_epoch: boolean; lease_live: boolean;
  }>(`select r.status replica_status, s.status session_status,
      (s.lifecycle_revision = r.lifecycle_revision) same_lifecycle,
      (s.lease_generation = r.lease_generation) same_lease,
      (s.policy_revision = c.policy_revision) same_policy,
      (a.security_epoch = s.account_security_epoch) same_epoch,
      (r.lease_expires_at > current_timestamp) lease_live
    from sync_sessions s
    join sync_replicas r on r.replica_id = s.replica_id
    join collections c on c.id = s.collection_id
    join accounts a on a.id = s.account_id
    where s.session_id = $1`, [sessionId]);
  const facts = row.rows[0];
  assert.ok(facts);
  return facts;
}

async function snapshotCount(runtime: IsolatedPostgresRuntime, sessionId: string): Promise<number> {
  const row = await runtime.runtime.pool.query<{ n: string }>(
    'select count(*)::text as n from sync_bootstrap_snapshots where session_id = $1',
    [sessionId],
  );
  return Number(row.rows[0]?.n ?? 0);
}
