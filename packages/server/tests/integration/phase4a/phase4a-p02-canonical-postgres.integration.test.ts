/**
 * P4A-P02 Canonical finalize assembly evidence against isolated PostgreSQL.
 *
 * The production `createPostgresAttachmentCanonicalMutationPorts` assembly is
 * the ONLY writer under test: in ONE caller-provided transaction it locks the
 * Collection (authorization + revision), runs the transaction-bound I13
 * finalize handoff (blob binding), writes the owner-private Attachment
 * metadata row, reserves the resource ID ledger ids, appends the canonical
 * Operation / Audit / Outbox rows, and advances the Collection commit ordinal.
 *
 * Coverage:
 * - one-commit success with the FULL side-effect set asserted (metadata row,
 *   ledger, blob binding, Operation, Audit, Outbox, collection ordinal);
 * - same-binding replay returns the ORIGINAL receipt (`already_finalized`),
 *   never a unique violation, and writes nothing new;
 * - a different binding on the same blob is `binding_conflict`;
 * - Collection authorization failures (missing / deleted / owner mismatch /
 *   cross-Collection binding) and handoff rejection passthrough;
 * - rollback: a fault injected after the deepest write leaves Attachment,
 *   resource ledger, blob binding, Operation, Audit AND Outbox byte-identical
 *   (zero half-commit);
 * - commit-unknown recovery re-reads the database and decides
 *   committed_same / not_committed / inconsistent.
 *
 * Anti-false-positive: the suites never insert the target `attachments` row
 * or any finalize side effect with test SQL; the legal `stored_private`
 * pre-state comes from the PRODUCTION I13 ledger ports.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork, DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import {
  ATTACHMENT_FINALIZED_EVENT_TYPE,
  ATTACHMENT_FINALIZED_EVENT_VERSION,
  ATTACHMENT_FINALIZED_HANDLER_NAME,
} from '../../../src/infrastructure/outbox/index.js';
import {
  resolveAttachmentFinalizeUnknownOutcome,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  P02_COLLECTION_A,
  P02_COLLECTION_B,
  P02_COLLECTION_C,
  P02_COLLECTION_OTHER,
  P02_OTHER_SUBJECT,
  P02_SUBJECT_OWNER,
  createPostgresAttachmentCanonicalMutationPorts,
  deleteP02Collection,
  finalizeInTx,
  identityFor,
  p02FinalizeInput,
  p02Uow,
  readAttachmentRow,
  readAuditRow,
  readFinalizeSideEffects,
  readLedgerIds,
  readOperationRow,
  readOutboxRows,
  readP02CollectionRow,
  seedP02Collection,
  seedP02StoredPrivate,
} from '../../support/phase4a-p02-test-helpers.js';

const assembly = createPostgresAttachmentCanonicalMutationPorts();

describeWithPostgres('P4A-P02 canonical finalize assembly', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('p02_canonical', { maxConnections: 12 });
    await seedP02Collection(isolated.runtime, P02_COLLECTION_A);
    await seedP02Collection(isolated.runtime, P02_COLLECTION_B);
    await seedP02Collection(isolated.runtime, P02_COLLECTION_C);
    await seedP02Collection(isolated.runtime, P02_COLLECTION_OTHER, { ownerSubjectId: P02_OTHER_SUBJECT });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('finalize commits Attachment metadata + ledger + blob binding + Operation/Audit/Outbox + collection revision atomically', async () => {
    const id = identityFor(100);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);

    const result = await finalizeInTx(isolated.runtime, assembly, input);
    assert.equal(result.outcome, 'finalized');
    if (result.outcome !== 'finalized') return;
    assert.equal(result.receipt.attachmentId, input.attachmentId);
    assert.equal(result.receipt.blobId, input.blobId);
    assert.equal(result.receipt.operationId, input.operationId);
    assert.equal(result.receipt.collectionId, input.collectionId);
    assert.equal(result.receipt.commitOrdinal, 1n);
    assert.equal(result.receipt.logicalState, 'attached_private');

    // Attachment metadata row: only owner-private facts, no key/URL/credential.
    const attachment = await readAttachmentRow(isolated.runtime, id.blobId);
    assert.ok(attachment);
    assert.equal(attachment.attachmentId, input.attachmentId);
    assert.equal(attachment.blobId, id.blobId);
    assert.equal(attachment.collectionId, input.collectionId);
    assert.equal(attachment.ownerSubjectId, P02_SUBJECT_OWNER);
    assert.equal(attachment.sanitizedFilename, input.sanitizedFilename);
    assert.equal(attachment.mediaType, input.mediaType);
    assert.equal(attachment.size, input.verifiedSize);
    assert.equal(attachment.logicalState, 'attached_private');
    assert.ok(attachment.attachedAt, 'attached_at must be DB-clock bound');
    assert.equal(attachment.retiredAt, null);
    assert.equal(attachment.deletedAt, null);

    // Blob binding: the handoff fenced the current generation.
    const effects = await readFinalizeSideEffects(isolated.runtime, id.blobId, input.attachmentId, input.operationId);
    assert.equal(effects.blob?.logicalState, 'attached_private');
    assert.equal(effects.blob?.attachmentBindingId, input.attachmentId);
    assert.equal(effects.blob?.attachmentBindingGenerationId, id.generationId);
    assert.equal(effects.blob?.attachmentBindingEtag, input.expectedEtag);
    assert.equal(effects.blob?.attachmentBindingPolicyVersion, input.policyRevision);

    // Operation + Audit.
    assert.equal(effects.operations.length, 1);
    const operation = effects.operations[0]!;
    assert.equal(operation.operationId, input.operationId);
    assert.equal(operation.collectionId, input.collectionId);
    assert.equal(operation.commitOrdinal, 1n);
    assert.equal(operation.operationType, 'attachment.finalized');
    assert.equal(operation.payloadJson.attachmentId, input.attachmentId);
    assert.equal(operation.payloadJson.blobId, id.blobId);
    assert.equal(operation.actorPrincipalId, input.actorPrincipalId);
    const audit = effects.audits[0]!;
    assert.equal(audit.operationId, input.operationId);
    assert.equal(audit.collectionId, input.collectionId);
    assert.equal(audit.eventType, 'attachment.finalized');
    assert.equal(audit.principalId, input.actorPrincipalId);
    assert.equal(audit.detailsJson.attachmentId, input.attachmentId);

    // Outbox: one closed event bound to the blob aggregate.
    assert.equal(effects.outbox.length, 1);
    const outbox = effects.outbox[0]!;
    assert.equal(outbox.eventType, ATTACHMENT_FINALIZED_EVENT_TYPE);
    assert.equal(outbox.eventVersion, ATTACHMENT_FINALIZED_EVENT_VERSION);
    assert.equal(outbox.handlerName, ATTACHMENT_FINALIZED_HANDLER_NAME);
    assert.equal(outbox.aggregateType, 'blob');
    assert.equal(outbox.aggregateId, id.blobId);
    assert.equal(outbox.aggregateScope, input.attachmentId);
    assert.equal(outbox.commitOrdinal, 1n);
    assert.equal(outbox.state, 'pending');
    assert.equal(outbox.payloadJson.attachmentId, input.attachmentId);
    assert.equal(outbox.payloadJson.blobId, id.blobId);
    assert.equal(outbox.payloadJson.operationId, input.operationId);
    assert.equal(outbox.payloadJson.commitOrdinal, '1');
    assert.ok(!('sanitizedFilename' in outbox.payloadJson) && !('key' in outbox.payloadJson)
      && !('url' in outbox.payloadJson), 'outbox payload carries no filename/key/URL');

    // Ledger: attachment + operation + outbox + domain-event ids all reserved.
    const ledger = new Set(await readLedgerIds(isolated.runtime));
    assert.ok(ledger.has(input.attachmentId), 'attachment id must be ledger-reserved');
    assert.ok(ledger.has(input.operationId), 'operation id must be ledger-reserved');
    assert.ok(ledger.has(outbox.outboxId), 'outbox id must be ledger-reserved');
    assert.ok(ledger.has(outbox.domainEventId), 'domain event id must be ledger-reserved');

    // Collection revision advanced exactly once.
    const collection = await readP02CollectionRow(isolated.runtime, P02_COLLECTION_A);
    assert.ok(collection);
    assert.equal(collection.commitOrdinal, 1n);
  });

  test('same-binding replay returns the ORIGINAL receipt (already_finalized) and writes nothing new', async () => {
    const id = identityFor(101);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);
    const first = await finalizeInTx(isolated.runtime, assembly, input);
    assert.equal(first.outcome, 'finalized');
    if (first.outcome !== 'finalized') return;
    const before = await readFinalizeSideEffects(isolated.runtime, id.blobId, input.attachmentId, input.operationId);

    // Exact replay: same attachment id AND same operation id.
    const replay = await finalizeInTx(isolated.runtime, assembly, input);
    assert.equal(replay.outcome, 'already_finalized', 'same idempotency replay is success, never a unique violation');
    if (replay.outcome !== 'already_finalized') return;
    assert.equal(replay.receipt.attachmentId, input.attachmentId);
    assert.equal(replay.receipt.operationId, input.operationId);
    assert.equal(replay.receipt.commitOrdinal, first.receipt.commitOrdinal, 'the original receipt is returned');

    // Replay with a DIFFERENT operation id still returns the ORIGINAL receipt.
    const replayOtherOperation = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(id, { operationId: `p02-operation-replay-${id.generationId}` }),
    );
    assert.equal(replayOtherOperation.outcome, 'already_finalized');
    if (replayOtherOperation.outcome !== 'already_finalized') return;
    assert.equal(replayOtherOperation.receipt.operationId, input.operationId, 'the committed operation id is returned');
    assert.equal(replayOtherOperation.receipt.commitOrdinal, first.receipt.commitOrdinal);

    const after = await readFinalizeSideEffects(isolated.runtime, id.blobId, input.attachmentId, input.operationId);
    assert.deepEqual(after, before, 'replays must not create any new row');
  });

  test('a different binding on the same blob is a permanent binding_conflict', async () => {
    const id = identityFor(102);
    await seedP02StoredPrivate(isolated.runtime, id);
    const first = await finalizeInTx(isolated.runtime, assembly, p02FinalizeInput(id));
    assert.equal(first.outcome, 'finalized');
    if (first.outcome !== 'finalized') return;

    const conflict = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(id, { attachmentId: `p02-attachment-other-${id.generationId}` }),
    );
    assert.equal(conflict.outcome, 'binding_conflict');
    if (conflict.outcome !== 'binding_conflict') return;
    assert.equal(conflict.existingAttachmentId, first.receipt.attachmentId);

    const row = await readAttachmentRow(isolated.runtime, id.blobId);
    assert.ok(row);
    assert.equal(row.attachmentId, first.receipt.attachmentId, 'the committed binding is never overwritten');
  });

  test('collection authorization: missing, deleted, foreign-owner and cross-Collection bindings are rejected with zero side effects', async () => {
    // Missing collection.
    const missing = identityFor(103);
    await seedP02StoredPrivate(isolated.runtime, missing);
    const ledgerBefore = await readLedgerIds(isolated.runtime);
    const missingResult = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(missing, { collectionId: 'p02-collection-does-not-exist' }),
    );
    assert.equal(missingResult.outcome, 'collection_not_found');
    assert.deepEqual(await readLedgerIds(isolated.runtime), ledgerBefore,
      'ledger unchanged (no reservations on rejection)');
    assert.equal(await readAttachmentRow(isolated.runtime, missing.blobId), null);

    // Deleted collection.
    const deleted = identityFor(104);
    await seedP02StoredPrivate(isolated.runtime, deleted, P02_COLLECTION_C);
    await deleteP02Collection(isolated.runtime, P02_COLLECTION_C);
    const deletedResult = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(deleted, { collectionId: P02_COLLECTION_C }),
    );
    assert.equal(deletedResult.outcome, 'collection_deleted');
    assert.equal(await readAttachmentRow(isolated.runtime, deleted.blobId), null);

    // Foreign-owner collection: the collection exists but is owned by another subject.
    const foreign = identityFor(105);
    await seedP02StoredPrivate(isolated.runtime, foreign, P02_COLLECTION_OTHER);
    const foreignResult = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(foreign, { collectionId: P02_COLLECTION_OTHER }),
    );
    assert.equal(foreignResult.outcome, 'collection_owner_mismatch');
    assert.equal(await readAttachmentRow(isolated.runtime, foreign.blobId), null);

    // Cross-Collection binding: the intent was issued for P02_COLLECTION_A but
    // the finalize claims P02_COLLECTION_B (same owner).
    const cross = identityFor(106);
    await seedP02StoredPrivate(isolated.runtime, cross, P02_COLLECTION_A);
    const crossInput = p02FinalizeInput(cross, { collectionId: P02_COLLECTION_B });
    const crossResult = await finalizeInTx(isolated.runtime, assembly, crossInput);
    assert.equal(crossResult.outcome, 'collection_binding_mismatch');
    assert.equal(await readAttachmentRow(isolated.runtime, cross.blobId), null);
    const crossBlob = await readFinalizeSideEffects(isolated.runtime, cross.blobId, crossInput.attachmentId, crossInput.operationId);
    assert.equal(crossBlob.blob?.logicalState, 'stored_private', 'the blob binding must not be written on rejection');
  });

  test('handoff rejections pass through with the stable outcomes', async () => {
    const wrongEtag = identityFor(107);
    await seedP02StoredPrivate(isolated.runtime, wrongEtag);
    const etagResult = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(wrongEtag, { expectedEtag: '"wrong-etag"' }),
    );
    assert.equal(etagResult.outcome, 'etag_mismatch');

    const wrongOwner = identityFor(108);
    // The blob belongs to P02_OTHER_SUBJECT while the INPUT claims the
    // P02 owner (whose collection passes authorization); the handoff must
    // reject the blob owner mismatch before any metadata is written.
    await seedP02StoredPrivate(isolated.runtime, wrongOwner, P02_COLLECTION_A, { ownerSubjectId: P02_OTHER_SUBJECT });
    const ownerResult = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(wrongOwner, { ownerSubjectId: P02_SUBJECT_OWNER }),
    );
    assert.equal(ownerResult.outcome, 'owner_mismatch');

    const wrongFacts = identityFor(109);
    await seedP02StoredPrivate(isolated.runtime, wrongFacts);
    const factsResult = await finalizeInTx(
      isolated.runtime,
      assembly,
      p02FinalizeInput(wrongFacts, { verifiedSize: 999 }),
    );
    assert.equal(factsResult.outcome, 'verified_facts_mismatch');

    const expired = identityFor(110);
    await seedP02StoredPrivate(isolated.runtime, expired, P02_COLLECTION_A, { retentionExpired: true });
    const expiredResult = await finalizeInTx(isolated.runtime, assembly, p02FinalizeInput(expired));
    assert.equal(expiredResult.outcome, 'expired');

    const missingBlob = identityFor(111);
    const missingResult = await finalizeInTx(isolated.runtime, assembly, p02FinalizeInput(missingBlob));
    assert.equal(missingResult.outcome, 'not_found');
  });

  test('rollback after the deepest write leaves Attachment, ledger, blob binding, Operation/Audit/Outbox and collection ordinal byte-identical', async () => {
    const id = identityFor(112);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);
    const before = await readFinalizeSideEffects(isolated.runtime, id.blobId, input.attachmentId, input.operationId);

    const failing = createPostgresAttachmentCanonicalMutationPorts({
      faultInjector: {
        afterPhase: async (phase) => {
          if (phase === 'outbox') throw new Error('p02-rollback-fault');
        },
      },
    });
    await assert.rejects(
      createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
        failing.finalizeAttachment(transaction, input)),
      /p02-rollback-fault/,
    );

    const after = await readFinalizeSideEffects(isolated.runtime, id.blobId, input.attachmentId, input.operationId);
    assert.deepEqual(after.attachments, before.attachments, 'no half-committed Attachment metadata');
    assert.deepEqual(after.blob, before.blob, 'no half-committed blob binding');
    assert.deepEqual(after.operations, before.operations, 'no half-committed Operation');
    assert.deepEqual(after.audits, before.audits, 'no half-committed Audit');
    assert.deepEqual(after.outbox, before.outbox, 'no half-committed Outbox');
    assert.deepEqual(after.collection, before.collection, 'no half-committed collection revision');
    assert.deepEqual(after.ledger, before.ledger, 'no half-committed resource ledger rows');
    assert.equal(before.blob?.logicalState, 'stored_private', 'the pre-state blob was stored_private');
  });

  test('commit-unknown (committed direction) re-reads the database and converges to committed_same with the original receipt', async () => {
    const id = identityFor(113);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);
    // The suite shares collection A across tests, so the expected ordinal is
    // derived from the pre-state (never a hard-coded absolute value).
    const collectionBefore = await readP02CollectionRow(isolated.runtime, P02_COLLECTION_A);
    assert.ok(collectionBefore);

    const faultUow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCommitAcknowledged: async () => {
          throw new Error('simulated lost commit acknowledgement');
        },
      },
    });
    let caught: unknown;
    try {
      await faultUow.execute(({ transaction }) => assembly.finalizeAttachment(transaction, input));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DatabaseOperationError, 'a lost commit response surfaces as commit_outcome_unknown');
    assert.equal(caught.kind, 'commit_outcome_unknown');

    // Recovery re-reads the DATABASE (never infers from the client exception).
    const recovery = await p02Uow(isolated.runtime).execute((tx) =>
      assembly.readAttachmentFinalizeRecoveryFacts(tx, id.blobId));
    assert.equal(recovery.outcome, 'found');
    if (recovery.outcome !== 'found') return;
    const decision = resolveAttachmentFinalizeUnknownOutcome({
      attemptedAttachmentId: input.attachmentId,
      reRead: recovery.facts,
    });
    assert.equal(decision.decision, 'committed_same');
    if (decision.decision !== 'committed_same') return;
    assert.equal(decision.receipt.attachmentId, input.attachmentId);
    assert.equal(decision.receipt.operationId, input.operationId);
    assert.equal(decision.receipt.commitOrdinal, collectionBefore.commitOrdinal + 1n,
      'the committed operation advances the collection ordinal exactly once');

    const replay = await finalizeInTx(isolated.runtime, assembly, input);
    assert.equal(replay.outcome, 'already_finalized', 'same-binding replay converges idempotently');
    if (replay.outcome !== 'already_finalized') return;
    assert.equal(replay.receipt.commitOrdinal, decision.receipt.commitOrdinal);
  });

  test('commit-unknown (not committed direction) re-reads a rolled-back transaction and decides not_committed', async () => {
    const id = identityFor(114);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);

    const faultUow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('p02-pre-commit-fault');
        },
      },
    });
    await assert.rejects(
      faultUow.execute(({ transaction }) => assembly.finalizeAttachment(transaction, input)),
      /p02-pre-commit-fault/,
    );

    const recovery = await p02Uow(isolated.runtime).execute((tx) =>
      assembly.readAttachmentFinalizeRecoveryFacts(tx, id.blobId));
    assert.equal(recovery.outcome, 'found');
    if (recovery.outcome !== 'found') return;
    const decision = resolveAttachmentFinalizeUnknownOutcome({
      attemptedAttachmentId: input.attachmentId,
      reRead: recovery.facts,
    });
    assert.equal(decision.decision, 'not_committed', 'the re-read proves the transaction rolled back');
    assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null);
  });

  test('a committed binding without metadata is detected as inconsistent during recovery (fail closed, never silently recreated)', async () => {
    const id = identityFor(115);
    await seedP02StoredPrivate(isolated.runtime, id);
    // The I13 handoff port alone writes the blob binding (it never creates the
    // production Attachment row) — the recovery layer must treat this N-1 /
    // integrity state as inconsistent instead of fabricating a metadata row.
    const input = p02FinalizeInput(id);
    const handoff = await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const ledger = createPostgresAttachmentsPorts();
      return ledger.finalizeHandoff(transaction, {
        blobId: input.blobId,
        attachmentBindingId: input.attachmentId,
        expectedGenerationId: input.expectedGenerationId,
        ownerSubjectId: input.ownerSubjectId,
        expectedEtag: input.expectedEtag,
        verifiedSize: input.verifiedSize,
        verifiedSha256: input.verifiedSha256,
        mediaType: input.mediaType,
        policyRevision: input.policyRevision,
      });
    });
    assert.equal(handoff.outcome, 'attached');

    const recovery = await p02Uow(isolated.runtime).execute((tx) =>
      assembly.readAttachmentFinalizeRecoveryFacts(tx, id.blobId));
    assert.equal(recovery.outcome, 'found');
    if (recovery.outcome !== 'found') return;
    const decision = resolveAttachmentFinalizeUnknownOutcome({
      attemptedAttachmentId: input.attachmentId,
      reRead: recovery.facts,
    });
    assert.equal(decision.decision, 'inconsistent');
    if (decision.decision !== 'inconsistent') return;
    assert.match(decision.reason, /binding_without_metadata/);
    assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null,
      'recovery must never silently recreate the metadata row');
  });

  test('the canonical assembly requires a caller-provided transaction', async () => {
    await assert.rejects(
      assembly.finalizeAttachment(undefined as unknown as DatabaseTransaction, p02FinalizeInput(identityFor(116))),
      /attachment_finalize_requires_transaction/,
    );
  });

  test('audit and operation rows carry only non-sensitive identity facts', async () => {
    const id = identityFor(117);
    await seedP02StoredPrivate(isolated.runtime, id);
    const input = p02FinalizeInput(id);
    const result = await finalizeInTx(isolated.runtime, assembly, input);
    assert.equal(result.outcome, 'finalized');
    if (result.outcome !== 'finalized') return;

    const operation = await readOperationRow(isolated.runtime, input.operationId);
    assert.ok(operation);
    for (const key of ['sanitizedFilename', 'key', 'url', 'sha256', 'credential']) {
      assert.ok(!(key in operation.payloadJson), `operation payload must not carry ${key}`);
    }
    const audit = await readAuditRow(isolated.runtime, input.operationId);
    assert.ok(audit);
    for (const key of ['sanitizedFilename', 'key', 'url', 'sha256', 'credential']) {
      assert.ok(!(key in audit.detailsJson), `audit details must not carry ${key}`);
    }
  });
});
