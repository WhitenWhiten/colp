/**
 * P4A-I14 PostgreSQL integration suite: the production cleanup coordinator
 * (`runCleanupBatch`) over the PRODUCTION migration with a recording
 * object store.
 *
 * Proves, against real PostgreSQL (production migration chain to latest):
 *  - retired cleanup deletes ONLY the exact retired key and preserves the
 *    active marker bytes; the generation/tombstone/audit rows are retained;
 *  - initially-missing converges to confirmed-absent with ZERO DELETE;
 *  - same-key candidate mismatch quarantines with ZERO DELETE and the
 *    permanent key tombstone rejects reissue (SQLSTATE 23505);
 *  - two cleanup owners: lease expiry takeover bumps the lease generation and
 *    the late owner's CAS fails (lease_lost); a converged run sends no
 *    duplicate DELETE;
 *  - the crash matrix (before/after HEAD, before/after DELETE, after confirm,
 *    before complete CAS) restarts the coordinator until convergence; every
 *    crash point leaves the exact retired key absent, the active marker
 *    unchanged, and the deletion evidence committed;
 *  - commit-response-lost re-reads the DATABASE and decides committed_deleted;
 *  - allocated -> orphan late-upload reconciliation after intent expiry;
 *  - active/attached-private bodies are never touched (finalize-holds-lock ->
 *    cleanup claim blocked -> after commit only the retired generation is
 *    claimable);
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork, DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import {
  runCleanupBatch,
  type GenerationObjectHandle,
  type GenerationObjectStorePort,
  type RunCleanupBatchInput,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  RecordingObjectStore,
  createI07MigrationRuntime,
  i07Uow,
  identityFor,
  keyFor,
  makeBucket,
  sha256Hex,
  uuidFor,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  finalizeHandoffInTx,
  i13HandoffInput,
  onBlob,
  seedStoredPrivateWithRetired,
} from '../../support/phase4a-i13-test-helpers.js';
import {
  cleanupCrash,
  i14Uow,
  makeI14Config,
  type InMemoryCleanupTx,
} from '../../support/phase4a-i14-test-helpers.js';

const ports = createPostgresAttachmentsPorts();

const I14_CONFIG = makeI14Config({
  retention: { intentRetentionHours: 1, storedRetentionDays: 1, retiredRetentionDays: 1 },
  cleanupBatchSize: 10,
  cleanup: { leaseMs: 60_000, retryCount: 0 },
});

type I14Tx = InMemoryCleanupTx;

/** Wraps the I07 recording store into the module GenerationObjectStorePort. */
function toGenerationStore(store: RecordingObjectStore): GenerationObjectStorePort {
  return {
    async headExact(handle: GenerationObjectHandle) {
      const out = await store.head({ bucket: 'known-i14', key: handle.key });
      if (out.class === 'ok') {
        return { class: 'ok', identity: { generationId: handle.generationId, etag: out.etag, size: out.size, metadata: {} } };
      }
      if (out.class === 'not_found') return { class: 'not_found' };
      if (out.class === 'denied') return { class: 'denied' };
      if (out.class === 'retryable') return { class: 'retryable' };
      return { class: 'unknown' };
    },
    async readBounded() { throw new Error('cleanup never reads bodies'); },
    async deleteExact(handle: GenerationObjectHandle) {
      const out = await store.deleteExactKey({ bucket: 'known-i14', key: handle.key });
      if (out.class === 'deleted') return { class: 'deleted' };
      if (out.class === 'not_found') return { class: 'not_found' };
      if (out.class === 'denied') return { class: 'denied' };
      if (out.class === 'retryable') return { class: 'retryable' };
      return { class: 'unknown' };
    },
    async confirmAbsent(handle: GenerationObjectHandle) {
      const out = await store.head({ bucket: 'known-i14', key: handle.key });
      return { absent: out.class === 'not_found' };
    },
  };
}

function coordinator(
  runtime: I07MigrationRuntime['runtime'],
  store: RecordingObjectStore,
  overrides: Partial<RunCleanupBatchInput<I14Tx>> = {},
): RunCleanupBatchInput<I14Tx> {
  return {
    ledger: ports,
    objectStore: toGenerationStore(store),
    config: I14_CONFIG,
    uow: i14Uow(runtime),
    leaseOwner: 'cleaner',
    ...overrides,
  };
}

const BYTES_OLD = new TextEncoder().encode('retired-bytes-marker-old-i14');
const BYTES_NEW = new TextEncoder().encode('active-bytes-marker-new-i14');

async function seedRetiredBlob(
  runtime: I07MigrationRuntime['runtime'],
  old: ReturnType<typeof identityFor>,
  next: ReturnType<typeof identityFor>,
  store: RecordingObjectStore,
): Promise<void> {
  store.seed(old.key, BYTES_OLD);
  store.seed(next.key, BYTES_NEW);
  const uow = i07Uow(runtime);
  await uow.execute(async (tx) => {
    await ports.allocate(tx, {
      blobId: old.blobId, intentId: old.intentId, generationId: old.generationId,
      principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
      bucket: makeBucket(), key: old.key, keyFingerprint: sha256Hex(old.key),
      expectedSize: BYTES_OLD.byteLength, expectedSha256: 'a'.repeat(64),
      mediaHint: 'application/octet-stream', policyRevision: 'p1',
      idempotencyKey: `idem-${old.intentId}`, expiresAt: new Date(Date.now() + 3_600_000),
    });
    await ports.complete(tx, {
      intentId: old.intentId, generationId: old.generationId, blobId: old.blobId,
      observedEtag: store.etagOf(old.key)!, observedSize: BYTES_OLD.byteLength,
      observedContentType: 'application/octet-stream', observedMetadata: {},
    });
    await ports.allocate(tx, {
      blobId: old.blobId, intentId: next.intentId, generationId: next.generationId,
      principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
      bucket: makeBucket(), key: next.key, keyFingerprint: sha256Hex(next.key),
      expectedSize: BYTES_NEW.byteLength, expectedSha256: 'b'.repeat(64),
      mediaHint: 'application/octet-stream', policyRevision: 'p1',
      idempotencyKey: `idem-${next.intentId}`, expiresAt: new Date(Date.now() + 3_600_000),
    });
    await ports.complete(tx, {
      intentId: next.intentId, generationId: next.generationId, blobId: old.blobId,
      observedEtag: store.etagOf(next.key)!, observedSize: BYTES_NEW.byteLength,
      observedContentType: 'application/octet-stream', observedMetadata: {},
    });
    await ports.activateReplacement(tx, {
      blobId: old.blobId, expectedActiveGenerationId: old.generationId, newGenerationId: next.generationId,
    });
  });
  // Backdate the retention clock so the retired generation is claimable now.
  await runtime.pool.query(
    `update blob_generations set retired_at = now() - interval '2 days' where generation_id = $1`,
    [old.generationId],
  );
}

async function generationRow(runtime: I07MigrationRuntime['runtime'], generationId: string) {
  const result = await sql<{
    generation_state: string; cleanup_attempt_token: string | null; cleanup_lease_owner: string | null;
    cleanup_lease_generation: string; confirmed_absent_at: Date | null; deleted_at: Date | null;
    quarantined_at: Date | null; quarantined_reason: string | null; retired_at: Date | null; orphaned_at: Date | null;
  }>`
    select generation_state, cleanup_attempt_token, cleanup_lease_owner, cleanup_lease_generation::text,
           confirmed_absent_at, deleted_at, quarantined_at, quarantined_reason, retired_at, orphaned_at
    from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `generation ${generationId} must exist`);
  return result.rows[0]!;
}

function expireLease(runtime: I07MigrationRuntime['runtime'], generationId: string): Promise<unknown> {
  return runtime.pool.query(
    `update blob_generations set cleanup_lease_expires_at = now() - interval '1 second' where generation_id = $1`,
    [generationId],
  );
}

function isLockTimeout(error: unknown): boolean {
  return error instanceof DatabaseOperationError && error.kind === 'lock_timeout';
}

describeWithPostgres('P4A-I14 production cleanup coordinator', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i14_cleanup', { maxConnections: 12 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('cleanup deletes only the exact retired key, preserves the active marker, and retains the tombstone', async () => {
    const old = identityFor(1);
    const next = identityFor(2);
    const store = new RecordingObjectStore();
    await seedRetiredBlob(isolated.runtime, old, next, store);

    const result = await runCleanupBatch(coordinator(isolated.runtime, store));
    assert.equal(result.claimed, 1);
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['deleted']);
    assert.deepEqual(store.deletedKeys(), [old.key], 'only the exact retired key may be deleted');
    assert.equal(store.bytesOf(next.key)?.byteLength, BYTES_NEW.byteLength, 'active marker bytes are unchanged');
    assert.equal(store.bytesOf(old.key), undefined, 'retired key is confirmed absent');

    const row = await generationRow(isolated.runtime, old.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.ok(row.confirmed_absent_at, 'deletion evidence (confirmed absent) is recorded');
    assert.ok(row.deleted_at, 'deleted_at is recorded');
    const rows = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from generation_keys where generation_id = $1
       union all select count(*)::text from blob_generations where generation_id = $1
       union all select count(*)::text from upload_intents where generation_id = $1`,
      [old.generationId],
    );
    assert.ok(rows.rows.every((r) => Number(r.count) === 1), 'the permanent key, generation, and intent rows survive cleanup');
  });

  test('initially missing converges to confirmed-absent with ZERO DELETE', async () => {
    const old = identityFor(3);
    const next = identityFor(4);
    const store = new RecordingObjectStore();
    await seedRetiredBlob(isolated.runtime, old, next, store);
    store.objects.delete(old.key); // no object ever uploaded for the retired key

    const result = await runCleanupBatch(coordinator(isolated.runtime, store));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['confirmed_absent']);
    assert.equal(store.deleteCalls.length, 0, 'an already-absent candidate sends no DELETE');
    const row = await generationRow(isolated.runtime, old.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.ok(row.confirmed_absent_at);
  });

  test('same-key candidate mismatch quarantines with ZERO DELETE and the tombstone rejects reissue', async () => {
    const old = identityFor(5);
    const next = identityFor(6);
    const store = new RecordingObjectStore();
    await seedRetiredBlob(isolated.runtime, old, next, store);
    // Same key, DIFFERENT bytes/etag/size (same-key corruption).
    store.seed(old.key, new TextEncoder().encode('corrupt-bytes-different-length'));
    store.objects.get(old.key)!.etag = '"different-etag"';

    const result = await runCleanupBatch(coordinator(isolated.runtime, store));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['quarantined']);
    assert.equal(store.deleteCalls.length, 0, 'identity mismatch sends NO DELETE');
    const row = await generationRow(isolated.runtime, old.generationId);
    assert.equal(row.generation_state, 'quarantined');
    assert.equal(row.quarantined_reason, 'candidate_mismatch');
    assert.ok(row.quarantined_at);

    // Permanent tombstone: the deleted/never-reissued key cannot be rebound.
    let failure: { code?: string } | undefined;
    try {
      await isolated.runtime.pool.query(
        `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
         values ($1, $2, $3, $4, 'allocate')`,
        [`reissue-${old.generationId}`, old.key, sha256Hex(old.key), old.blobId],
      );
    } catch (error) {
      failure = error as { code?: string };
    }
    assert.ok(failure, 'reissuing the same physical key must be rejected');
    assert.equal(failure!.code, '23505', 'the permanent key-uniqueness tombstone rejects reissue (SQLSTATE 23505)');
  });

  test('two cleanup owners: lease expiry takeover bumps the fence; the late owner CAS-fails and no DELETE is duplicated', async () => {
    const old = identityFor(7);
    const next = identityFor(8);
    const store = new RecordingObjectStore();
    await seedRetiredBlob(isolated.runtime, old, next, store);
    const uow = i07Uow(isolated.runtime);

    // Owner A claims with a direct production claim (fence A) and DELETEs.
    const claimA = await uow.execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'owner-a', leaseTtlSeconds: 60, generationId: old.generationId, retiredRetentionDays: 1,
    }));
    assert.equal(claimA.outcome, 'claimed');
    if (claimA.outcome !== 'claimed') return;
    await store.deleteExactKey({ bucket: 'known-i14', key: old.key });

    // The lease expires -> owner B takes over with a HIGHER lease generation.
    await expireLease(isolated.runtime, old.generationId);
    const claimB = await uow.execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'owner-b', leaseTtlSeconds: 60, generationId: old.generationId, retiredRetentionDays: 1,
    }));
    assert.equal(claimB.outcome, 'claimed');
    if (claimB.outcome !== 'claimed') return;
    assert.ok(claimB.claim.leaseGeneration > claimA.claim.leaseGeneration, 'takeover bumps the lease generation');
    assert.notEqual(claimB.claim.attemptToken, claimA.claim.attemptToken, 'takeover issues a fresh attempt token');

    // Owner A's late CAS with the OLD fence must fail (lease_lost) while the
    // row is held by B — the old lease result can never commit.
    const lateA = await uow.execute((tx) => ports.completeCleanup(tx, { claim: claimA.claim, verdict: 'deleted' }));
    assert.equal(lateA.outcome, 'lease_lost');

    // Owner B converges via confirmed HEAD absent (no duplicate DELETE).
    const head = await store.head({ bucket: 'known-i14', key: old.key });
    assert.equal(head.class, 'not_found');
    const completedB = await uow.execute((tx) => ports.completeCleanup(tx, { claim: claimB.claim, verdict: 'deleted' }));
    assert.equal(completedB.outcome, 'completed');
    assert.equal(store.deleteCalls.length, 1, 'no duplicate DELETE across owners');
    const row = await generationRow(isolated.runtime, old.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.ok(row.confirmed_absent_at);
  });

  test('crash matrix: every provider crash point restarts until convergence with the active marker untouched', async () => {
    const crashPoints = [
      'beforeHead', 'afterHead', 'beforeDelete', 'afterDelete', 'afterConfirmHead', 'beforeCompleteCas',
    ] as const;
    for (let index = 0; index < crashPoints.length; index += 1) {
      const crash = crashPoints[index]!;
      const old = identityFor(20 + index * 2);
      const next = identityFor(21 + index * 2);
      const store = new RecordingObjectStore();
      await seedRetiredBlob(isolated.runtime, old, next, store);
      const markerBefore = store.bytesOf(next.key)?.byteLength;

      await assert.rejects(
        runCleanupBatch(coordinator(isolated.runtime, store, {
          leaseOwner: `crash-${crash}`,
          faultInjector: { [crash]: () => cleanupCrash(crash) } as never,
        })),
        new RegExp(`cleanup_crash:${crash}`),
        `${crash} must abort the coordinator`,
      );

      await expireLease(isolated.runtime, old.generationId);
      const restarted = await runCleanupBatch(coordinator(isolated.runtime, store, { leaseOwner: `recover-${crash}` }));
      const kinds = restarted.outcomes.map((o) => o.kind);
      assert.ok(
        kinds.length === 1 && (kinds[0] === 'deleted' || kinds[0] === 'confirmed_absent'),
        `${crash} restart must converge to deleted or confirmed_absent, got ${JSON.stringify(kinds)}`,
      );
      const row = await generationRow(isolated.runtime, old.generationId);
      assert.equal(row.generation_state, 'deleted', `${crash} restart must commit the deletion evidence`);
      assert.equal(store.bytesOf(next.key)?.byteLength, markerBefore, `${crash} must never touch the active marker`);
      assert.equal(store.bytesOf(old.key), undefined, `${crash} restart must leave the retired key confirmed absent`);
      assert.ok(store.deleteCalls.length >= 1 && store.deleteCalls.length <= 2, `${crash} bounds the DELETE retries`);
    }
  });

  test('commit-response-lost re-reads the DATABASE and decides committed_deleted', async () => {
    const old = identityFor(40);
    const next = identityFor(41);
    const store = new RecordingObjectStore();
    await seedRetiredBlob(isolated.runtime, old, next, store);

    // Fire the lost-ack only on the SECOND transaction (completeCleanup CAS);
    // the claim (1st) and the recovery re-read (3rd) must not be faulted.
    let commits = 0;
    const faultUow = {
      async execute<Result>(callback: (context: { transaction: never }) => Promise<Result>): Promise<Result> {
        return createUnitOfWork(isolated.runtime.db, {
          faultInjector: {
            afterCommitAcknowledged: async () => {
              commits += 1;
              if (commits === 2) throw new Error('simulated lost commit acknowledgement');
            },
          },
        }).execute(({ transaction }) => callback({ transaction: transaction as never }));
      },
    };
    const result = await runCleanupBatch(coordinator(isolated.runtime, store, { uow: faultUow as never }));
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.kind, 'commit_unknown');
    if (outcome.kind === 'commit_unknown') {
      assert.equal(outcome.decision, 'committed_deleted', 'the re-read proves the CAS landed despite the lost ack');
    }
    const row = await generationRow(isolated.runtime, old.generationId);
    assert.equal(row.generation_state, 'deleted');
  });

  test('allocated -> orphan late-upload reconciliation after intent expiry, then retention-gated cleanup', async () => {
    const orphan = identityFor(42);
    const uow = i07Uow(isolated.runtime);
    await uow.execute(async (tx) => {
      await ports.allocate(tx, {
        blobId: orphan.blobId, intentId: orphan.intentId, generationId: orphan.generationId,
        principalId: 'principal', collectionId: 'collection', subjectIdentity: 'owner',
        bucket: makeBucket(), key: orphan.key, keyFingerprint: sha256Hex(orphan.key),
        expectedSize: 7, expectedSha256: 'c'.repeat(64), mediaHint: 'application/octet-stream',
        policyRevision: 'p1', idempotencyKey: `idem-${orphan.intentId}`,
        expiresAt: new Date(Date.now() - 3_600_000),
      });
    });
    const store = new RecordingObjectStore();

    // The claim reconciles the expired-intent allocated generation to orphaned
    // (DB-clock orphaned_at) but the fresh orphan is still within retention.
    const first = await runCleanupBatch(coordinator(isolated.runtime, store));
    assert.equal(first.claimed, 0);
    const reconciled = await generationRow(isolated.runtime, orphan.generationId);
    assert.equal(reconciled.generation_state, 'orphaned', 'allocated + expired intent is reconciled to orphaned');
    assert.ok(reconciled.orphaned_at, 'the reconciliation stamps a DB-clock orphaned_at');

    // Backdate the orphan's retention clock: the orphan (no object) is then
    // claimed and confirmed absent with no DELETE.
    await isolated.runtime.pool.query(
      `update blob_generations set orphaned_at = now() - interval '2 days' where generation_id = $1`,
      [orphan.generationId],
    );
    const second = await runCleanupBatch(coordinator(isolated.runtime, store));
    assert.deepEqual(second.outcomes.map((o) => o.kind), ['confirmed_absent']);
    assert.equal(store.deleteCalls.length, 0, 'an orphan with no object sends no DELETE');
  });

  test('active/attached-private is protected: finalize holds the lock, cleanup blocks, then only the retired generation is claimable', async () => {
    const original = identityFor(43);
    const current = identityFor(44);
    const store = new RecordingObjectStore();
    await seedStoredPrivateWithRetired(isolated.runtime, original, current);
    // Bind the recording store to the DB-observed identity facts (etag/size)
    // so the coordinator's conditional HEAD matches exactly.
    const facts = await isolated.runtime.pool.query<{ generation_id: string; etag: string; size: string }>(
      `select generation_id, observed_etag as etag, observed_size::text as size
       from blob_generations where generation_id in ($1, $2)`,
      [original.generationId, current.generationId],
    );
    for (const fact of facts.rows) {
      store.seed(fact.generation_id === original.generationId ? original.key : current.key, new TextEncoder().encode(fact.generation_id));
      const entry = store.objects.get(fact.generation_id === original.generationId ? original.key : current.key)!;
      entry.etag = fact.etag;
      entry.size = Number(fact.size);
    }
    await isolated.runtime.pool.query(
      `update blob_generations set retired_at = now() - interval '2 days' where generation_id = $1`,
      [original.generationId],
    );

    const group = new BarrierGroup();
    const finalizeBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:f`) };
    const finalizePromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, i13HandoffInput(onBlob(original.blobId, current)), { barrier: finalizeBarrier }));
    await group.waitArrived('after_finalize_handoff_lock:f');

    // Cleanup's claim (FOR SHARE on the blob row) blocks on the handoff's
    // FOR UPDATE — deterministic 55P03 proof through the coordinator.
    const lockTimeoutUow = {
      async execute<Result>(callback: (context: { transaction: never }) => Promise<Result>): Promise<Result> {
        return createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
          await sql.raw("SET LOCAL lock_timeout = '400ms'").execute(transaction);
          return callback({ transaction: transaction as never });
        });
      },
    };
    await assert.rejects(
      runCleanupBatch(coordinator(isolated.runtime, store, { uow: lockTimeoutUow as never, leaseOwner: 'blocked-cleaner' })),
      isLockTimeout,
      'the cleanup claim must block while the finalize handoff holds the blob row lock',
    );
    group.release('after_finalize_handoff_lock:f');
    const handoff = await finalizePromise;
    assert.equal(handoff.outcome, 'attached');

    // After the handoff commits, cleanup claims ONLY the retired generation.
    const result = await runCleanupBatch(coordinator(isolated.runtime, store, { leaseOwner: 'post-finalize-cleaner' }));
    assert.deepEqual(result.outcomes.map((o) => o.kind), ['deleted']);
    assert.deepEqual(store.deletedKeys(), [original.key], 'only the retired generation body is deleted');
    assert.ok(store.bytesOf(current.key), 'the attached/active marker is untouched (never deleted)');
    assert.equal(store.bytesOf(original.key), undefined, 'the retired body is confirmed absent');
    const blob = await isolated.runtime.pool.query<{ logical_state: string; current_generation_id: string | null }>(
      `select logical_state, current_generation_id from blob_records where blob_id = $1`,
      [original.blobId],
    );
    assert.equal(blob.rows[0]!.logical_state, 'attached_private');
    assert.equal(blob.rows[0]!.current_generation_id, current.generationId);
    const oldRow = await generationRow(isolated.runtime, original.generationId);
    assert.equal(oldRow.generation_state, 'deleted');
  });
});
