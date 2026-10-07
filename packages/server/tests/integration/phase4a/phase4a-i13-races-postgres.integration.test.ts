/**
 * P4A-I13 PostgreSQL integration suite (races): multi-connection mutual
 * exclusion for the transaction-bound finalize handoff against the PRODUCTION
 * migration.
 *
 * Every concurrency claim uses 2-3 INDEPENDENT connections and deterministic
 * promise barriers parked exactly at the row lock / CAS boundaries (never a
 * short timeout misreported as unsafe). Expected lock waits are proven by the
 * stable 55P03 lock_timeout SQLSTATE and are retryable; a real 40P01 deadlock
 * is forced with two transactions locking two blobs in opposite order.
 *
 * Coverage: two finalizers (one winner, loser blocks then converges), finalize
 * vs cleanup in BOTH orders (FOR UPDATE vs FOR SHARE on the blob row), the
 * three-way finalize/replacement/cleanup race, a deterministic deadlock with
 * bounded retry, and commit-response-lost recovery that re-reads the binding
 * to decide (never blindly redo a different Attachment).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork, DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import {
  classifyAttachmentsLedgerError,
  resolveFinalizeUnknownOutcome,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  finalizeHandoffInTx,
  i13HandoffInput,
  i13Uow,
  identityFor,
  onBlob,
  readBlobBinding,
  seedObservedReplacement,
  seedStoredPrivate,
  seedStoredPrivateWithRetired,
  withLockTimeout,
} from '../../support/phase4a-i13-test-helpers.js';

const ports = createPostgresAttachmentsPorts();

function isLockTimeout(error: unknown): boolean {
  return error instanceof DatabaseOperationError && error.kind === 'lock_timeout';
}

describeWithPostgres('P4A-I13 finalize handoff races', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i13_races', { maxConnections: 12 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('two finalizers: one winner; the loser blocks with lock_timeout (retryable) then converges without a side effect', async () => {
    const id = identityFor(20);
    await seedStoredPrivate(isolated.runtime, id);
    const group = new BarrierGroup();
    const winnerBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:f1`) };
    const winnerPromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, i13HandoffInput(id, { attachmentBindingId: 'race-bind-a' }), { barrier: winnerBarrier }));
    await group.waitArrived('after_finalize_handoff_lock:f1');

    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 400, (tx) =>
        ports.finalizeHandoff(tx, i13HandoffInput(id, { attachmentBindingId: 'race-bind-b' }))),
      isLockTimeout,
      'the second finalizer must block on the row lock (deterministic 55P03 proof)',
    );
    group.release('after_finalize_handoff_lock:f1');
    const winner = await winnerPromise;
    assert.equal(winner.outcome, 'attached');
    if (winner.outcome === 'attached') assert.equal(winner.binding.attachmentBindingId, 'race-bind-a');

    // Bounded retry: same binding returns the committed result, a different
    // binding conflicts — the loser has NO provider side effect (one binding).
    const retrySame = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: 'race-bind-a' }));
    assert.equal(retrySame.outcome, 'idempotent');
    const retryOther = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: 'race-bind-b' }));
    assert.equal(retryOther.outcome, 'binding_conflict');
    const row = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.attachmentBindingId, 'race-bind-a', 'exactly one committed binding, owned by the winner');
  });

  test('finalize first: a cleanup claim blocks with lock_timeout until the handoff commits, then only the retired generation is claimable', async () => {
    const original = identityFor(21);
    const current = identityFor(22);
    await seedStoredPrivateWithRetired(isolated.runtime, original, current);
    const group = new BarrierGroup();
    const finalizeBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:f`) };
    const finalizePromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, i13HandoffInput(onBlob(original.blobId, current)), { barrier: finalizeBarrier }));
    await group.waitArrived('after_finalize_handoff_lock:f');

    // Cleanup's FOR SHARE on the blob row must block on the handoff's FOR UPDATE.
    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 400, (tx) =>
        ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: original.generationId })),
      isLockTimeout,
    );

    group.release('after_finalize_handoff_lock:f');
    const handoff = await finalizePromise;
    assert.equal(handoff.outcome, 'attached');
    assert.equal(handoff.outcome === 'attached' ? handoff.binding.generationId : null, current.generationId);

    // After commit the cleanup of the RETIRED generation still converges; the
    // attached/current generation is never claimable.
    const claim = await i13Uow(isolated.runtime).execute((tx) =>
      ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: original.generationId }));
    assert.equal(claim.outcome, 'claimed');
    const activeClaim = await i13Uow(isolated.runtime).execute((tx) =>
      ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: current.generationId }));
    assert.equal(activeClaim.outcome, 'not_claimable', 'the attached/current generation can never be claimed');
  });

  test('cleanup first: the handoff waits for the claim transaction (lock_timeout), then fences the current generation', async () => {
    const original = identityFor(23);
    const current = identityFor(24);
    await seedStoredPrivateWithRetired(isolated.runtime, original, current);
    const group = new BarrierGroup();
    const claimBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:c`) };
    const claimPromise = i13Uow(isolated.runtime).execute((tx) =>
      ports.claimCleanup(tx, {
        leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: original.generationId,
      }, { barrier: claimBarrier }));
    await group.waitArrived('before_cleanup_claim:c');
    group.release('before_cleanup_claim:c');
    await group.waitArrived('after_cleanup_claim:c');

    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 400, (tx) => ports.finalizeHandoff(tx, i13HandoffInput(onBlob(original.blobId, current)))),
      isLockTimeout,
    );

    group.release('after_cleanup_claim:c');
    const claimed = await claimPromise;
    assert.equal(claimed.outcome, 'claimed');

    const handoff = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(onBlob(original.blobId, current)));
    assert.equal(handoff.outcome, 'attached', 'after the claim commits the handoff fences the current generation');
  });

  test('three-way race: finalize wins over replacement and cleanup; the committed binding is never broken', async () => {
    const original = identityFor(25);
    const current = identityFor(26);
    const replacement = identityFor(27);
    await seedStoredPrivateWithRetired(isolated.runtime, original, current);
    await seedObservedReplacement(isolated.runtime, onBlob(original.blobId, current), replacement);
    const group = new BarrierGroup();
    const finalizeBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:f`) };
    const finalizePromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, i13HandoffInput(onBlob(original.blobId, current)), { barrier: finalizeBarrier }));
    await group.waitArrived('after_finalize_handoff_lock:f');

    // Replacement CAS and cleanup claim both serialize on the blob row lock.
    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 400, (tx) =>
        ports.activateReplacement(tx, {
          blobId: original.blobId,
          expectedActiveGenerationId: current.generationId,
          newGenerationId: replacement.generationId,
        })),
      isLockTimeout,
    );
    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 400, (tx) =>
        ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: original.generationId })),
      isLockTimeout,
    );

    group.release('after_finalize_handoff_lock:f');
    const handoff = await finalizePromise;
    assert.equal(handoff.outcome, 'attached');

    // The replacement can never move the pointer of an attached blob.
    const replacementRetry = await i13Uow(isolated.runtime).execute((tx) =>
      ports.activateReplacement(tx, {
        blobId: original.blobId,
        expectedActiveGenerationId: current.generationId,
        newGenerationId: replacement.generationId,
      }));
    assert.equal(replacementRetry.outcome, 'attached_not_replaced', 'replacement cannot break a committed binding');

    // Cleanup of the retired generation still converges; the attached one never.
    const cleanupRetry = await i13Uow(isolated.runtime).execute((tx) =>
      ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: original.generationId }));
    assert.equal(cleanupRetry.outcome, 'claimed');

    const row = await readBlobBinding(isolated.runtime, original.blobId);
    assert.ok(row);
    assert.equal(row.logicalState, 'attached_private');
    assert.equal(row.currentGenerationId, current.generationId, 'the pointer never moved');
    assert.equal(row.attachmentBindingGenerationId, current.generationId, 'the binding stays fenced to the committed generation');
  });

  test('deadlock between two handoff transactions is retryable and converges to exactly one binding per blob', async () => {
    const blobA = identityFor(28);
    const blobB = identityFor(29);
    await seedStoredPrivate(isolated.runtime, blobA);
    await seedStoredPrivate(isolated.runtime, blobB);
    const group = new BarrierGroup();
    const barrierFor = (prefix: string) => ({ arriveAndWait: (name: string) => group.arriveAndWait(`${prefix}:${name}`) });

    const tx1 = createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const r1 = await ports.finalizeHandoff(transaction, i13HandoffInput(blobA, { attachmentBindingId: 'deadlock-a1' }), { barrier: barrierFor('t1a') });
      assert.equal(r1.outcome, 'attached');
      const r2 = await ports.finalizeHandoff(transaction, i13HandoffInput(blobB, { attachmentBindingId: 'deadlock-b1' }), {});
      assert.equal(r2.outcome, 'attached');
    });
    const tx2 = createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const r1 = await ports.finalizeHandoff(transaction, i13HandoffInput(blobB, { attachmentBindingId: 'deadlock-b2' }), { barrier: barrierFor('t2b') });
      assert.equal(r1.outcome, 'attached');
      const r2 = await ports.finalizeHandoff(transaction, i13HandoffInput(blobA, { attachmentBindingId: 'deadlock-a2' }), {});
      assert.equal(r2.outcome, 'attached');
    });

    await group.waitArrived('t1a:after_finalize_handoff_lock');
    await group.waitArrived('t2b:after_finalize_handoff_lock');
    group.releaseAll(['t1a:after_finalize_handoff_lock', 't2b:after_finalize_handoff_lock']);

    const settled = await Promise.allSettled([tx1, tx2]);
    const fulfilled = settled.find((entry) => entry.status === 'fulfilled');
    const rejected = settled.find((entry) => entry.status === 'rejected');
    assert.ok(fulfilled, 'exactly one transaction must win');
    assert.ok(rejected, 'the loser must be aborted by PostgreSQL deadlock detection');
    const loserError = (rejected as PromiseRejectedResult).reason;
    assert.ok(loserError instanceof DatabaseOperationError && loserError.kind === 'deadlock', 'loser gets 40P01');
    assert.equal(classifyAttachmentsLedgerError(loserError).class, 'retryable', 'deadlock is a bounded-retry class');

    // Bounded retry of the loser's FIRST handoff with the SAME binding id: the
    // winner already attached the blob with a DIFFERENT binding, so the retry
    // stops at binding_conflict (never redo a different Attachment).
    const loserFirstBlob = rejected === settled[0] ? blobA : blobB;
    const loserBinding = rejected === settled[0] ? 'deadlock-a1' : 'deadlock-b2';
    const retry = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(loserFirstBlob, { attachmentBindingId: loserBinding }));
    assert.equal(retry.outcome, 'binding_conflict');

    const rowA = await readBlobBinding(isolated.runtime, blobA.blobId);
    const rowB = await readBlobBinding(isolated.runtime, blobB.blobId);
    assert.ok(rowA && rowB);
    assert.equal(rowA.logicalState, 'attached_private');
    assert.equal(rowB.logicalState, 'attached_private');
    assert.ok(rowA.attachmentBindingId && rowB.attachmentBindingId, 'each blob has exactly ONE committed binding');
    assert.notEqual(rowA.attachmentBindingId, rowB.attachmentBindingId, 'the loser never overwrote a committed binding');
  }, 30_000);

  test('commit-response-lost re-reads the binding and decides; a different binding never gets blindly redone', async () => {
    const id = identityFor(30);
    await seedStoredPrivate(isolated.runtime, id);
    const bindingId = `i13-commit-unknown-${id.generationId}`;
    const faultUow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCommitAcknowledged: async () => {
          throw new Error('simulated lost commit acknowledgement');
        },
      },
    });
    let caught: unknown;
    try {
      await faultUow.execute(({ transaction }) => ports.finalizeHandoff(transaction, i13HandoffInput(id, { attachmentBindingId: bindingId })));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DatabaseOperationError, 'a lost commit response surfaces as commit_outcome_unknown');
    assert.equal(caught.kind, 'commit_outcome_unknown');

    // Recovery re-reads the DATABASE (not the client exception): the commit
    // actually succeeded with the SAME binding.
    const row = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.logicalState, 'attached_private', 'the re-read proves the commit landed');
    assert.equal(row.attachmentBindingId, bindingId);
    const decision = resolveFinalizeUnknownOutcome({
      attemptedBindingId: bindingId,
      reRead: {
        outcome: 'attached',
        binding: {
          blobId: id.blobId,
          attachmentBindingId: row.attachmentBindingId!,
          generationId: row.attachmentBindingGenerationId!,
          etag: row.attachmentBindingEtag!,
          policyVersion: row.attachmentBindingPolicyVersion!,
          attachedAt: row.attachedAt!,
        },
      },
    });
    assert.equal(decision.decision, 'committed_same_binding');

    // Same-binding replay returns the committed result; a different binding
    // conflicts instead of silently redoing a different Attachment.
    const replay = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: bindingId }));
    assert.equal(replay.outcome, 'idempotent');
    const different = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(id, { attachmentBindingId: 'i13-never-redo' }));
    assert.equal(different.outcome, 'binding_conflict');
    const finalRow = await readBlobBinding(isolated.runtime, id.blobId);
    assert.ok(finalRow);
    assert.equal(finalRow.attachmentBindingId, bindingId, 'the committed binding is never overwritten');
  });
});