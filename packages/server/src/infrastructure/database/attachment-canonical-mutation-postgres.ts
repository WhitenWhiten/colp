/**
 * P4A-P02 transaction-bound PostgreSQL Canonical Attachment Mutation assembly.
 *
 * `finalizeAttachment` runs the ENTIRE canonical mutation in the CALLER's
 * transaction (never opens a new one, never calls R2): Collection lock +
 * authorization, intent-Collection binding check, I13 finalize handoff (blob
 * binding), Attachment metadata insert, resource ID ledger reservations,
 * canonical Operation/Audit/Outbox rows and the Collection commit-ordinal
 * advance. Every business rejection (including the cross-Collection binding
 * check) returns BEFORE any write, so a rejected finalize can never commit a
 * half state; any failure after a write rolls the WHOLE set back (the P02
 * rollback suite proves zero half-commit across Attachment, ledger, blob
 * binding, Operation/Audit/Outbox and collection ordinal).
 *
 * Lock order is deterministic: Collection row first (FOR UPDATE), then the
 * handoff's blob + current-generation rows — two finalize transactions
 * serializing on the same Collection, or deadlocking across two
 * Collection/blob pairs, are proven by the P02 races suite.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { appendAuditEvent } from './audit-event-payload.js';
import { appendOperationWithPayload } from './operation-payload-store.js';
import { findLatestAttachmentOperationByAttachmentId } from './operation-payload-lookups.js';
import type { DatabaseTransaction } from './unit-of-work.js';
import { createPostgresAttachmentsPorts } from './attachments-postgres-ports.js';
import { createPostgresAttachmentMetadataRepository } from './attachment-metadata-postgres.js';
import type {
  AttachmentMetadataRepositoryPort,
} from '../../modules/attachments/index.js';
import {
  NOOP_BARRIER,
  type AttachmentsLedgerPort,
  type BlobLogicalState,
  type FinalizeHandoffResult,
  type GenerationState,
  type PhaseBarrier,
} from '../../modules/attachments/index.js';
import type {
  AttachmentCanonicalMutationOptions,
  AttachmentCanonicalMutationPort,
  AttachmentCanonicalMutationPortOptions,
  AttachmentFinalizeRecoveryFacts,
  AttachmentRetireRecoveryFacts,
  FinalizeAttachmentInput,
  FinalizeAttachmentReceipt,
  FinalizeAttachmentResult,
  ReadAttachmentFinalizeRecoveryResult,
  ReadAttachmentRetireRecoveryResult,
  RetireAttachmentInput,
  RetireAttachmentReceipt,
  RetireAttachmentResult,
} from '../../modules/attachments/index.js';
import {
  appendAttachmentFinalizedOutbox,
} from '../outbox/attachment-finalized.js';
import { appendAttachmentRetiredOutbox } from '../outbox/attachment-retired.js';

interface CollectionRow {
  id: string;
  owner_subject_id: string;
  commit_ordinal: bigint;
  deleted_at: Date | null;
}

interface IntentRow {
  collection_id: string;
}

interface FinalizeOperationRow {
  operation_id: string;
  commit_ordinal: bigint | string;
}

interface RecoveryBlobRow {
  logical_state: string;
  attachment_binding_id: string | null;
}

interface RetireAttachmentRow {
  attachment_id: string; logical_state: string; collection_id: string;
}

/** The committed operation of an attachment lifecycle event (identity facts only). */
async function readLifecycleOperation(
  tx: DatabaseTransaction,
  operationType: string,
  attachmentId: string,
  collectionId: string,
): Promise<FinalizeOperationRow | null> {
  if (operationType !== 'attachment.finalized' && operationType !== 'attachment.retired') return null;
  return findLatestAttachmentOperationByAttachmentId(
    tx, operationType, collectionId, attachmentId,
  );
}

function retireReceiptOf(
  input: RetireAttachmentInput,
  operation: FinalizeOperationRow,
  commitOrdinal: bigint | string,
): RetireAttachmentReceipt {
  return {
    attachmentId: input.attachmentId,
    blobId: input.blobId,
    operationId: operation.operation_id,
    collectionId: input.collectionId,
    // pg returns int8 as text; normalize so the receipt carries a real bigint.
    commitOrdinal: BigInt(commitOrdinal),
    logicalState: 'retired',
  };
}

function mapHandoffOutcome(result: FinalizeHandoffResult): FinalizeAttachmentResult {
  switch (result.outcome) {
    case 'not_found':
      return { outcome: 'not_found' };
    case 'not_finalizable':
      return { outcome: 'not_finalizable', logicalState: result.logicalState };
    case 'generation_mismatch':
      return {
        outcome: 'generation_mismatch',
        expectedGenerationId: result.expectedGenerationId,
        currentGenerationId: result.currentGenerationId,
      };
    case 'owner_mismatch':
      return { outcome: 'owner_mismatch' };
    case 'etag_mismatch':
      return { outcome: 'etag_mismatch' };
    case 'verified_facts_mismatch':
      return { outcome: 'verified_facts_mismatch', code: result.code };
    case 'policy_mismatch':
      return { outcome: 'policy_mismatch' };
    case 'expired':
      return { outcome: 'expired' };
    default:
      // attached / idempotent / binding_conflict are handled by the caller
      // before mapping; reaching here is a programming error.
      throw new Error(`finalize_attachment_unhandled_handoff_outcome:${result.outcome}`);
  }
}

function receiptOf(
  input: FinalizeAttachmentInput,
  operation: FinalizeOperationRow,
  commitOrdinal: bigint | string,
): FinalizeAttachmentReceipt {
  return {
    attachmentId: input.attachmentId,
    blobId: input.blobId,
    operationId: operation.operation_id,
    collectionId: input.collectionId,
    // pg returns int8 as text; normalize so the receipt carries a real bigint.
    commitOrdinal: BigInt(commitOrdinal),
    logicalState: 'attached_private',
  };
}

async function reserveLedgerId(tx: DatabaseTransaction, resourceId: string, resourceType: string): Promise<void> {
  await tx.insertInto('resource_id_ledger').values({
    resource_id: resourceId,
    resource_type: resourceType,
  }).execute();
}

export function createPostgresAttachmentCanonicalMutationPorts(
  options: AttachmentCanonicalMutationOptions<DatabaseTransaction> = {},
): AttachmentCanonicalMutationPort<DatabaseTransaction> {
  const ledger: AttachmentsLedgerPort<DatabaseTransaction> = options.ledger ?? createPostgresAttachmentsPorts();
  const repository: AttachmentMetadataRepositoryPort<DatabaseTransaction> = createPostgresAttachmentMetadataRepository();
  const outboxIdGenerator = options.outboxIdGenerator ?? randomUUID;
  const factoryBarrier = options.barrier ?? NOOP_BARRIER;
  const faultInjector = options.faultInjector;

  return {
    async finalizeAttachment(
      tx: DatabaseTransaction,
      input: FinalizeAttachmentInput,
      portOptions: AttachmentCanonicalMutationPortOptions = {},
    ): Promise<FinalizeAttachmentResult> {
      // Hard runtime guard: this port is transaction-bound by contract.
      if (!tx) throw new Error('attachment_finalize_requires_transaction');
      const barrier: PhaseBarrier = portOptions.barrier ?? factoryBarrier;

      // 1. Collection authorization + commit-ordinal lock (FOR UPDATE).
      const collectionRows = await sql<CollectionRow>`
        select id, owner_subject_id, commit_ordinal, deleted_at
        from collections where id = ${input.collectionId} for update
      `.execute(tx);
      if (collectionRows.rows.length === 0) return { outcome: 'collection_not_found' };
      const collection = collectionRows.rows[0]!;
      if (collection.deleted_at !== null) return { outcome: 'collection_deleted' };
      if (collection.owner_subject_id !== input.ownerSubjectId) {
        return { outcome: 'collection_owner_mismatch' };
      }
      await barrier.arriveAndWait('attachment_collection_locked');
      await faultInjector?.afterPhase?.('collection_lock' as const);

      // 2. The Attachment must be bound to the SAME Collection that issued the
      // upload. The intent rows are immutable, so this read is race-free; it
      // runs BEFORE the handoff so every business rejection leaves the
      // transaction write-free (a rejected finalize never commits a binding).
      // A generation with NO intent at all is either a missing blob
      // (`not_found`, matching the handoff) or ledger corruption
      // (`inconsistent`).
      const intentRows = await sql<IntentRow>`
        select collection_id from upload_intents
        where generation_id = ${input.expectedGenerationId}
      `.execute(tx);
      if (intentRows.rows.length === 0) {
        const blobRows = await sql<{ blob_id: string }>`
          select blob_id from blob_records where blob_id = ${input.blobId}
        `.execute(tx);
        if (blobRows.rows.length === 0) return { outcome: 'not_found' };
        return { outcome: 'inconsistent', reason: 'intent_missing_for_current_generation' };
      }
      if (intentRows.rows[0]!.collection_id !== input.collectionId) {
        return { outcome: 'collection_binding_mismatch' };
      }

      // 3. Transaction-bound blob handoff (locks blob + current generation,
      // writes the unique future Attachment binding + attached_private).
      const handoff = await ledger.finalizeHandoff(tx, {
        blobId: input.blobId,
        attachmentBindingId: input.attachmentId,
        expectedGenerationId: input.expectedGenerationId,
        ownerSubjectId: input.ownerSubjectId,
        expectedEtag: input.expectedEtag,
        verifiedSize: input.verifiedSize,
        verifiedSha256: input.verifiedSha256,
        mediaType: input.mediaType,
        policyRevision: input.policyRevision,
      }, { barrier });

      if (handoff.outcome === 'idempotent' || handoff.outcome === 'binding_conflict') {
        const existing = await repository.readAttachmentMetadataByBlobId(tx, input.blobId);
        if (handoff.outcome === 'binding_conflict') {
          return {
            outcome: 'binding_conflict',
            existingAttachmentId: existing.outcome === 'found'
              ? existing.attachment.attachmentId
              : handoff.existingBindingId,
          };
        }
        // Same-binding replay: return the ORIGINAL committed receipt and
        // write nothing new (never a unique violation).
        if (existing.outcome === 'not_found') {
          return { outcome: 'inconsistent', reason: 'binding_without_metadata' };
        }
        if (existing.attachment.attachmentId !== input.attachmentId) {
          return { outcome: 'binding_conflict', existingAttachmentId: existing.attachment.attachmentId };
        }
        const operation = await readLifecycleOperation(tx, 'attachment.finalized', input.attachmentId, input.collectionId);
        if (operation === null) {
          return { outcome: 'inconsistent', reason: 'metadata_without_operation' };
        }
        return { outcome: 'already_finalized', receipt: receiptOf(input, operation, operation.commit_ordinal) };
      }
      if (handoff.outcome !== 'attached') return mapHandoffOutcome(handoff);
      await faultInjector?.afterPhase?.('blob_binding' as const);

      // 4. Ledger reservations + owner-private metadata row (FK-bound to the
      // ledger, the blob binding and the collection).
      await reserveLedgerId(tx, input.attachmentId, 'attachment');
      await reserveLedgerId(tx, input.operationId, 'operation');
      const inserted = await repository.insertAttachmentMetadata(tx, {
        attachmentId: input.attachmentId,
        blobId: input.blobId,
        collectionId: input.collectionId,
        ownerSubjectId: input.ownerSubjectId,
        sanitizedFilename: input.sanitizedFilename,
        mediaType: input.mediaType,
        size: input.verifiedSize,
        attachedAt: handoff.binding.attachedAt,
      });
      if (inserted.outcome === 'already_exists') {
        const operation = await readLifecycleOperation(tx, 'attachment.finalized', input.attachmentId, input.collectionId);
        if (operation === null) return { outcome: 'inconsistent', reason: 'metadata_without_operation' };
        return { outcome: 'already_finalized', receipt: receiptOf(input, operation, operation.commit_ordinal) };
      }
      if (inserted.outcome === 'binding_conflict') {
        return { outcome: 'binding_conflict', existingAttachmentId: inserted.existingAttachmentId };
      }
      await faultInjector?.afterPhase?.('metadata' as const);

      // 5. Canonical Operation (identity facts only; no filename/digest/key).
      const commitOrdinal = BigInt(collection.commit_ordinal) + 1n;
      await appendOperationWithPayload(tx, {
        operationId: input.operationId, collectionId: input.collectionId,
        commitOrdinal, operationType: 'attachment.finalized',
        payloadJson: {
          attachmentId: input.attachmentId,
          blobId: input.blobId,
          collectionId: input.collectionId,
          generationId: input.expectedGenerationId,
          // P4A-P06: the Product finalize idempotency binding (identity fact
          // only); the use case re-reads the committed receipt by it after
          // response loss / API restart.
          ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        } as Record<string, unknown>,
        actorPrincipalId: input.actorPrincipalId,
      });
      await faultInjector?.afterPhase?.('operation' as const);

      // 6. Canonical Audit event (identity + verified snapshot facts only).
      await appendAuditEvent(tx, {
        operationId: input.operationId,
        collectionId: input.collectionId,
        principalId: input.actorPrincipalId,
        eventType: 'attachment.finalized',
        details: {
          attachmentId: input.attachmentId,
          blobId: input.blobId,
          collectionId: input.collectionId,
          generationId: input.expectedGenerationId,
          mediaType: input.mediaType,
          size: input.verifiedSize,
        } as Record<string, unknown>,
      });
      await faultInjector?.afterPhase?.('audit' as const);

      // 7. Canonical Outbox (closed identity payload, same transaction).
      await appendAttachmentFinalizedOutbox(tx, {
        attachmentId: input.attachmentId,
        blobId: input.blobId,
        collectionId: input.collectionId,
        operationId: input.operationId,
        commitOrdinal: String(commitOrdinal),
      }, { outboxIdGenerator });
      await faultInjector?.afterPhase?.('outbox' as const);

      // 8. Collection commit-ordinal advance (operations ordinal uniqueness).
      await tx.updateTable('collections').set({
        commit_ordinal: commitOrdinal,
        updated_at: sql<Date>`current_timestamp`,
      }).where('id', '=', input.collectionId).executeTakeFirst();
      await faultInjector?.afterPhase?.('revision' as const);

      return {
        outcome: 'finalized',
        receipt: {
          attachmentId: input.attachmentId,
          blobId: input.blobId,
          operationId: input.operationId,
          collectionId: input.collectionId,
          commitOrdinal,
          logicalState: 'attached_private',
        },
      };
    },

    async readAttachmentFinalizeRecoveryFacts(
      tx: DatabaseTransaction,
      blobId: string,
    ): Promise<ReadAttachmentFinalizeRecoveryResult> {
      if (!tx) throw new Error('attachment_recovery_requires_transaction');
      const blobRows = await sql<RecoveryBlobRow>`
        select logical_state, attachment_binding_id
        from blob_records where blob_id = ${blobId}
      `.execute(tx);
      if (blobRows.rows.length === 0) return { outcome: 'not_found' };
      const blob = blobRows.rows[0]!;
      const metadataRead = await repository.readAttachmentMetadataByBlobId(tx, blobId);
      let operation: { operationId: string; commitOrdinal: bigint } | null = null;
      if (metadataRead.outcome === 'found') {
        const row = await readLifecycleOperation(tx, 'attachment.finalized', metadataRead.attachment.attachmentId, metadataRead.attachment.collectionId);
        if (row !== null) {
          operation = { operationId: row.operation_id, commitOrdinal: BigInt(row.commit_ordinal) };
        }
      }
      const facts: AttachmentFinalizeRecoveryFacts = {
        blobLogicalState: blob.logical_state as BlobLogicalState,
        attachmentBindingId: blob.attachment_binding_id,
        attachment: metadataRead.outcome === 'found' ? metadataRead.attachment : null,
        operation,
      };
      return { outcome: 'found', facts };
    },

    // ---------------------------------------------------------------------
    // P4A-P07 canonical retirement in ONE caller transaction (never R2):
    // metadata -> retired + generation -> retired + pointer clear +
    // Operation/Audit/Outbox + ordinal. Rejections return before any write.
    // ---------------------------------------------------------------------

    async retireAttachment(
      tx: DatabaseTransaction,
      input: RetireAttachmentInput,
      portOptions: AttachmentCanonicalMutationPortOptions = {},
    ): Promise<RetireAttachmentResult> {
      // Hard runtime guard: this port is transaction-bound by contract.
      if (!tx) throw new Error('attachment_retire_requires_transaction');
      const barrier: PhaseBarrier = portOptions.barrier ?? factoryBarrier;

      // 1. Collection lock + authorization (FOR UPDATE), Collection first.
      // 2. Blob + current generation + Attachment metadata FOR UPDATE (the
      //    retirement CAS; the pointer can never move on a bound blob).
      const collectionRows = await sql<CollectionRow>`
        select id, owner_subject_id, commit_ordinal, deleted_at
        from collections where id = ${input.collectionId} for update
      `.execute(tx);
      if (collectionRows.rows.length === 0) return { outcome: 'collection_not_found' };
      const collection = collectionRows.rows[0]!;
      if (collection.deleted_at !== null) return { outcome: 'collection_deleted' };
      if (collection.owner_subject_id !== input.ownerSubjectId) {
        return { outcome: 'collection_owner_mismatch' };
      }
      await barrier.arriveAndWait('attachment_retire_collection_locked');
      await faultInjector?.afterPhase?.('collection_lock' as const);

      const blobRows = await sql<{ logical_state: string; current_generation_id: string | null; attachment_binding_id: string | null }>`
        select logical_state, current_generation_id, attachment_binding_id
        from blob_records where blob_id = ${input.blobId} for update
      `.execute(tx);
      if (blobRows.rows.length === 0) return { outcome: 'not_found' };
      const blob = blobRows.rows[0]!;
      if (blob.attachment_binding_id === null) return { outcome: 'binding_missing' };
      if (blob.attachment_binding_id !== input.attachmentId) {
        return { outcome: 'inconsistent', reason: 'attachment_binding_mismatch' };
      }

      const attachmentRows = await sql<RetireAttachmentRow>`
        select attachment_id, logical_state, collection_id
        from attachments where blob_id = ${input.blobId} for update
      `.execute(tx);
      if (attachmentRows.rows.length === 0) return { outcome: 'binding_missing' };
      const attachment = attachmentRows.rows[0]!;
      if (attachment.attachment_id !== input.attachmentId) {
        return { outcome: 'inconsistent', reason: 'attachment_id_mismatch' };
      }
      if (attachment.logical_state === 'deleted') return { outcome: 'not_found' };
      if (attachment.logical_state === 'retired') {
        const operation = await readLifecycleOperation(tx, 'attachment.retired', input.attachmentId, input.collectionId);
        if (operation === null) return { outcome: 'inconsistent', reason: 'retired_without_operation' };
        return { outcome: 'already_retired', receipt: retireReceiptOf(input, operation, operation.commit_ordinal) };
      }
      if (blob.logical_state !== 'attached_private') {
        return { outcome: 'not_retirable', logicalState: blob.logical_state as BlobLogicalState, generationState: null };
      }
      if (blob.current_generation_id === null) {
        return { outcome: 'not_retirable', logicalState: 'attached_private', generationState: null };
      }
      if (blob.current_generation_id !== input.expectedGenerationId) {
        return {
          outcome: 'generation_mismatch',
          expectedGenerationId: input.expectedGenerationId,
          currentGenerationId: blob.current_generation_id,
        };
      }
      const generationRows = await sql<{ generation_state: string }>`
        select generation_state from blob_generations
        where generation_id = ${input.expectedGenerationId} for update
      `.execute(tx);
      if (generationRows.rows.length === 0) {
        return { outcome: 'inconsistent', reason: 'current_generation_missing' };
      }
      if (generationRows.rows[0]!.generation_state !== 'active') {
        return {
          outcome: 'not_retirable',
          logicalState: 'attached_private',
          generationState: generationRows.rows[0]!.generation_state as GenerationState,
        };
      }

      // 3. The retirement CAS: metadata -> retired (DB-clock retired_at),
      //    generation -> retired, pointer cleared so the cleanup claim
      //    (`current_generation_id is distinct from generation_id`) can
      //    converge the external deletion after the retention window.
      const retiredMetadata = await sql<{ attachment_id: string }>`
        update attachments
        set logical_state = 'retired', retired_at = now(), updated_at = now()
        where blob_id = ${input.blobId} and attachment_id = ${input.attachmentId}
          and logical_state = 'attached_private'
        returning attachment_id
      `.execute(tx);
      if (retiredMetadata.rows.length === 0) {
        // Row-locked above; a zero-row CAS means a concurrent writer moved
        // the state under us — the re-read decides (never a blind retry).
        const reRead = await sql<{ logical_state: string }>`
          select logical_state from attachments where blob_id = ${input.blobId}
        `.execute(tx);
        if (reRead.rows.length === 0) return { outcome: 'binding_missing' };
        if (reRead.rows[0]!.logical_state === 'retired') {
          const operation = await readLifecycleOperation(tx, 'attachment.retired', input.attachmentId, input.collectionId);
          if (operation === null) return { outcome: 'inconsistent', reason: 'retired_without_operation' };
          return { outcome: 'already_retired', receipt: retireReceiptOf(input, operation, operation.commit_ordinal) };
        }
        return { outcome: 'inconsistent', reason: 'retirement_cas_lost' };
      }
      await faultInjector?.afterPhase?.('metadata' as const);
      await sql`
        update blob_generations set generation_state = 'retired', retired_at = now()
        where generation_id = ${input.expectedGenerationId} and generation_state = 'active'
      `.execute(tx);
      await sql`
        update blob_records set current_generation_id = null, updated_at = now()
        where blob_id = ${input.blobId}
      `.execute(tx);
      await faultInjector?.afterPhase?.('blob_binding' as const);

      // 4. Canonical Operation (identity facts only). The operation id must
      //    be reserved in the immutable resource_id_ledger first (the same
      //    canonical contract the finalize assembly obeys — the operations
      //    PK references the ledger).
      const commitOrdinal = BigInt(collection.commit_ordinal) + 1n;
      await reserveLedgerId(tx, input.operationId, 'operation');
      await appendOperationWithPayload(tx, {
        operationId: input.operationId, collectionId: input.collectionId,
        commitOrdinal, operationType: 'attachment.retired',
        payloadJson: {
          attachmentId: input.attachmentId,
          blobId: input.blobId,
          collectionId: input.collectionId,
          generationId: input.expectedGenerationId,
          ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        } as Record<string, unknown>,
        actorPrincipalId: input.actorPrincipalId,
      });
      await faultInjector?.afterPhase?.('operation' as const);

      // 5. Canonical Audit event (identity + retirement facts only).
      await appendAuditEvent(tx, {
        operationId: input.operationId,
        collectionId: input.collectionId,
        principalId: input.actorPrincipalId,
        eventType: 'attachment.retired',
        details: {
          attachmentId: input.attachmentId,
          blobId: input.blobId,
          collectionId: input.collectionId,
          generationId: input.expectedGenerationId,
        } as Record<string, unknown>,
      });
      await faultInjector?.afterPhase?.('audit' as const);

      // 6. Canonical Outbox (closed identity payload, same transaction).
      await appendAttachmentRetiredOutbox(tx, {
        attachmentId: input.attachmentId,
        blobId: input.blobId,
        collectionId: input.collectionId,
        operationId: input.operationId,
        commitOrdinal: String(commitOrdinal),
      }, { outboxIdGenerator });
      await faultInjector?.afterPhase?.('outbox' as const);

      // 7. Collection commit-ordinal advance.
      await tx.updateTable('collections').set({
        commit_ordinal: commitOrdinal,
        updated_at: sql<Date>`current_timestamp`,
      }).where('id', '=', input.collectionId).executeTakeFirst();
      await faultInjector?.afterPhase?.('revision' as const);

      return {
        outcome: 'retired',
        receipt: {
          attachmentId: input.attachmentId,
          blobId: input.blobId,
          operationId: input.operationId,
          collectionId: input.collectionId,
          commitOrdinal,
          logicalState: 'retired',
        },
      };
    },

    async readAttachmentRetireRecoveryFacts(
      tx: DatabaseTransaction,
      blobId: string,
    ): Promise<ReadAttachmentRetireRecoveryResult> {
      if (!tx) throw new Error('attachment_retire_recovery_requires_transaction');
      const blobRows = await sql<RecoveryBlobRow>`
        select logical_state, attachment_binding_id
        from blob_records where blob_id = ${blobId}
      `.execute(tx);
      if (blobRows.rows.length === 0) return { outcome: 'not_found' };
      const blob = blobRows.rows[0]!;
      const metadataRead = await repository.readAttachmentMetadataByBlobId(tx, blobId);
      let operation: { operationId: string; commitOrdinal: bigint } | null = null;
      if (metadataRead.outcome === 'found') {
        const row = await readLifecycleOperation(tx, 'attachment.retired', metadataRead.attachment.attachmentId, metadataRead.attachment.collectionId);
        if (row !== null) {
          operation = { operationId: row.operation_id, commitOrdinal: BigInt(row.commit_ordinal) };
        }
      }
      const facts: AttachmentRetireRecoveryFacts = {
        blobLogicalState: blob.logical_state as BlobLogicalState,
        attachmentBindingId: blob.attachment_binding_id,
        attachment: metadataRead.outcome === 'found' ? metadataRead.attachment : null,
        operation,
      };
      return { outcome: 'found', facts };
    },
  };
}
