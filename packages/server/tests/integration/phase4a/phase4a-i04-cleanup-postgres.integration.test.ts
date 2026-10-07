/**
 * P4A-I04 cleanup fencing, finalize mutual exclusion, fault recovery, and
 * process restart against isolated PostgreSQL using production
 * `createPostgresAttachmentsPorts` and the real migrated schema.
 *
 * Provider calls (HEAD/DELETE) always happen OUTSIDE the transaction through a
 * recording/fault object-store port; the tests prove the loser sent no wrong
 * DELETE and that retired bytes are confirmed absent while active bytes are
 * preserved. Deterministic barriers and designed lock_timeouts replace random
 * sleeps.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import {
  AttachmentsIdentityError,
  type AllocateGenerationInput,
} from '../../../src/modules/attachments/index.js';
import {
  BarrierGroup,
  RecordingObjectStore,
  createI04MigrationRuntime,
  i04Uow,
  identityFor,
  makeBucket,
  openI04RuntimeForSchema,
  runCleanupAttempt,
  type I04MigrationRuntime,
} from '../../support/phase4a-i04-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

const BYTES_OLD = new TextEncoder().encode('retired-bytes-marker-old');
const BYTES_NEW = new TextEncoder().encode('active-bytes-marker-new');
const ports = createPostgresAttachmentsPorts();

function allocateInput(id: ReturnType<typeof identityFor>, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: 'principal-i04',
    collectionId: 'collection-i04',
    subjectIdentity: 'subject-owner-i04',
    bucket: makeBucket(),
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: 7,
    expectedSha256: 'a'.repeat(64),
    mediaHint: 'application/octet-stream',
    policyRevision: 'policy-rev-1',
    idempotencyKey: `idem-${id.intentId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function completeForStore(id: ReturnType<typeof identityFor>, store: RecordingObjectStore, blobId = id.blobId) {
  const etag = store.etagOf(id.key);
  const size = store.bytesOf(id.key)?.byteLength;
  if (!etag || size === undefined) throw new Error('store must be seeded before complete');
  return {
    intentId: id.intentId, generationId: id.generationId, blobId,
    observedEtag: etag, observedSize: size, observedContentType: 'application/octet-stream',
    observedMetadata: { probe: 'i04' },
  };
}

async function seedBlobWithRetired(runtime: I04MigrationRuntime['runtime'], old: ReturnType<typeof identityFor>, next: ReturnType<typeof identityFor>, store: RecordingObjectStore): Promise<void> {
  const uow = i04Uow(runtime);
  store.seed(old.key, BYTES_OLD);
  store.seed(next.key, BYTES_NEW);
  await uow.execute((tx) => ports.allocate(tx, allocateInput(old)));
  await uow.execute((tx) => ports.complete(tx, completeForStore(old, store)));
  await uow.execute((tx) => ports.allocate(tx, allocateInput(next, { blobId: old.blobId })));
  await uow.execute((tx) => ports.complete(tx, completeForStore(next, store, old.blobId)));
  await uow.execute((tx) => ports.activateReplacement(tx, {
    blobId: old.blobId, expectedActiveGenerationId: old.generationId, newGenerationId: next.generationId,
  }));
}

async function seedStoredPrivate(runtime: I04MigrationRuntime['runtime'], blobId: string): Promise<void> {
  await sql`
    update blob_records
    set logical_state = 'stored_private', verification_policy_version = 'phase4a-i04-fixture',
        verified_size = 8, verified_sha256 = ${'b'.repeat(64)},
        media_type = 'application/octet-stream'
    where blob_id = ${blobId}
  `.execute(runtime.db);
}

async function generationRowFor(runtime: I04MigrationRuntime['runtime'], generationId: string) {
  const result = await sql<{
    generation_state: string; cleanup_attempt_token: string | null; cleanup_lease_owner: string | null;
    cleanup_lease_generation: string; confirmed_absent_at: Date | null; deleted_at: Date | null;
    quarantined_at: Date | null; quarantined_reason: string | null; contract_corrupt_at: Date | null;
  }>`
    select generation_state, cleanup_attempt_token, cleanup_lease_owner, cleanup_lease_generation::text,
           confirmed_absent_at, deleted_at, quarantined_at, quarantined_reason, contract_corrupt_at
    from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `generation ${generationId} must exist`);
  return result.rows[0]!;
}

async function activeGenerationOf(runtime: I04MigrationRuntime['runtime'], blobId: string): Promise<string> {
  const result = await sql<{ generation_id: string }>`
    select generation_id from blob_generations
    where blob_id = ${blobId} and generation_state = 'active'
  `.execute(runtime.db);
  assert.equal(result.rows.length, 1, 'exactly one active generation per blob');
  return result.rows[0]!.generation_id;
}

async function withLockTimeout<Result>(
  uow: ReturnType<typeof i04Uow>,
  timeoutMs: number,
  operation: (tx: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return uow.execute(async (tx) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`).execute(tx);
    return operation(tx);
  });
}

describeWithPostgres('P4A-I04 cleanup fencing, finalize mutual exclusion, and recovery', () => {
  let isolated: I04MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI04MigrationRuntime('i04_cleanup', { maxConnections: 10 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('cleanup deletes only the retired key and preserves the active bytes', async () => {
    const g1 = identityFor(1);
    const g2 = identityFor(2);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    const attempt = await runCleanupAttempt({
      unitOfWork: i04Uow(isolated.runtime),
      store,
      leaseOwner: 'cleaner-1',
      leaseTtlSeconds: 60,
      generationId: g1.generationId,
    });
    assert.equal(attempt.claimOutcome, 'claimed');
    assert.equal(attempt.verdict, 'deleted');
    assert.equal(attempt.completeOutcome, 'completed');
    assert.deepEqual(store.deletedKeys(), [g1.key], 'only the retired key may be deleted');
    assert.equal(store.bytesOf(g2.key)?.byteLength, BYTES_NEW.byteLength, 'active bytes must be preserved');
    assert.equal(store.bytesOf(g1.key), undefined, 'retired key must be confirmed absent');

    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.ok(row.confirmed_absent_at, 'deletion evidence must be recorded');
    assert.ok(row.deleted_at);
    assert.equal(await activeGenerationOf(isolated.runtime, g1.blobId), g2.generationId);

    // A duplicate cleanup of an already-absent key converges as already deleted.
    const again = await i04Uow(isolated.runtime).execute((tx) => ports.completeCleanup(tx, { claim: attempt.claim!, verdict: 'deleted' }));
    assert.equal(again.outcome, 'already_deleted');
  });

  test('cleanup can only claim retired/orphaned generations, never the active one', async () => {
    const g1 = identityFor(3);
    const g2 = identityFor(4);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    const activeClaim = await i04Uow(isolated.runtime).execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g2.generationId,
    }));
    assert.equal(activeClaim.outcome, 'not_claimable');
    assert.deepEqual(store.deleteCalls, [], 'no DELETE may be sent for the active generation');
  });

  test('two cleanup owners: the second is lease-held until expiry, then takes over with a higher lease generation', async () => {
    const g1 = identityFor(5);
    const g2 = identityFor(6);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    const uow = i04Uow(isolated.runtime);

    const ownerA = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'owner-a', leaseTtlSeconds: 3_600, generationId: g1.generationId }));
    assert.equal(ownerA.outcome, 'claimed');

    const ownerBWhileHeld = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'owner-b', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(ownerBWhileHeld.outcome, 'lease_held');

    // Lease expires (database clock); owner B takes over with a higher lease generation.
    await sql`update blob_generations set cleanup_lease_expires_at = now() - interval '1 second' where generation_id = ${g1.generationId}`.execute(isolated.runtime.db);
    const ownerB = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'owner-b', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(ownerB.outcome, 'claimed');
    assert.ok(BigInt(ownerB.claim.leaseGeneration) > BigInt(ownerA.claim.leaseGeneration), 'takeover must fence with a higher lease generation');

    // The stale owner A can no longer commit anything.
    const staleComplete = await uow.execute((tx) => ports.completeCleanup(tx, { claim: ownerA.claim, verdict: 'deleted' }));
    assert.equal(staleComplete.outcome, 'lease_lost');

    // Owner B commits the confirmed-absent evidence.
    const bComplete = await uow.execute((tx) => ports.completeCleanup(tx, { claim: ownerB.claim, verdict: 'confirmed_absent' }));
    assert.equal(bComplete.outcome, 'completed');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
  });

  test('finalize locks first: a cleanup claim is blocked (lock_timeout 55P03) until finalize commits', async () => {
    const g1 = identityFor(7);
    const g2 = identityFor(8);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    await seedStoredPrivate(isolated.runtime, g1.blobId);
    const uow = i04Uow(isolated.runtime);
    const group = new BarrierGroup();
    const finalizeBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:f`) };

    const finalizePromise = uow.execute((tx) => ports.finalizeLock(tx, {
      blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60,
    }, { barrier: finalizeBarrier }));
    await group.waitArrived('after_finalize_lock:f');

    // While finalize holds the blob row lock, cleanup's claim blocks and times out.
    await assert.rejects(
      withLockTimeout(uow, 400, (tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId })),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'lock_timeout',
    );

    group.release('after_finalize_lock:f');
    const locked = await finalizePromise;
    assert.equal(locked.outcome, 'locked');
    assert.equal(locked.currentGenerationId, g2.generationId);

    // After finalize commits, the same cleanup claim succeeds.
    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');
    assert.deepEqual(store.deleteCalls, [], 'no DELETE may be sent while the active generation is finalize-locked');
  });

  test('cleanup claims first: finalize waits for the claim transaction, then locks the current generation', async () => {
    const g1 = identityFor(9);
    const g2 = identityFor(10);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    await seedStoredPrivate(isolated.runtime, g1.blobId);
    const uow = i04Uow(isolated.runtime);
    const group = new BarrierGroup();
    const claimBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:c`) };

    const claimPromise = uow.execute((tx) => ports.claimCleanup(tx, {
      leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    }, { barrier: claimBarrier }));
    // claimCleanup pauses at before_cleanup_claim first; release it so the claim
    // actually takes the FOR SHARE lock + claim UPDATE, then parks at
    // after_cleanup_claim holding the row lock.
    await group.waitArrived('before_cleanup_claim:c');
    group.release('before_cleanup_claim:c');
    await group.waitArrived('after_cleanup_claim:c');

    await assert.rejects(
      withLockTimeout(uow, 400, (tx) => ports.finalizeLock(tx, { blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60 })),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'lock_timeout',
    );

    group.release('after_cleanup_claim:c');
    const claimed = await claimPromise;
    assert.equal(claimed.outcome, 'claimed');

    const locked = await uow.execute((tx) => ports.finalizeLock(tx, { blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60 }));
    assert.equal(locked.outcome, 'locked');
    assert.equal(locked.currentGenerationId, g2.generationId);
  });

  test('finalize only locks stored_private blobs', async () => {
    const g1 = identityFor(11);
    const g2 = identityFor(12);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    const result = await i04Uow(isolated.runtime).execute((tx) => ports.finalizeLock(tx, {
      blobId: g1.blobId, leaseOwner: 'finalizer', leaseTtlSeconds: 60,
    }));
    assert.equal(result.outcome, 'not_finalizable');
    assert.equal(result.logicalState, 'uploaded');
  });

  test('HEAD response loss recovers: unknown head releases the lease and a later attempt succeeds', async () => {
    const g1 = identityFor(13);
    const g2 = identityFor(14);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    let headCalls = 0;
    store.options.beforeHead = async () => {
      headCalls += 1;
      if (headCalls === 1) return { class: 'unknown' };
      return undefined;
    };

    const first = await runCleanupAttempt({
      unitOfWork: i04Uow(isolated.runtime), store, leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    });
    assert.equal(first.verdict, 'unknown_retryable');
    assert.equal(first.completeOutcome, 'released');
    const rowAfterUnknown = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(rowAfterUnknown.generation_state, 'deletion_pending');
    assert.equal(rowAfterUnknown.cleanup_attempt_token, null, 'the lease must be released for retry');

    const second = await runCleanupAttempt({
      unitOfWork: i04Uow(isolated.runtime), store, leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    });
    assert.equal(second.verdict, 'deleted');
    assert.equal(second.completeOutcome, 'completed');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
  });

  test('DELETE response loss reconciles via HEAD: confirmed absent is convergence, not quarantine', async () => {
    const g1 = identityFor(15);
    const g2 = identityFor(16);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    let deleteCalls = 0;
    store.options.beforeDelete = async (candidate) => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        // The provider delete actually succeeded; only the response was lost.
        store.objects.delete(candidate.key);
        return { class: 'unknown' };
      }
      return undefined;
    };

    const attempt = await runCleanupAttempt({
      unitOfWork: i04Uow(isolated.runtime), store, leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    });
    assert.equal(attempt.verdict, 'deleted', 'DELETE unknown + HEAD absent must converge as deleted');
    assert.equal(attempt.completeOutcome, 'completed');
    assert.notEqual(attempt.verdict, 'candidate_mismatch');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
    assert.ok(row.confirmed_absent_at);
    assert.equal(store.bytesOf(g2.key)?.byteLength, BYTES_NEW.byteLength);
  });

  test('DELETE unknown reconciled to still-present stays unknown/retryable', async () => {
    const g1 = identityFor(17);
    const g2 = identityFor(18);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);
    store.options.beforeDelete = async () => ({ class: 'unknown' });

    const attempt = await runCleanupAttempt({
      unitOfWork: i04Uow(isolated.runtime), store, leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    });
    assert.equal(attempt.verdict, 'unknown_retryable');
    assert.equal(attempt.completeOutcome, 'released');
    assert.equal(store.bytesOf(g1.key) !== undefined, true, 'the object still exists for a later takeover');
  });

  test('candidate mismatch quarantines the generation and sends NO delete', async () => {
    const g1 = identityFor(19);
    const g2 = identityFor(20);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    // Simulate same-key corruption: the provider object at the retired key now
    // differs from the claimed snapshot (bytes/ETag/size changed).
    store.objects.set(g1.key, { etag: '"tampered"', size: 999, bytes: BYTES_OLD, metadata: {} });

    const attempt = await runCleanupAttempt({
      unitOfWork: i04Uow(isolated.runtime), store, leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId,
    });
    assert.equal(attempt.verdict, 'candidate_mismatch');
    assert.equal(attempt.completeOutcome, 'quarantined');
    assert.equal(attempt.deleteAttempted, false, 'mismatch must never send a DELETE');
    assert.deepEqual(store.deletedKeys(), [], 'no DELETE may be sent for a mismatched candidate');

    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'quarantined');
    assert.equal(row.quarantined_reason, 'candidate_mismatch');
    assert.ok(row.contract_corrupt_at, 'the quarantine must traverse the contract_corrupt step');
    assert.ok(row.quarantined_at);
    assert.equal(store.bytesOf(g1.key)?.byteLength, BYTES_OLD.byteLength, 'quarantined bytes stay untouched for operator review');

    // A quarantined generation is never claimable again.
    const reClaim = await i04Uow(isolated.runtime).execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(reClaim.outcome, 'not_claimable');
  });

  test('contract corruption is quarantined explicitly and cleanup never touches it', async () => {
    const g1 = identityFor(21);
    const g2 = identityFor(22);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    const quarantined = await i04Uow(isolated.runtime).execute((tx) => ports.quarantineGeneration(tx, { generationId: g1.generationId, reason: 'contract_corrupt' }));
    assert.equal(quarantined.outcome, 'quarantined');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'quarantined');
    assert.equal(row.quarantined_reason, 'contract_corrupt');

    const claim = await i04Uow(isolated.runtime).execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'not_claimable');
    assert.deepEqual(store.deletedKeys(), [], 'quarantined corruption must never be auto-deleted');
    assert.equal(store.bytesOf(g1.key)?.byteLength, BYTES_OLD.byteLength);
  });

  test('commit outcome unknown recovers by reading the database, not the client exception', async () => {
    const g1 = identityFor(23);
    const g2 = identityFor(24);
    const store = new RecordingObjectStore();
    await seedBlobWithRetired(isolated.runtime, g1, g2, store);

    const claim = await i04Uow(isolated.runtime).execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');

    // The complete commit succeeds but the caller sees an unknown outcome.
    const committed = await i04Uow(isolated.runtime).execute((tx) => ports.completeCleanup(tx, { claim: claim.claim, verdict: 'confirmed_absent' }));
    assert.equal(committed.outcome, 'completed');

    // Recovery re-reads the row: the same claim now converges as already deleted.
    const recovered = await i04Uow(isolated.runtime).execute((tx) => ports.completeCleanup(tx, { claim: claim.claim, verdict: 'confirmed_absent' }));
    assert.equal(recovered.outcome, 'already_deleted');
    const row = await generationRowFor(isolated.runtime, g1.generationId);
    assert.equal(row.generation_state, 'deleted');
  });

  test('process restart recovers a durable claim and completes cleanup from a fresh runtime', async () => {
    const migrated = await createI04MigrationRuntime('i04_restart', { maxConnections: 10 });
    try {
      const g1 = identityFor(25);
      const g2 = identityFor(26);
      const store = new RecordingObjectStore();
      await seedBlobWithRetired(migrated.runtime, g1, g2, store);

      // Process 1: claim is committed durably, then the process crashes before
      // any provider call.
      const claim = await i04Uow(migrated.runtime).execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'worker-1', leaseTtlSeconds: 60, generationId: g1.generationId }));
      assert.equal(claim.outcome, 'claimed');

      await migrated.closeKeepSchema(); // process 1 exits; the schema stays.

      // Process 2: a fresh runtime observes the DB facts and recovers.
      const restarted = openI04RuntimeForSchema(migrated.databaseUrl);
      try {
        const row = await generationRowFor(restarted, g1.generationId);
        assert.equal(row.generation_state, 'deletion_pending');
        assert.equal(row.cleanup_attempt_token, claim.claim.attemptToken, 'the durable attempt token must survive the restart');

        // Rebuilding the app instance must not lift the permanent tombstone: a
        // fresh runtime still rejects reissue of the claimed physical key.
        // The crashed worker's lease deadline passes during the restart (DB clock);
        // the restarted worker takes over with a higher lease generation.
        await sql`update blob_generations set cleanup_lease_expires_at = now() - interval '1 second' where generation_id = ${g1.generationId}`.execute(restarted.db);

        await assert.rejects(
          i04Uow(restarted).execute((tx) => ports.allocate(tx, allocateInput(identityFor(27), {
            blobId: g1.blobId, intentId: `restart-${g1.intentId}`, generationId: `restart-${g1.generationId}`,
            key: g1.key, keyFingerprint: g1.fingerprint, idempotencyKey: 'idem-restart-reissue',
          }))),
          (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
        );

        const recovered = await runCleanupAttempt({
          unitOfWork: i04Uow(restarted), store, leaseOwner: 'worker-2', leaseTtlSeconds: 60, generationId: g1.generationId,
        });
        assert.equal(recovered.verdict, 'deleted');
        assert.equal(recovered.completeOutcome, 'completed');
        assert.equal(store.bytesOf(g1.key), undefined);
        assert.equal(store.bytesOf(g2.key)?.byteLength, BYTES_NEW.byteLength, 'active bytes preserved across the restart');

        const finalRow = await generationRowFor(restarted, g1.generationId);
        assert.equal(finalRow.generation_state, 'deleted');
        assert.ok(finalRow.confirmed_absent_at);
        assert.equal(await activeGenerationOf(restarted, g1.blobId), g2.generationId);
      } finally {
        await restarted.close();
      }
    } finally {
      await migrated.dropSchema();
    }
  });
});
