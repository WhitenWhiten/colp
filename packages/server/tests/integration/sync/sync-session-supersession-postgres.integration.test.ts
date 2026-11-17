import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createAttachmentExposurePolicyAdapter,
  createPostgresSharedExposureFactsPort,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import {
  PostgresSyncEvidenceMaintenanceCoordinator,
  createPostgresReplicaStore,
  createPostgresSyncAckApplication,
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncSequencePort,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { SyncAckError, SyncBootstrapSnapshotError,
  type SyncSequenceAdmissionInput } from '../../../src/modules/sync/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { appliedSequenceResult, syncSequenceAdmission } from '../../fixtures/phase3/sync-sequence.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ACCOUNT = 'a23-account';
const SUBJECT = 'a23-subject';
const COLLECTION = 'a23-collection';
const OIDC_SUBJECT = 'a23-oidc';
const GRACE_MS = 24 * 60 * 60 * 1_000;

describeWithPostgres('A2-3 superseded Session termination and receipt retention', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('a2_3_session_supersession', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('a23-identity',$1,$2,$3)`, [ACCOUNT, ISSUER, OIDC_SUBJECT]);
      await client.query("insert into profile_handles(handle,account_id) values ('sync_a23',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),('a23-root','node')`, [COLLECTION]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'A2-3 collection','bookmarks','a23-root','collection-r1','content-r1','policy-r1')`,
      [COLLECTION, SUBJECT]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('a23-root',$1,'folder',true,'Root','root-r1','children-r1')`, [COLLECTION]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }, 30_000);

  afterAll(async () => isolated?.close());

  async function credential(label: string) {
    return mintVerifiedExtensionCredentialFixture({ issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', subject: OIDC_SUBJECT, credentialId: `a23-credential-${label}` });
  }

  async function createReplica(label: string) {
    return createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `a23-device-${label}`, replicaId: () => `a23-replica-${label}`,
      leaseId: () => `a23-lease-${label}`,
    } }).create({ accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'A2-3 device',
      replicaName: 'A2-3 replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `a23-profile-${label}`, mountMode: 'whole-profile',
        browserGeneration: `a23-generation-${label}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
  }

  function issuer(sessionDurationSeconds = 900,
    faultInjector?: { afterPhase?(phase: string): void | Promise<void> }) {
    return createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: ISSUER,
      audience: 'known-api', clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 41),
      replayEncryptionKeyVersion: 1, sessionDurationSeconds, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      ...(faultInjector ? { faultInjector } : {}),
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
  }

  async function replicaFacts(replicaId: string) {
    const row = await isolated.runtime.db.selectFrom('sync_replicas').select([
      'lease_generation', 'lifecycle_revision',
    ]).where('replica_id', '=', replicaId).executeTakeFirstOrThrow();
    return { leaseGeneration: String(row.lease_generation),
      lifecycleRevision: String(row.lifecycle_revision) };
  }

  /**
   * Ack needs a matching evidence row to reach the Session lock. Seed an
   * already-expired cursor so this fixture cannot become later maintenance
   * backlog relative to an injected future clock.
   */
  async function seedExpiredAckCursor(sessionId: string, replicaId: string,
    leaseGeneration: string, policyRevision: string): Promise<string> {
    const cursor = `a23-lock-cursor-${randomUUID()}`;
    const expiredAt = new Date(Date.now() - 3_600_000);
    await isolated.runtime.pool.query(`insert into sync_pull_cursor_evidence
      (cursor,cursor_digest,session_id,account_id,collection_id,replica_id,lease_generation,
       policy_revision,protocol_version,tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,
       cursor_expires_at,issued_at,upper_commit_ordinal,upper_stream_kind,upper_stable_id,
       collection_revision,page_limit,purge_commit_ordinal,purge_stream_kind,purge_stable_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'0.1',0,0,'',$9,$10,0,0,'','content-r1',100,0,0,'')`,
    [cursor, createHash('sha256').update(cursor, 'utf8').digest('hex'), sessionId, ACCOUNT, COLLECTION,
      replicaId, BigInt(leaseGeneration), policyRevision, expiredAt, new Date(expiredAt.getTime() - 3_600_000)]);
    return cursor;
  }

  function coordinator() {
    return new PostgresSyncEvidenceMaintenanceCoordinator(isolated.runtime.db, {
      workerId: randomUUID(), batchSize: 500, leaseDurationMs: 30_000,
    });
  }

  /** Snapshot GET takes the Session lock before its account/replica lookups. */
  function snapshotGet() {
    return createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 17), cursorKeyId: 'a23-lock-snapshot', cursorTtlMs: 60_000,
      attachmentExposure: createAttachmentExposurePolicyAdapter(
        createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
  }

  async function sessionRow(sessionId: string) {
    const result = await isolated.runtime.pool.query<{
      status: string; termination_reason: string | null; terminated_at: Date | null }>(
      'select status, termination_reason, terminated_at from sync_sessions where session_id=$1', [sessionId]);
    return result.rows[0] as { status: string; termination_reason: string | null;
      terminated_at: Date | null } | undefined;
  }

  async function terminatedAuditCount(sessionId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int as count
      from audit_events event
      join audit_event_payloads payload on payload.event_id = event.id
      where event.event_type='sync.session.terminated'
        and payload.details_json->>'sessionId'=$1`, [sessionId]);
    return result.rows[0]?.count ?? 0;
  }

  /**
   * The row this suite's blocked Ack is waiting on. A row-lock wait appears as
   * an ungranted `transactionid` lock, so inspect both participants: with the
   * documented order the renewal blocker holds a `sync_sessions` relation row
   * lock (RowShareLock) before its authority prefix, and the waiting Ack's tuple
   * lock names the row it tried to lock. Waiting on the Session row — not on
   * accounts/replicas — is the proof that the order was not inverted.
   */
  async function sessionLockWait(): Promise<{
    readonly waiter: number;
    readonly blocker: number;
    readonly waiterTupleRelations: readonly string[];
    readonly blockerLocksSession: boolean;
  } | undefined> {
    const waiting = await isolated.runtime.pool.query<{ pid: number; blocker: number }>(`
      select activity.pid, (pg_blocking_pids(activity.pid))[1] as blocker
      from pg_stat_activity activity
      where activity.application_name = 'known-test-a2_3_session_supersession'
        and activity.pid <> pg_backend_pid()
        and cardinality(pg_blocking_pids(activity.pid)) > 0
      limit 1`);
    const row = waiting.rows[0];
    if (!row || row.blocker === null) return undefined;
    const [relationLocks, tupleLocks] = await Promise.all([
      isolated.runtime.pool.query<{ pid: number; mode: string }>(`
        select lock.pid, lock.mode
        from pg_locks lock
        join pg_class relation on relation.oid = lock.relation
        where relation.relname = 'sync_sessions' and lock.locktype = 'relation'
          and lock.pid = any($1::int[])`, [[row.pid, row.blocker]]),
      isolated.runtime.pool.query<{ relname: string }>(`
        select relation.relname
        from pg_locks lock
        join pg_class relation on relation.oid = lock.relation
        where lock.pid = $1 and lock.locktype = 'tuple'
        order by relation.relname`, [row.pid]),
    ]);
    return {
      waiter: row.pid,
      blocker: row.blocker,
      waiterTupleRelations: tupleLocks.rows.map((lock) => lock.relname),
      blockerLocksSession: relationLocks.rows.some((lock) =>
        lock.pid === row.blocker && lock.mode !== 'AccessShareLock'),
    };
  }

  async function executeSequence(request: SyncSequenceAdmissionInput) {
    return createPostgresSyncSequencePort(isolated.runtime.db).coordinate(request, async () => ({
      status: 'applied' as const,
      result: appliedSequenceResult(request.operationId),
    }));
  }

  test('renewal terminates the superseded Session and its receipts stay replayable after reclamation', async () => {
    const value = await credential('renewal');
    const replica = await createReplica('renewal');
    const first = await issuer().issue({ credential: value, idempotencyKey: 'a23-renew-1',
      requestFingerprint: 'a23-renew-1-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:push'], origin: ORIGIN });
    assert.equal(first.state, 'issued');
    if (first.state !== 'issued') throw new Error('first issue denied');
    const request = syncSequenceAdmission(first.session, replica.replicaId, {
      transactionalAuthority: { credential: value, origin: ORIGIN },
    });
    const executed = await executeSequence(request);
    assert.equal(executed.result.kind, 'executed');
    const receipt = executed.result.receipt;
    assert.ok(receipt);

    // Renewal for the same Replica: a brand-new Session supersedes the first.
    const facts = await replicaFacts(replica.replicaId);
    const second = await issuer().issue({ credential: value, idempotencyKey: 'a23-renew-2',
      requestFingerprint: 'a23-renew-2-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: facts.leaseGeneration, expectedLifecycleRevision: facts.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:push'], origin: ORIGIN });
    assert.equal(second.state, 'issued');
    if (second.state !== 'issued') throw new Error('renewal denied');
    assert.notEqual(second.session.sessionId, first.session.sessionId);
    const superseded = await sessionRow(first.session.sessionId);
    assert.equal(superseded?.status, 'terminated');
    assert.equal(superseded?.termination_reason, 'lease_expired');
    assert.ok(superseded?.terminated_at instanceof Date);
    assert.equal((await sessionRow(second.session.sessionId))?.status, 'active');
    assert.equal(await terminatedAuditCount(first.session.sessionId), 1);

    // After the retention grace, terminal cleanup deletes the superseded Session
    // while its replica-lifetime Sequence receipt survives.
    const now = new Date(superseded!.terminated_at!.getTime() + 2 * GRACE_MS);
    const cleaned = await coordinator().runBatch({ now });
    assert.ok(cleaned.deleted >= 4, `expected Session authority reclamation, got ${cleaned.deleted}`);
    assert.equal(await sessionRow(first.session.sessionId), undefined);
    const retained = await isolated.runtime.pool.query<{
      session_id: string; sequence_number: string; operation_id: string }>(
      `select session_id, sequence_number::text, operation_id from sync_sequence_receipts
        where replica_id=$1 and sequence_scope=$2 and sequence_number=1`,
      [replica.replicaId, request.sequenceScope]);
    assert.equal(retained.rowCount, 1);
    assert.equal(retained.rows[0]?.session_id, first.session.sessionId,
      'immutable receipt provenance is retained even after the Session row is reclaimed');

    // The Replica is still live: a fresh Session replays the retained receipt
    // instead of re-evaluating the Operation.
    const current = await replicaFacts(replica.replicaId);
    const third = await issuer().issue({ credential: value, idempotencyKey: 'a23-renew-3',
      requestFingerprint: 'a23-renew-3-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: current.leaseGeneration, expectedLifecycleRevision: current.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:push'], origin: ORIGIN });
    assert.equal(third.state, 'issued');
    if (third.state !== 'issued') throw new Error('post-cleanup renewal denied');
    const replay = await createPostgresSyncSequencePort(isolated.runtime.db).coordinate({
      ...request, session: third.session, serverBatchId: `${third.session.sessionId}.batch.1`,
    }, async () => assert.fail('a retained receipt must replay without re-evaluation'));
    assert.equal(replay.result.kind, 'replayed');
    assert.deepEqual(replay.result.receipt?.result, receipt.result);
  }, 60_000);

  test('renewal takes the Session lock before the account prefix, so a concurrent Ack cannot deadlock', async () => {
    const value = await credential('lock-order');
    const replica = await createReplica('lock-order');
    const first = await issuer().issue({ credential: value, idempotencyKey: 'a23-lock-1',
      requestFingerprint: 'a23-lock-1-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN });
    assert.equal(first.state, 'issued');
    if (first.state !== 'issued') throw new Error('lock-order issue denied');
    const firstRow = await isolated.runtime.pool.query<{ policy_revision: string; lease_generation: string }>(
      `select policy_revision, lease_generation::text from sync_sessions where session_id=$1`,
      [first.session.sessionId]);
    const cursor = await seedExpiredAckCursor(first.session.sessionId, replica.replicaId,
      firstRow.rows[0]!.lease_generation, firstRow.rows[0]!.policy_revision);

    const ack = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 3_600, maxLeaseLifetimeSeconds: 86_400 });
    const holdingLease = deferred();
    const releaseLease = deferred();
    const facts = await replicaFacts(replica.replicaId);
    const renewal = issuer(900, {
      async afterPhase(phase) {
        if (phase !== 'lease') return;
        holdingLease.resolve();
        await releaseLease.promise;
      },
    }).issue({ credential: value, idempotencyKey: 'a23-lock-2',
      requestFingerprint: 'a23-lock-2-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: facts.leaseGeneration, expectedLifecycleRevision: facts.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN });
    await holdingLease.promise;

    const ackAttempt = ack.acknowledge({ credential: value, idempotencyKey: 'a23-lock-ack',
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: first.session.sessionId, cursor, warnings: [] },
    }).then(() => 'acked' as const, (error: unknown) => error);
    try {
      // Renewal is paused after loadAuthority updated the Replica. If the
      // Session were not already locked, the Ack would acquire it and then
      // wait on the account/gate/replica rows the renewal holds: a real
      // session-vs-authority cycle. It must instead wait on the Session row.
      let wait: Awaited<ReturnType<typeof sessionLockWait>> = undefined;
      await waitForCondition(async () => {
        wait = await sessionLockWait();
        return wait !== undefined;
      }, {
        timeoutMs: 15_000, pollIntervalMs: 10,
        description: 'the concurrent Ack to wait on the renewal transaction',
      });
      assert.equal(wait?.blockerLocksSession, true,
        'issuance must hold the Session lock before account/credential/gate/replica');
      assert.deepEqual(wait?.waiterTupleRelations, ['sync_sessions'],
        'the Ack must wait on the Session row, not on a later authority lock');
      releaseLease.resolve();
      const [issuedRenewal, ackResult] = await Promise.all([renewal, ackAttempt]);
      assert.equal(issuedRenewal.state, 'issued');
      if (issuedRenewal.state !== 'issued') throw new Error('renewal denied');
      assert.ok(ackResult instanceof SyncAckError, `Ack must be denied, got ${String(ackResult)}`);
      assert.equal(ackResult.code, 'resource_not_found',
        'the superseded Session is durably terminated, not a deadlock victim');
      assert.equal((await sessionRow(first.session.sessionId))?.status, 'terminated');
      assert.equal((await sessionRow(issuedRenewal.session.sessionId))?.status, 'active');
    } finally {
      releaseLease.resolve();
      await Promise.allSettled([renewal, ackAttempt]);
    }
  }, 60_000);

  test('renewal takes the Session lock before the account prefix, so a concurrent snapshot GET cannot deadlock', async () => {
    const value = await credential('get-lock');
    const replica = await createReplica('get-lock');
    const first = await issuer().issue({ credential: value, idempotencyKey: 'a23-get-lock-1',
      requestFingerprint: 'a23-get-lock-1-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:bootstrap', 'sync:pull'], origin: ORIGIN });
    assert.equal(first.state, 'issued');
    if (first.state !== 'issued') throw new Error('get-lock issue denied');
    const holdingLease = deferred();
    const releaseLease = deferred();
    const facts = await replicaFacts(replica.replicaId);
    const renewal = issuer(900, {
      async afterPhase(phase) {
        if (phase !== 'lease') return;
        holdingLease.resolve();
        await releaseLease.promise;
      },
    }).issue({ credential: value, idempotencyKey: 'a23-get-lock-2',
      requestFingerprint: 'a23-get-lock-2-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: facts.leaseGeneration, expectedLifecycleRevision: facts.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:bootstrap', 'sync:pull'], origin: ORIGIN });
    await holdingLease.promise;

    const getAttempt = snapshotGet().listOpenConflicts({ origin: ORIGIN, credential: value,
      sessionId: first.session.sessionId, snapshotId: 'snap_a23_get_lock_probe', offset: 0, limit: 10,
    }).then(() => 'read' as const, (error: unknown) => error);
    try {
      let wait: Awaited<ReturnType<typeof sessionLockWait>> = undefined;
      await waitForCondition(async () => {
        wait = await sessionLockWait();
        return wait !== undefined;
      }, {
        timeoutMs: 15_000, pollIntervalMs: 10,
        description: 'the concurrent snapshot GET to wait on the renewal transaction',
      });
      assert.equal(wait?.blockerLocksSession, true,
        'issuance must hold the Session lock before account/credential/gate/replica');
      assert.deepEqual(wait?.waiterTupleRelations, ['sync_sessions'],
        'the GET must wait on the Session row, not on a later authority lock');
      releaseLease.resolve();
      const [issuedRenewal, getResult] = await Promise.all([renewal, getAttempt]);
      assert.equal(issuedRenewal.state, 'issued');
      if (issuedRenewal.state !== 'issued') throw new Error('get-lock renewal denied');
      assert.ok(getResult instanceof SyncBootstrapSnapshotError,
        `the superseded Session must be denied, got ${String(getResult)}`);
      assert.ok(getResult.code === 'resource_not_found' || getResult.code === 'snapshot_expired');
      assert.equal((await sessionRow(first.session.sessionId))?.status, 'terminated');
      assert.equal((await sessionRow(issuedRenewal.session.sessionId))?.status, 'active');
    } finally {
      releaseLease.resolve();
      await Promise.allSettled([renewal, getAttempt]);
    }
  }, 60_000);

  test('the sweeper terminates lapsed active Sessions and the next pass reclaims them', async () => {
    const value = await credential('expiry-sweep');
    const replica = await createReplica('expiry-sweep');
    const issued = await issuer(1).issue({ credential: value, idempotencyKey: 'a23-sweep-1',
      requestFingerprint: 'a23-sweep-1-fp', collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN });
    assert.equal(issued.state, 'issued');
    if (issued.state !== 'issued') throw new Error('sweep issue denied');
    await isolated.runtime.pool.query('select pg_sleep(1.05)');

    await coordinator().runBatch();
    const lapsed = await sessionRow(issued.session.sessionId);
    assert.equal(lapsed?.status, 'terminated');
    assert.equal(lapsed?.termination_reason, 'lease_expired');
    assert.ok(lapsed?.terminated_at instanceof Date);
    assert.equal(await terminatedAuditCount(issued.session.sessionId), 1);

    const cleaned = await coordinator().runBatch({ now: new Date(lapsed!.terminated_at!.getTime() + 2 * GRACE_MS) });
    assert.ok(cleaned.deleted >= 4, `expected lapsed Session reclamation, got ${cleaned.deleted}`);
    assert.equal(await sessionRow(issued.session.sessionId), undefined);
  }, 60_000);
});

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
