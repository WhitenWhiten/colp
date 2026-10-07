/**
 * P4A-P02 PostgreSQL integration suite (races): multi-connection mutual
 * exclusion for the Canonical finalize assembly against the PRODUCTION
 * migration.
 *
 * Every concurrency claim uses INDEPENDENT connections and deterministic
 * promise barriers parked exactly at the Collection/blob row-lock boundaries
 * (never a short timeout misreported as unsafe). Expected lock waits are
 * proven by the stable 55P03 lock_timeout SQLSTATE and are retryable; a real
 * 40P01 deadlock is forced with two transactions locking two
 * Collection/blob pairs in opposite order.
 *
 * Coverage: two finalizers on the same blob (winner commits; the loser
 * blocks with lock_timeout, then converges to already_finalized /
 * binding_conflict with exactly ONE committed side-effect set), and a
 * deterministic two-collection deadlock with bounded retry.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork, DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import {
  classifyAttachmentsLedgerError,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import { BarrierGroup } from '../../support/phase4a-i07-test-helpers.js';
import {
  i13Uow,
  withLockTimeout,
} from '../../support/phase4a-i13-test-helpers.js';
import {
  P02_COLLECTION_A,
  P02_COLLECTION_B,
  createPostgresAttachmentCanonicalMutationPorts,
  finalizeInTx,
  identityFor,
  p02FinalizeInput,
  readAttachmentRow,
  readFinalizeSideEffects,
  readOutboxRows,
  seedP02Collection,
  seedP02StoredPrivate,
} from '../../support/phase4a-p02-test-helpers.js';

const assembly = createPostgresAttachmentCanonicalMutationPorts();

function isLockTimeout(error: unknown): boolean {
  return error instanceof DatabaseOperationError && error.kind === 'lock_timeout';
}

describeWithPostgres('P4A-P02 canonical finalize races', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('p02_races', { maxConnections: 12 });
    await seedP02Collection(isolated.runtime, P02_COLLECTION_A);
    await seedP02Collection(isolated.runtime, P02_COLLECTION_B);
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('two finalizers on the same blob: one winner; the loser blocks with lock_timeout (retryable) then converges without any second side effect', async () => {
    const id = identityFor(200);
    await seedP02StoredPrivate(isolated.runtime, id);
    const group = new BarrierGroup();
    const winnerBarrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:w`) };
    const winnerInput = p02FinalizeInput(id, { attachmentId: 'p02-race-bind-a' });
    const winnerPromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      assembly.finalizeAttachment(transaction, winnerInput, { barrier: winnerBarrier }));
    // Sequential release: the assembly parks at the Collection-lock barrier
    // BEFORE the handoff lock barrier, so each barrier must be released before
    // the winner can arrive at the next one.
    await group.waitArrived('attachment_collection_locked:w');
    group.release('attachment_collection_locked:w');
    await group.waitArrived('after_finalize_handoff_lock:w');

    // The second finalizer (independent connection) blocks on the row lock.
    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 400, (tx) =>
        assembly.finalizeAttachment(tx, p02FinalizeInput(id, { attachmentId: 'p02-race-bind-b' }))),
      isLockTimeout,
      'the second finalizer must block on the Collection/blob row lock (deterministic 55P03 proof)',
    );
    group.release('after_finalize_handoff_lock:w');
    const winner = await winnerPromise;
    assert.equal(winner.outcome, 'finalized');
    if (winner.outcome !== 'finalized') return;

    // Bounded retry: same binding returns the ORIGINAL receipt; a different
    // binding conflicts — exactly ONE committed side-effect set.
    const retrySame = await finalizeInTx(isolated.runtime, assembly, winnerInput);
    assert.equal(retrySame.outcome, 'already_finalized');
    if (retrySame.outcome === 'already_finalized') {
      assert.equal(retrySame.receipt.commitOrdinal, winner.receipt.commitOrdinal);
    }
    const retryOther = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(id, { attachmentId: 'p02-race-bind-b' }),
    );
    assert.equal(retryOther.outcome, 'binding_conflict');

    const row = await readAttachmentRow(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.attachmentId, 'p02-race-bind-a', 'exactly one committed Attachment, owned by the winner');
    const effects = await readFinalizeSideEffects(isolated.runtime, id.blobId, 'p02-race-bind-a', winner.receipt.operationId);
    assert.equal(effects.operations.length, 1, 'exactly one Operation row');
    assert.equal(effects.audits.length, 1, 'exactly one Audit row');
    assert.equal(effects.outbox.length, 1, 'exactly one Outbox row');
    assert.equal((await readOutboxRows(isolated.runtime, id.blobId)).length, 1);
    assert.equal(effects.blob?.attachmentBindingId, 'p02-race-bind-a');
  });

  test('deadlock between two canonical finalize transactions is retryable and converges to exactly one Attachment per blob', async () => {
    const blobA = identityFor(201);
    const blobB = identityFor(202);
    await seedP02StoredPrivate(isolated.runtime, blobA, P02_COLLECTION_A);
    await seedP02StoredPrivate(isolated.runtime, blobB, P02_COLLECTION_B);
    const group = new BarrierGroup();
    const barrierFor = (prefix: string) => ({ arriveAndWait: (name: string) => group.arriveAndWait(`${prefix}:${name}`) });

    const tx1 = createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const r1 = await assembly.finalizeAttachment(
        transaction,
        p02FinalizeInput(blobA, { attachmentId: 'p02-deadlock-a1', operationId: 'p02-deadlock-op-a1' }),
        { barrier: barrierFor('t1a') },
      );
      assert.equal(r1.outcome, 'finalized');
      // The second finalize runs WITHOUT a test barrier: after the first
      // finalize's handoff barrier is released, the two transactions block on
      // each other's Collection row locks and PostgreSQL resolves the cycle
      // with a deterministic 40P01 deadlock abort (any test barrier here
      // would park the transaction idle-in-transaction instead).
      const r2 = await assembly.finalizeAttachment(
        transaction,
        p02FinalizeInput(blobB, { collectionId: P02_COLLECTION_B, attachmentId: 'p02-deadlock-b1', operationId: 'p02-deadlock-op-b1' }),
      );
      assert.equal(r2.outcome, 'finalized');
    });
    const tx2 = createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const r1 = await assembly.finalizeAttachment(
        transaction,
        p02FinalizeInput(blobB, { collectionId: P02_COLLECTION_B, attachmentId: 'p02-deadlock-b2', operationId: 'p02-deadlock-op-b2' }),
        { barrier: barrierFor('t2b') },
      );
      assert.equal(r1.outcome, 'finalized');
      const r2 = await assembly.finalizeAttachment(
        transaction,
        p02FinalizeInput(blobA, { attachmentId: 'p02-deadlock-a2', operationId: 'p02-deadlock-op-a2' }),
      );
      assert.equal(r2.outcome, 'finalized');
    });

    // Release the Collection locks first so each transaction can reach its
    // handoff lock barrier, then release those to let both proceed into the
    // cross-collection lock wait that PostgreSQL resolves as a 40P01 deadlock.
    await group.waitAllArrived(['t1a:attachment_collection_locked', 't2b:attachment_collection_locked']);
    group.releaseAll(['t1a:attachment_collection_locked', 't2b:attachment_collection_locked']);
    await group.waitAllArrived(['t1a:after_finalize_handoff_lock', 't2b:after_finalize_handoff_lock']);
    group.releaseAll(['t1a:after_finalize_handoff_lock', 't2b:after_finalize_handoff_lock']);

    const settled = await Promise.allSettled([tx1, tx2]);
    const fulfilled = settled.find((entry) => entry.status === 'fulfilled');
    const rejected = settled.find((entry) => entry.status === 'rejected');
    assert.ok(fulfilled, 'exactly one transaction must win');
    assert.ok(rejected, 'the loser must be aborted by PostgreSQL deadlock detection');
    const loserError = (rejected as PromiseRejectedResult).reason;
    assert.ok(loserError instanceof DatabaseOperationError && loserError.kind === 'deadlock', 'loser gets 40P01');
    assert.equal(classifyAttachmentsLedgerError(loserError).class, 'retryable', 'deadlock is a bounded-retry class');

    // The loser's bindings never committed; every retry stops at
    // binding_conflict (never redo a different Attachment).
    const loserIsTx1 = rejected === settled[0];
    const winnerIsTx1 = !loserIsTx1;
    const loserFirstBlob = loserIsTx1 ? blobA : blobB;
    const loserFirstBinding = loserIsTx1 ? 'p02-deadlock-a1' : 'p02-deadlock-b2';
    const retry = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(loserFirstBlob, {
        collectionId: loserIsTx1 ? P02_COLLECTION_A : P02_COLLECTION_B,
        attachmentId: loserFirstBinding,
      }),
    );
    assert.equal(retry.outcome, 'binding_conflict');

    const rowA = await readAttachmentRow(isolated.runtime, blobA.blobId);
    const rowB = await readAttachmentRow(isolated.runtime, blobB.blobId);
    assert.ok(rowA && rowB);
    assert.notEqual(rowA.attachmentId, rowB.attachmentId, 'each blob has exactly ONE committed Attachment');
    const opA = winnerIsTx1 ? 'p02-deadlock-op-a1' : 'p02-deadlock-op-a2';
    const opB = winnerIsTx1 ? 'p02-deadlock-op-b1' : 'p02-deadlock-op-b2';
    const effectsA = await readFinalizeSideEffects(isolated.runtime, blobA.blobId, rowA.attachmentId, opA);
    const effectsB = await readFinalizeSideEffects(isolated.runtime, blobB.blobId, rowB.attachmentId, opB);
    assert.equal(effectsA.operations.length, 1, 'blob A has exactly one Operation');
    assert.equal(effectsB.operations.length, 1, 'blob B has exactly one Operation');
    assert.equal(effectsA.outbox.length, 1);
    assert.equal(effectsB.outbox.length, 1);
    assert.equal(effectsA.blob?.attachmentBindingId, rowA.attachmentId);
    assert.equal(effectsB.blob?.attachmentBindingId, rowB.attachmentId);
  }, 30_000);

  test('replay convergence after a race: the loser can never observe a half-committed attachment', async () => {
    const id = identityFor(203);
    await seedP02StoredPrivate(isolated.runtime, id);
    const group = new BarrierGroup();
    const barrier = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:r`) };
    const input = p02FinalizeInput(id);
    const first = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      assembly.finalizeAttachment(transaction, input, { barrier }));
    // Sequential release: the winner parks at the Collection-lock barrier
    // before the handoff lock barrier.
    await group.waitArrived('attachment_collection_locked:r');
    group.release('attachment_collection_locked:r');
    await group.waitArrived('after_finalize_handoff_lock:r');

    // While the winner is parked at the blob lock, the loser (fresh tx) can
    // only WAIT on the row lock — it can never read or write a half state.
    await assert.rejects(
      withLockTimeout(i13Uow(isolated.runtime), 300, (tx) =>
        assembly.finalizeAttachment(tx, p02FinalizeInput(id, { attachmentId: 'p02-race-c' }))),
      isLockTimeout,
    );
    group.release('after_finalize_handoff_lock:r');
    const winner = await first;
    assert.equal(winner.outcome, 'finalized');

    const convergence = await finalizeInTx(isolated.runtime, assembly, input);
    assert.equal(convergence.outcome, 'already_finalized');
    if (convergence.outcome !== 'already_finalized') return;
    assert.equal(convergence.receipt.commitOrdinal, winner.outcome === 'finalized' ? winner.receipt.commitOrdinal : 1n);
  });

  test('the I13 handoff port itself remains usable standalone (blob binding without the assembly writes no side effects)', async () => {
    const id = identityFor(204);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);
    const ports = createPostgresAttachmentsPorts();
    const handoff = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, {
        blobId: input.blobId,
        attachmentBindingId: `p02-standalone-${id.generationId}`,
        expectedGenerationId: input.expectedGenerationId,
        ownerSubjectId: input.ownerSubjectId,
        expectedEtag: input.expectedEtag,
        verifiedSize: input.verifiedSize,
        verifiedSha256: input.verifiedSha256,
        mediaType: input.mediaType,
        policyRevision: input.policyRevision,
      }));
    assert.equal(handoff.outcome, 'attached');
    assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null,
      'the handoff alone never creates the production Attachment row');
    assert.equal((await readOutboxRows(isolated.runtime, id.blobId)).length, 0,
      'the handoff alone never creates an Outbox row');
  });
});
