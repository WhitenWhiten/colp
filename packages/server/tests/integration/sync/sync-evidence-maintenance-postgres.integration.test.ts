import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  PostgresSyncEvidenceMaintenanceCoordinator,
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import type { SyncEvidenceMaintenanceFaultPhase } from '../../../src/modules/sync/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ACCOUNT = 'r15-account';
const SUBJECT = 'r15-subject';
const COLLECTION = 'r15-collection';
const OIDC_SUBJECT = 'r15-oidc';
// Fixed "now" for maintenance runs, comfortably in the past relative to real DB
// time so trigger-side current_timestamp comparisons also treat rows as expired.
const BASE_TIME = new Date('2026-07-26T12:00:00.000Z');
const MIGRATION_NAME = '202608020100_sync_evidence_maintenance';
const PREVIOUS_STABLE_MIGRATION = '202608011200_search_member_recall_indexes';
const CLEANUP_INDEX = 'sync_pull_cursor_evidence_cleanup_idx';

interface SessionRow {
  readonly session_id: string;
  readonly account_id: string;
  readonly collection_id: string;
  readonly replica_id: string;
  readonly lease_generation: string;
  readonly policy_revision: string;
  readonly lifecycle_revision: string;
}

describeWithPostgres('R15 global evidence/proof maintenance worker', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('r15_evidence_maintenance', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('r15-identity',$1,$2,$3)`, [ACCOUNT, ISSUER, OIDC_SUBJECT]);
      await client.query("insert into profile_handles(handle,account_id) values ('sync_r15',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),('r15-root','node')`, [COLLECTION]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'R15 collection','bookmarks','r15-root','collection-r1','content-r1','policy-r1')`,
      [COLLECTION, SUBJECT]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('r15-root',$1,'folder',true,'Root','root-r1','children-r1')`, [COLLECTION]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }, 30_000);

  afterAll(async () => isolated?.close());

  async function indexPresent(runtime: IsolatedPostgresRuntime, indexName: string): Promise<boolean> {
    const rows = await runtime.runtime.pool.query(
      'select 1 from pg_indexes where schemaname=current_schema() and indexname=$1', [indexName]);
    return rows.rowCount === 1;
  }

  test('the expand migration adds the expiry-first cleanup index and rolls back cleanly', async () => {
    const upgrade = await createIsolatedPostgresRuntime('r15_evidence_maintenance_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;
      assert.equal(await indexPresent(upgrade, CLEANUP_INDEX), false, 'cleanup index must not exist before R15');

      const latest = await migrator.migrateTo(MIGRATION_NAME);
      if (latest.error) throw latest.error;
      assert.equal(await indexPresent(upgrade, CLEANUP_INDEX), true, 'cleanup index must exist after R15');
      const indexes = await upgrade.runtime.pool.query<{ indexdef: string }>(`select indexdef from pg_indexes
        where schemaname=current_schema() and indexname=$1`, [CLEANUP_INDEX]);
      assert.match(indexes.rows[0]!.indexdef,
        /sync_pull_cursor_evidence\s+USING\s+btree\s*\(\s*cursor_expires_at,\s*replica_id\s*\)/u);

      const down = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (down.error) throw down.error;
      assert.equal(await indexPresent(upgrade, CLEANUP_INDEX), false, 'cleanup index must roll back');
      // Evidence + proof tables and their retention triggers survive the down.
      const tables = await upgrade.runtime.pool.query<{ table_name: string }>(`select table_name
        from information_schema.tables where table_schema=current_schema()
          and table_name in ('sync_pull_cursor_evidence','sync_pull_cursor_recovery_proofs')
        order by table_name`);
      assert.deepEqual(tables.rows.map((row) => row.table_name),
        ['sync_pull_cursor_evidence', 'sync_pull_cursor_recovery_proofs']);
      const triggers = await upgrade.runtime.pool.query<{ tgname: string }>(`select tgname from pg_trigger
        where tgrelid in ('sync_pull_cursor_evidence'::regclass,
          'sync_pull_cursor_recovery_proofs'::regclass) and not tgisinternal`);
      assert.deepEqual(triggers.rows.map((row) => row.tgname).sort(),
        ['sync_pull_cursor_evidence_immutable', 'sync_pull_cursor_recovery_proofs_immutable']);
    } finally { await upgrade.close(); }
  }, 120_000);

  async function context(label: string) {
    const credential = await mintVerifiedExtensionCredentialFixture({ issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', subject: OIDC_SUBJECT, credentialId: `r15-credential-${label}` });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `r15-device-${label}`, replicaId: () => `r15-replica-${label}`,
      leaseId: () => `r15-lease-${label}`,
    } }).create({ accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'R15 device',
      replicaName: 'R15 replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `r15-profile-${label}`, mountMode: 'whole-profile',
        browserGeneration: `r15-generation-${label}` }, leaseDurationSeconds: 3_600 },
    { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: ISSUER,
      audience: 'known-api', clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 71),
      replayEncryptionKeyVersion: 1, sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
    const issued = await issuer.issue({ credential, idempotencyKey: `r15-session-key-${label}`,
      requestFingerprint: `r15-session-fingerprint-${label}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN });
    assert.equal(issued.state, 'issued');
    if (issued.state !== 'issued') throw new Error('session denied');
    const row = await isolated.runtime.pool.query<SessionRow>(`select session_id,account_id,collection_id,
      replica_id,lease_generation,policy_revision,lifecycle_revision from sync_sessions
      where session_id=$1`, [issued.session.sessionId]);
    return { credential, replica: { replicaId: replica.replicaId, leaseGeneration: replica.leaseGeneration,
      lifecycleRevision: replica.lifecycleRevision },
      sessionId: issued.session.sessionId, session: row.rows[0]! };
  }

  function digest(cursor: string): string {
    return createHash('sha256').update(cursor, 'utf8').digest('hex');
  }

  async function seedEvidence(value: Awaited<ReturnType<typeof context>>, label: string,
    cursor: string, expiresAt: Date) {
    const issuedAt = new Date(expiresAt.getTime() - 60_000);
    const result = await isolated.runtime.pool.query<{ evidence_id: string }>(`insert into sync_pull_cursor_evidence
      (cursor,cursor_digest,session_id,account_id,collection_id,replica_id,lease_generation,
       policy_revision,protocol_version,tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,
       cursor_expires_at,issued_at,upper_commit_ordinal,upper_stream_kind,upper_stable_id,
       collection_revision,page_limit,purge_commit_ordinal,purge_stream_kind,purge_stable_id)
      values ($1,$2,$3,$4,$5,$6,$7,'policy-r1','0.1',0,0,'', $8,$9,0,0,'','content-r1',100,0,0,'')
      returning evidence_id`,
    [cursor, digest(cursor), value.sessionId, ACCOUNT, COLLECTION, value.replica.replicaId,
      BigInt(value.replica.leaseGeneration), expiresAt, issuedAt]);
    return { evidenceId: result.rows[0]!.evidence_id, cursorDigest: digest(cursor), cursor };
  }

  async function seedAck(value: Awaited<ReturnType<typeof context>>, evidence: { cursorDigest: string },
    label: string) {
    await isolated.runtime.pool.query(`insert into sync_ack_receipts
      (principal_id,idempotency_key,request_digest,session_id,collection_id,replica_id,lease_generation,
       cursor_digest,result_json,result_digest,claimed_at,completed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,$9,$10,$11)`,
    [ACCOUNT, `r15-ack-${label}`, 'a'.repeat(64), value.sessionId, COLLECTION,
      value.replica.replicaId, BigInt(value.replica.leaseGeneration), evidence.cursorDigest,
      'b'.repeat(64), new Date('2026-07-26T10:00:00.000Z'), new Date('2026-07-26T10:00:01.000Z')]);
  }

  async function seedProof(value: Awaited<ReturnType<typeof context>>, label: string,
    cursor: string, proofExpiresAt: Date, consumedAt?: Date) {
    const issuedAt = new Date(proofExpiresAt.getTime() - 7_200_000);
    const cursorExpiresAt = new Date(proofExpiresAt.getTime() - 3_600_000);
    const result = await isolated.runtime.pool.query<{ proof_id: string }>(`insert into sync_pull_cursor_recovery_proofs
      (cursor_digest,authority_session_id,authority_lifecycle_revision,account_id,collection_id,
       replica_id,lease_generation,policy_revision,protocol_version,page_limit,
       tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,upper_commit_ordinal,upper_stream_kind,
       upper_stable_id,purge_commit_ordinal,purge_stream_kind,purge_stable_id,cursor_expires_at,
       proof_expires_at,issued_at,consumed_at)
      values ($1,$2,$3,$4,$5,$6,$7,'policy-r1','0.1',100,
       0,0,'',1,0,'upper-stable',0,0,'',$8,$9,$10,$11)
      returning proof_id`,
    [digest(cursor), value.sessionId, BigInt(value.session.lifecycle_revision), ACCOUNT, COLLECTION,
      value.replica.replicaId, BigInt(value.replica.leaseGeneration),
      cursorExpiresAt, proofExpiresAt, issuedAt, consumedAt ?? null]);
    return { proofId: result.rows[0]!.proof_id, cursorDigest: digest(cursor) };
  }

  function coordinator(worker = randomUUID(), batchSize = 500,
    faultInjector?: { afterPhase(phase: SyncEvidenceMaintenanceFaultPhase): Promise<void> }) {
    return new PostgresSyncEvidenceMaintenanceCoordinator(isolated.runtime.db, {
      workerId: worker, batchSize, leaseDurationMs: 30_000, faultInjector,
    });
  }

  test('globally sweeps expired proofs and evidence across multiple replicas with no Pull involved', async () => {
    const a = await context('global-a');
    const b = await context('global-b');
    const aEvidence = await seedEvidence(a, 'global-a-evidence', 'global-a-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    const bEvidence = await seedEvidence(b, 'global-b-evidence', 'global-b-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    const aProof = await seedProof(a, 'global-a-proof', 'global-a-proof-cursor',
      new Date(BASE_TIME.getTime() - 1_800_000));
    const bProof = await seedProof(b, 'global-b-proof', 'global-b-proof-cursor',
      new Date(BASE_TIME.getTime() - 1_800_000));
    // A not-yet-expired evidence row must be untouched and not attempted.
    const liveEvidence = await seedEvidence(a, 'global-a-live', 'global-a-live-cursor',
      new Date(BASE_TIME.getTime() + 3_600_000));

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 4);
    assert.equal(result.deleted, 4);
    assert.equal(result.redacted, 0);
    assert.equal(result.skipped, 0);

    for (const evidenceId of [aEvidence.evidenceId, bEvidence.evidenceId]) {
      const row = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
        [evidenceId]);
      assert.equal(row.rowCount, 0);
    }
    for (const proofId of [aProof.proofId, bProof.proofId]) {
      const row = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_recovery_proofs where proof_id=$1',
        [proofId]);
      assert.equal(row.rowCount, 0);
    }
    const live = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
      [liveEvidence.evidenceId]);
    assert.equal(live.rowCount, 1);
  });

  test('expired evidence referenced by an Ack receipt is skipped, never deleted or redacted', async () => {
    const value = await context('ack-protected');
    const evidence = await seedEvidence(value, 'ack-protected-evidence', 'ack-protected-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    await seedAck(value, evidence, 'protected');

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 1);
    assert.equal(result.deleted, 0);
    assert.equal(result.redacted, 0);
    assert.equal(result.skipped, 1);

    const row = await isolated.runtime.pool.query<{ cursor: string | null }>(
      'select cursor from sync_pull_cursor_evidence where evidence_id=$1', [evidence.evidenceId]);
    assert.equal(row.rows[0]?.cursor, evidence.cursor);
    // Redact the leftover cursor so this ack-protected row stops being a candidate
    // for later runs (the retention trigger permits the expiry redaction).
    await isolated.runtime.pool.query(
      'update sync_pull_cursor_evidence set cursor=null where evidence_id=$1', [evidence.evidenceId]);
  });

  test('expired checkpoint-referenced evidence is only redacted, keeping digest and tuple authority', async () => {
    const value = await context('checkpoint-protected');
    const evidence = await seedEvidence(value, 'checkpoint-evidence', 'checkpoint-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    await isolated.runtime.pool.query(`update sync_replicas set
      checkpoint_cursor=$2, checkpoint_commit_ordinal=100, checkpoint_stream_kind=0,
      checkpoint_stable_id='checkpoint-stable' where replica_id=$1`,
    [value.replica.replicaId, evidence.cursor]);

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 1);
    assert.equal(result.deleted, 0);
    assert.equal(result.redacted, 1);
    assert.equal(result.skipped, 0);

    const row = await isolated.runtime.pool.query<{ cursor: string | null; cursor_digest: string;
      tuple_commit_ordinal: string; tuple_stable_id: string }>(
      'select cursor, cursor_digest, tuple_commit_ordinal, tuple_stable_id from sync_pull_cursor_evidence where evidence_id=$1',
      [evidence.evidenceId]);
    assert.equal(row.rows[0]?.cursor, null);
    assert.equal(row.rows[0]?.cursor_digest, evidence.cursorDigest);
    assert.equal(row.rows[0]?.tuple_stable_id, '');
    assert.equal(row.rows[0]?.tuple_commit_ordinal, '0');
  });

  test('evidence and proofs under retired or recovery-required replicas are swept even before expiry', async () => {
    const retired = await context('retired');
    const recovery = await context('recovery');
    const retiredEvidence = await seedEvidence(retired, 'retired-evidence', 'retired-cursor',
      new Date(BASE_TIME.getTime() + 3_600_000));
    const recoveryEvidence = await seedEvidence(recovery, 'recovery-evidence', 'recovery-cursor',
      new Date(BASE_TIME.getTime() + 3_600_000));
    const retiredProof = await seedProof(retired, 'retired-proof', 'retired-proof-cursor',
      new Date(BASE_TIME.getTime() + 3_600_000));
    await isolated.runtime.pool.query(`update sync_replicas set status='retired',
      retired_at=current_timestamp,
      wire_json=jsonb_set(wire_json,'{status}','"retired"') where replica_id=$1`, [retired.replica.replicaId]);
    await isolated.runtime.pool.query(`update sync_replicas set status='recovery_required',
      wire_json=jsonb_set(wire_json,'{status}','"recovery_required"') where replica_id=$1`,
    [recovery.replica.replicaId]);

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 3);
    assert.equal(result.deleted, 3);
    assert.equal(result.redacted, 0);
    assert.equal(result.skipped, 0);
    for (const evidenceId of [retiredEvidence.evidenceId, recoveryEvidence.evidenceId]) {
      const row = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
        [evidenceId]);
      assert.equal(row.rowCount, 0);
    }
    const proof = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_recovery_proofs where proof_id=$1',
      [retiredProof.proofId]);
    assert.equal(proof.rowCount, 0);
  });

  test('consumed recovery proofs are deleted even before expiry', async () => {
    const value = await context('consumed');
    const consumed = await seedProof(value, 'consumed-proof', 'consumed-proof-cursor',
      new Date(BASE_TIME.getTime() + 3_600_000), new Date(BASE_TIME.getTime() - 1_800_000));

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 1);
    assert.equal(result.deleted, 1);
    const row = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_recovery_proofs where proof_id=$1',
      [consumed.proofId]);
    assert.equal(row.rowCount, 0);
  });

  test('a row locked by another transaction is skipped while the rest of the batch is swept', async () => {
    const value = await context('lock');
    const locked = await seedEvidence(value, 'locked-evidence', 'locked-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    const unlocked = await seedEvidence(value, 'unlocked-evidence', 'unlocked-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('select evidence_id from sync_pull_cursor_evidence where evidence_id=$1 for update',
        [locked.evidenceId]);
      const result = await coordinator(randomUUID(), 10).runBatch({ now: BASE_TIME });
      assert.equal(result.attempted, 1);
      assert.equal(result.deleted, 1);
      const still = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
        [locked.evidenceId]);
      assert.equal(still.rowCount, 1);
      const gone = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
        [unlocked.evidenceId]);
      assert.equal(gone.rowCount, 0);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    // Once the lock is released the previously locked row becomes a candidate again.
    const second = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(second.attempted, 1);
    assert.equal(second.deleted, 1);
  });

  test('two concurrent workers partition the batch via SKIP LOCKED and never double-process', async () => {
    const value = await context('concurrent');
    const seeded = [];
    for (let index = 0; index < 6; index += 1) {
      seeded.push(await seedEvidence(value, `concurrent-${index}`, `concurrent-cursor-${index}`,
        new Date(BASE_TIME.getTime() - 3_600_000)));
    }
    // Barrier at candidates_selected fixes the interleaving: both workers hold their
    // SKIP LOCKED rows before either commits, so neither can observe the other's rows.
    let reached = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async () => {
      reached += 1;
      if (reached === 2) release();
      await gate;
    };
    const a = coordinator('concurrent-worker-a', 3, {
      afterPhase: async (phase) => { if (phase === 'candidates_selected') await barrier(); },
    });
    const b = coordinator('concurrent-worker-b', 3, {
      afterPhase: async (phase) => { if (phase === 'candidates_selected') await barrier(); },
    });
    const [aResult, bResult] = await Promise.all([
      a.runBatch({ now: BASE_TIME }), b.runBatch({ now: BASE_TIME }),
    ]);
    assert.equal(aResult.attempted + bResult.attempted, 6);
    assert.equal(aResult.deleted + bResult.deleted, 6);
    assert.equal(aResult.deleted + aResult.redacted + aResult.skipped, aResult.attempted);
    assert.equal(bResult.deleted + bResult.redacted + bResult.skipped, bResult.attempted);
    // Only evidence rows the worker still considers candidates (cursor intact).
    // Redacted rows retained for Ack/checkpoint authority keep cursor=NULL.
    const remaining = await isolated.runtime.pool.query(
      'select count(*)::int as count from sync_pull_cursor_evidence where cursor is not null and cursor_expires_at <= $1', [BASE_TIME]);
    assert.equal(remaining.rows[0]?.count, 0);
    for (const item of seeded) {
      const row = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
        [item.evidenceId]);
      assert.equal(row.rowCount, 0);
    }
  });

  test('the retention triggers reject premature deletion and redaction of unexpired evidence', async () => {
    const value = await context('trigger');
    // Seed genuinely unexpired rows (relative to the real DB clock) so the
    // retention triggers reject the direct mutations; the worker's BASE_TIME
    // override still keeps them out of the candidate set.
    const futureExpiry = new Date(Date.now() + 3_600_000);
    const evidence = await seedEvidence(value, 'trigger-evidence', 'trigger-cursor', futureExpiry);
    const proof = await seedProof(value, 'trigger-proof', 'trigger-proof-cursor', futureExpiry);
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_pull_cursor_evidence where evidence_id=$1', [evidence.evidenceId]),
    /immutable outside bounded expiry cleanup/u);
    await assert.rejects(isolated.runtime.pool.query(
      'update sync_pull_cursor_evidence set cursor=null where evidence_id=$1', [evidence.evidenceId]),
    /immutable outside bounded expiry cleanup/u);
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_pull_cursor_recovery_proofs where proof_id=$1', [proof.proofId]),
    /immutable outside consumption and cleanup/u);

    // The worker never even attempts unexpired rows.
    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 0);
    assert.equal(result.deleted, 0);
    const row = await isolated.runtime.pool.query<{ cursor: string | null }>(
      'select cursor from sync_pull_cursor_evidence where evidence_id=$1', [evidence.evidenceId]);
    assert.equal(row.rows[0]?.cursor, evidence.cursor);
    assert.equal((await isolated.runtime.pool.query('select 1 from sync_pull_cursor_recovery_proofs where proof_id=$1',
      [proof.proofId])).rowCount, 1);
  });

  test('repeated runs are idempotent after the first sweep', async () => {
    const value = await context('idempotent');
    await seedEvidence(value, 'idempotent-evidence', 'idempotent-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    await seedProof(value, 'idempotent-proof', 'idempotent-proof-cursor',
      new Date(BASE_TIME.getTime() - 1_800_000));

    const first = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(first.attempted, 2);
    assert.equal(first.deleted, 2);

    const second = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(second.attempted, 0);
    assert.equal(second.deleted, 0);
    assert.equal(second.oldestExpiredAgeMs, 0);
  });

  test('batchSize caps the candidate rows processed in one run', async () => {
    const value = await context('batch');
    for (let index = 0; index < 5; index += 1) {
      await seedEvidence(value, `batch-${index}`, `batch-cursor-${index}`,
        new Date(BASE_TIME.getTime() - 3_600_000));
    }
    const first = await coordinator(randomUUID(), 3).runBatch({ now: BASE_TIME });
    assert.equal(first.attempted, 3);
    assert.equal(first.deleted, 3);
    const second = await coordinator(randomUUID(), 3).runBatch({ now: BASE_TIME });
    assert.equal(second.attempted, 2);
    assert.equal(second.deleted, 2);
  });

  test('oldestExpiredAgeMs measures the oldest remaining expired candidate with DB time', async () => {
    const value = await context('age');
    // Expired, ack-protected evidence stays behind after the run (2h old at BASE_TIME).
    const evidence = await seedEvidence(value, 'age-evidence', 'age-cursor',
      new Date(BASE_TIME.getTime() - 7_200_000));
    await seedAck(value, evidence, 'age-protected');
    // A 4h-old proof is deleted this run and must not dominate the gauge afterwards.
    await seedProof(value, 'age-proof', 'age-proof-cursor',
      new Date(BASE_TIME.getTime() - 14_400_000));

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.attempted, 2);
    assert.equal(result.deleted, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.oldestExpiredAgeMs, 7_200_000);
    // Redact the leftover cursor so this ack-protected row stops being a candidate
    // for later runs (the retention trigger permits the expiry redaction).
    await isolated.runtime.pool.query(
      'update sync_pull_cursor_evidence set cursor=null where evidence_id=$1', [evidence.evidenceId]);
  });

  test('a run with real database time sweeps rows expired relative to current_timestamp', async () => {
    const value = await context('real-time');
    const inserted = await isolated.runtime.pool.query<{ evidence_id: string }>(`insert into sync_pull_cursor_evidence
      (cursor,cursor_digest,session_id,account_id,collection_id,replica_id,lease_generation,
       policy_revision,protocol_version,tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,
       cursor_expires_at,issued_at,upper_commit_ordinal,upper_stream_kind,upper_stable_id,
       collection_revision,page_limit,purge_commit_ordinal,purge_stream_kind,purge_stable_id)
      values ($1,$2,$3,$4,$5,$6,$7,'policy-r1','0.1',0,0,'',
        current_timestamp - interval '1 hour', current_timestamp - interval '2 hours',0,0,'',
        'content-r1',100,0,0,'')
      returning evidence_id`,
    ['real-time-cursor', digest('real-time-cursor'), value.sessionId, ACCOUNT, COLLECTION,
      value.replica.replicaId, BigInt(value.replica.leaseGeneration)]);
    // No now override: the run derives authoritative time from the database clock.
    const run = await coordinator().runBatch();
    // Earlier tests leave BASE_TIME-expired rows (e.g. redacted ack/checkpoint
    // evidence) that the real-time sweep legitimately deletes too, so assert at
    // least this test's own row is swept and that it is gone.
    assert.ok(run.deleted >= 1, 'the real-time run must sweep expired rows');
    const row = await isolated.runtime.pool.query('select 1 from sync_pull_cursor_evidence where evidence_id=$1',
      [inserted.rows[0]!.evidence_id]);
    assert.equal(row.rowCount, 0);
  });

  test('a fault at any write phase rolls back the entire maintenance transaction', async () => {
    const value = await context('fault');
    const evidence = await seedEvidence(value, 'fault-evidence', 'fault-cursor',
      new Date(BASE_TIME.getTime() - 3_600_000));
    const proof = await seedProof(value, 'fault-proof', 'fault-proof-cursor',
      new Date(BASE_TIME.getTime() - 1_800_000));

    await assert.rejects(coordinator(randomUUID(), 500, {
      afterPhase: async (phase) => { if (phase === 'evidence_deleted') throw new Error('fault:evidence_deleted'); },
    }).runBatch({ now: BASE_TIME }), /fault:evidence_deleted/u);

    assert.equal((await isolated.runtime.pool.query(
      'select 1 from sync_pull_cursor_evidence where evidence_id=$1', [evidence.evidenceId])).rowCount, 1);
    assert.equal((await isolated.runtime.pool.query(
      'select 1 from sync_pull_cursor_recovery_proofs where proof_id=$1', [proof.proofId])).rowCount, 1);

    const result = await coordinator().runBatch({ now: BASE_TIME });
    assert.equal(result.deleted, 2);
  });

  test('the cleanup index bounds the expiry-first evidence candidate scan at production scale', async () => {
    const value = await context('plan-scale');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      // Production-scale volume: 10,000 unexpired rows (steady state) plus 25
      // expired rows, so the expiry-first sweep is selective and the planner
      // must prefer the cleanup index over a full scan when free to choose.
      const inserted = await client.query(`insert into sync_pull_cursor_evidence
        (cursor,cursor_digest,session_id,account_id,collection_id,replica_id,lease_generation,
         policy_revision,protocol_version,tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,
         cursor_expires_at,issued_at,upper_commit_ordinal,upper_stream_kind,upper_stable_id,
         collection_revision,page_limit,purge_commit_ordinal,purge_stream_kind,purge_stable_id)
        select 'plan-scale-'||g, md5('plan-scale-'||g)||md5('plan-scale-'||g), $1,$2,$3,$4,$5::bigint,
          'policy-r1','0.1',0,0,'', current_timestamp + interval '30 days',
          current_timestamp - interval '1 day', 0,0,'','content-r1',100,0,0,''
        from generate_series(1, 10000) as g
        union all
        select 'plan-scale-expired-'||g, md5('plan-scale-expired-'||g)||md5('plan-scale-expired-'||g),
          $1,$2,$3,$4,$5::bigint, 'policy-r1','0.1',0,0,'', current_timestamp - interval '1 hour',
          current_timestamp - interval '1 day', 0,0,'','content-r1',100,0,0,''
        from generate_series(1, 25) as g`,
      [value.sessionId, ACCOUNT, COLLECTION, value.replica.replicaId, BigInt(value.replica.leaseGeneration)]);
      assert.equal(inserted.rowCount, 10_025);
      await client.query('analyze sync_pull_cursor_evidence');
      const plan = await client.query<{ 'QUERY PLAN': string }>(`explain
        select evidence_id from sync_pull_cursor_evidence
        where cursor is not null and cursor_expires_at <= current_timestamp
        order by cursor_expires_at, evidence_id limit 10`);
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.match(text, /sync_pull_cursor_evidence_cleanup_idx/u);
      assert.doesNotMatch(text, /Seq Scan/u);
      await client.query('rollback');
    } finally { client.release(); }
  });
});
