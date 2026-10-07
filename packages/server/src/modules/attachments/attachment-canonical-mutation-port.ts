/**
 * P4A-P02 Canonical Attachment Mutation port contract.
 *
 * The assembly is the transaction-bound "Canonical Mutation" for an
 * owner-private Attachment finalize (plan §6 P4A-P02): in ONE caller-provided
 * transaction it performs the Collection authorization lock, the I13 finalize
 * handoff (blob binding), the owner-private Attachment metadata write, the
 * resource ID ledger reservations, the canonical Operation/Audit/Outbox rows
 * and the Collection commit-ordinal advance. Rollback leaves every one of
 * those surfaces byte-identical (the fault-injection rollback suite proves
 * zero half-commit); after a lost commit response the caller re-reads the
 * DATABASE and uses `resolveAttachmentFinalizeUnknownOutcome` to decide —
 * it never infers rollback from the caught exception and never blindly redoes
 * a different Attachment.
 *
 * The physical R2 key/URL/credential never enter any row written by this
 * assembly: the metadata row stores only owner-private snapshot facts, and
 * the Operation/Audit/Outbox payloads carry identity facts only (no filename,
 * no digest, no key).
 */
import type {
  AttachmentMetadataFacts,
} from './attachment-metadata-repository-port.js';
import type {
  AttachmentsLedgerPort,
} from './attachments-repository-port.js';
import type {
  BlobLogicalState,
  GenerationState,
  PhaseBarrier,
} from './attachments-ledger-contract.js';

// ---------------------------------------------------------------------------
// Canonical write phases + fault injection (rollback proofs)
// ---------------------------------------------------------------------------

export type AttachmentCanonicalWritePhase =
  | 'collection_lock'
  | 'blob_binding'
  | 'metadata'
  | 'operation'
  | 'audit'
  | 'outbox'
  | 'revision';

export interface AttachmentCanonicalFaultInjector {
  /**
   * Fires after each write phase inside the caller's transaction. Throwing
   * aborts the whole transaction — the rollback suite injects at the deepest
   * phase and proves zero half-commit across Attachment, resource ledger,
   * blob binding, Operation/Audit/Outbox and the collection ordinal.
   */
  afterPhase?(phase: AttachmentCanonicalWritePhase): void | Promise<void>;
}

export interface AttachmentCanonicalMutationOptions<Transaction = unknown> {
  /** Deterministic test seam; defaults to a no-op barrier. */
  readonly barrier?: PhaseBarrier;
  readonly faultInjector?: AttachmentCanonicalFaultInjector;
  /** Outbox id generator (per-finalize); defaults to randomUUID. */
  readonly outboxIdGenerator?: () => string;
  /** Transaction-bound attachments ledger used for the I13 finalize handoff. */
  readonly ledger?: AttachmentsLedgerPort<Transaction>;
}

// ---------------------------------------------------------------------------
// Finalize input / receipt / result
// ---------------------------------------------------------------------------

export interface FinalizeAttachmentInput {
  readonly blobId: string;
  /** Ledger-reserved Attachment identity; also the I13 handoff binding id. */
  readonly attachmentId: string;
  /** Ledger-reserved Operation identity. */
  readonly operationId: string;
  /** The Collection the owner binds the Attachment to (must match the intent). */
  readonly collectionId: string;
  /** Must equal the blob's committed owner binding AND the collection owner. */
  readonly ownerSubjectId: string;
  /** Sanitized display filename (no separators/control chars; DB-enforced). */
  readonly sanitizedFilename: string | null;
  readonly expectedGenerationId: string;
  readonly expectedEtag: string;
  readonly verifiedSize: number;
  readonly verifiedSha256: string;
  readonly mediaType: string;
  readonly policyRevision: string;
  readonly actorPrincipalId: string;
  /**
   * P4A-P06 idempotency binding: when provided, the canonical Operation
   * payload also carries the Known-Command-Id so the Product finalize use
   * case can re-read the committed receipt after response loss / API restart
   * (identity fact only; never a filename/digest/key/URL).
   */
  readonly commandId?: string;
}

export interface FinalizeAttachmentReceipt {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly logicalState: 'attached_private';
}

export type FinalizeAttachmentResult =
  | { outcome: 'finalized'; receipt: FinalizeAttachmentReceipt }
  | { outcome: 'already_finalized'; receipt: FinalizeAttachmentReceipt }
  | { outcome: 'binding_conflict'; existingAttachmentId: string }
  | { outcome: 'collection_not_found' }
  | { outcome: 'collection_deleted' }
  | { outcome: 'collection_owner_mismatch' }
  | { outcome: 'collection_binding_mismatch' }
  | { outcome: 'not_found' }
  | { outcome: 'not_finalizable'; logicalState: BlobLogicalState }
  | { outcome: 'generation_mismatch'; expectedGenerationId: string; currentGenerationId: string | null }
  | { outcome: 'owner_mismatch' }
  | { outcome: 'etag_mismatch' }
  | { outcome: 'verified_facts_mismatch'; code: 'size' | 'digest' | 'media' }
  | { outcome: 'policy_mismatch' }
  | { outcome: 'expired' }
  | { outcome: 'inconsistent'; reason: string };

// ---------------------------------------------------------------------------
// Closed outbox payload (identity facts only — no filename/digest/key/URL)
// ---------------------------------------------------------------------------

export interface AttachmentFinalizedOutboxPayload {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly collectionId: string;
  readonly operationId: string;
  /** Decimal string (JSON-safe bigint) of the collection commit ordinal. */
  readonly commitOrdinal: string;
}

// ---------------------------------------------------------------------------
// P4A-P07 canonical retirement: attachment metadata + generation retirement +
// pointer clear in ONE caller transaction (identity facts only, no R2).
// ---------------------------------------------------------------------------

export interface RetireAttachmentInput {
  readonly blobId: string;
  /** Must equal the committed `blob_records.attachment_binding_id`. */
  readonly attachmentId: string;
  /** Ledger-reserved Operation identity. */
  readonly operationId: string;
  readonly collectionId: string;
  /** Must equal the blob's committed owner binding AND the collection owner. */
  readonly ownerSubjectId: string;
  /** Must equal the CURRENT active generation (the fence never follows a moved pointer). */
  readonly expectedGenerationId: string;
  readonly actorPrincipalId: string;
  /**
   * P4A-P07 idempotency binding: the canonical Operation payload also carries
   * the Known-Command-Id so the Product retire use case can re-read the
   * committed receipt after response loss / API restart.
   */
  readonly commandId?: string;
}

export interface RetireAttachmentReceipt {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly logicalState: 'retired';
}

export type RetireAttachmentResult =
  | { outcome: 'retired'; receipt: RetireAttachmentReceipt }
  | { outcome: 'already_retired'; receipt: RetireAttachmentReceipt }
  | { outcome: 'collection_not_found' }
  | { outcome: 'collection_deleted' }
  | { outcome: 'collection_owner_mismatch' }
  | { outcome: 'not_found' }
  | { outcome: 'not_retirable'; logicalState: BlobLogicalState; generationState: GenerationState | null }
  | { outcome: 'generation_mismatch'; expectedGenerationId: string; currentGenerationId: string | null }
  /** Bound blob without a metadata row (or a foreign attachment row). */
  | { outcome: 'binding_missing' }
  | { outcome: 'inconsistent'; reason: string };

/** Closed outbox payload (identity facts only — no filename/digest/key/URL). */
export interface AttachmentRetiredOutboxPayload {
  readonly attachmentId: string;
  readonly blobId: string;
  readonly collectionId: string;
  readonly operationId: string;
  /** Decimal string (JSON-safe bigint) of the collection commit ordinal. */
  readonly commitOrdinal: string;
}

// ---------------------------------------------------------------------------
// Commit-unknown recovery facts + pure decision (retire parity with finalize)
// ---------------------------------------------------------------------------

export interface AttachmentRetireRecoveryFacts {
  readonly blobLogicalState: BlobLogicalState;
  readonly attachmentBindingId: string | null;
  readonly attachment: AttachmentMetadataFacts | null;
  readonly operation: { readonly operationId: string; readonly commitOrdinal: bigint } | null;
}

export type AttachmentRetireUnknownRecoveryDecision =
  | { decision: 'committed_same'; receipt: RetireAttachmentReceipt }
  | { decision: 'committed_different'; attachmentId: string }
  | { decision: 'not_committed' }
  | { decision: 'inconsistent'; reason: string };

/**
 * Commit-unknown recovery for the canonical retire: after a lost commit
 * response the caller re-reads the database and decides — it never infers
 * rollback from the caught exception.
 *  - the committed Attachment row is `retired` with the attempted id ->
 *    `committed_same` (the receipt is rebuilt from the committed Operation);
 *  - a different Attachment row is retired -> `committed_different`;
 *  - the Attachment row is still `attached_private` -> `not_committed` (the
 *    transaction rolled back; a later run may retry);
 *  - any other state -> `inconsistent` (manual review; recovery NEVER
 *    fabricates or redoes the retirement).
 */
export function resolveAttachmentRetireUnknownOutcome(input: {
  readonly attemptedAttachmentId: string;
  readonly reRead: AttachmentRetireRecoveryFacts;
}): AttachmentRetireUnknownRecoveryDecision {
  const { attemptedAttachmentId, reRead } = input;
  const attachment = reRead.attachment;
  if (attachment !== null && attachment.logicalState === 'retired') {
    if (attachment.attachmentId === attemptedAttachmentId) {
      if (reRead.operation === null) {
        return { decision: 'inconsistent', reason: 'retired_without_operation' };
      }
      return {
        decision: 'committed_same',
        receipt: {
          attachmentId: attachment.attachmentId,
          blobId: attachment.blobId,
          operationId: reRead.operation.operationId,
          collectionId: attachment.collectionId,
          commitOrdinal: reRead.operation.commitOrdinal,
          logicalState: 'retired',
        },
      };
    }
    return { decision: 'committed_different', attachmentId: attachment.attachmentId };
  }
  if (attachment !== null && attachment.logicalState === 'attached_private') {
    return { decision: 'not_committed' };
  }
  if (attachment === null && reRead.attachmentBindingId === null && reRead.blobLogicalState === 'attached_private') {
    return { decision: 'inconsistent', reason: 'binding_without_metadata' };
  }
  if (attachment === null && reRead.attachmentBindingId !== null) {
    return { decision: 'inconsistent', reason: 'binding_without_metadata' };
  }
  return { decision: 'inconsistent', reason: `unexpected_state_${reRead.blobLogicalState}` };
}

// ---------------------------------------------------------------------------
// Commit-unknown recovery facts + pure decision
// ---------------------------------------------------------------------------

export interface AttachmentFinalizeRecoveryFacts {
  readonly blobLogicalState: BlobLogicalState;
  readonly attachmentBindingId: string | null;
  readonly attachment: AttachmentMetadataFacts | null;
  readonly operation: { readonly operationId: string; readonly commitOrdinal: bigint } | null;
}

export type AttachmentFinalizeUnknownRecoveryDecision =
  | { decision: 'committed_same'; receipt: FinalizeAttachmentReceipt }
  | { decision: 'committed_different'; existingAttachmentId: string }
  | { decision: 'not_committed' }
  | { decision: 'inconsistent'; reason: string };

/**
 * Commit-unknown recovery for the canonical finalize: after a lost commit
 * response the caller re-reads the database and decides — it never infers
 * rollback from the caught exception.
 *  - the committed Attachment row matches the attempted id -> `committed_same`
 *    (the receipt is rebuilt from the committed Operation row);
 *  - a different Attachment row exists -> `committed_different` (conflict);
 *  - the blob is still `stored_private` -> `not_committed` (the transaction
 *    rolled back; a later run may retry);
 *  - an attached binding without a metadata row (or metadata without an
 *    Operation, or any other unexpected state) -> `inconsistent` (manual
 *    review; the recovery NEVER fabricates or redoes the metadata row).
 */
export function resolveAttachmentFinalizeUnknownOutcome(input: {
  readonly attemptedAttachmentId: string;
  readonly reRead: AttachmentFinalizeRecoveryFacts;
}): AttachmentFinalizeUnknownRecoveryDecision {
  const { attemptedAttachmentId, reRead } = input;
  const attachment = reRead.attachment;
  if (attachment !== null) {
    if (attachment.attachmentId === attemptedAttachmentId) {
      if (reRead.operation === null) {
        return { decision: 'inconsistent', reason: 'metadata_without_operation' };
      }
      return {
        decision: 'committed_same',
        receipt: {
          attachmentId: attachment.attachmentId,
          blobId: attachment.blobId,
          operationId: reRead.operation.operationId,
          collectionId: attachment.collectionId,
          commitOrdinal: reRead.operation.commitOrdinal,
          logicalState: 'attached_private',
        },
      };
    }
    return { decision: 'committed_different', existingAttachmentId: attachment.attachmentId };
  }
  if (reRead.blobLogicalState === 'attached_private') {
    if (reRead.attachmentBindingId === attemptedAttachmentId) {
      return { decision: 'inconsistent', reason: 'binding_without_metadata' };
    }
    return { decision: 'inconsistent', reason: 'attached_binding_differs' };
  }
  if (reRead.blobLogicalState === 'stored_private') {
    return { decision: 'not_committed' };
  }
  return { decision: 'inconsistent', reason: `unexpected_state_${reRead.blobLogicalState}` };
}

// ---------------------------------------------------------------------------
// Combined transaction-bound port
// ---------------------------------------------------------------------------

export interface AttachmentCanonicalMutationPortOptions {
  /** Deterministic test seam; defaults to the factory barrier / no-op. */
  readonly barrier?: PhaseBarrier;
}

export type ReadAttachmentFinalizeRecoveryResult =
  | { outcome: 'found'; facts: AttachmentFinalizeRecoveryFacts }
  | { outcome: 'not_found' };

export interface AttachmentCanonicalMutationPort<Transaction> {
  /**
   * Runs the canonical finalize inside the CALLER's transaction. All
   * rejection paths return BEFORE any ledger reservation or metadata write;
   * success commits Attachment metadata + ledger + blob binding +
   * Operation/Audit/Outbox + collection ordinal together. Same-binding
   * replay returns `already_finalized` with the ORIGINAL committed receipt
   * (never a unique violation).
   */
  finalizeAttachment(
    transaction: Transaction,
    input: FinalizeAttachmentInput,
    options?: AttachmentCanonicalMutationPortOptions,
  ): Promise<FinalizeAttachmentResult>;

  /**
   * Post-commit-unknown re-read of the authoritative facts (blob state,
   * binding, Attachment metadata row, Operation row). Feed the result to
   * `resolveAttachmentFinalizeUnknownOutcome`.
   */
  readAttachmentFinalizeRecoveryFacts(
    transaction: Transaction,
    blobId: string,
  ): Promise<ReadAttachmentFinalizeRecoveryResult>;

  /**
   * P4A-P07: runs the canonical retirement inside the CALLER's transaction.
   * Success commits the Attachment metadata `attached_private -> retired`
   * (DB-clock retired_at), the CURRENT generation `active -> retired`, the
   * blob current-pointer clear (so cleanup may claim the retired generation)
   * and the canonical Operation/Audit/Outbox + collection ordinal together.
   * Same-binding replay returns `already_retired` with the ORIGINAL committed
   * receipt (never a unique violation); `attached_private` is terminal and
   * the pointer can never move again.
   */
  retireAttachment(
    transaction: Transaction,
    input: RetireAttachmentInput,
    options?: AttachmentCanonicalMutationPortOptions,
  ): Promise<RetireAttachmentResult>;

  /**
   * Post-commit-unknown re-read of the authoritative retire facts (blob
   * state, binding, Attachment metadata row, Operation row). Feed the result
   * to `resolveAttachmentRetireUnknownOutcome`.
   */
  readAttachmentRetireRecoveryFacts(
    transaction: Transaction,
    blobId: string,
  ): Promise<ReadAttachmentRetireRecoveryResult>;
}

export type ReadAttachmentRetireRecoveryResult =
  | { outcome: 'found'; facts: AttachmentRetireRecoveryFacts }
  | { outcome: 'not_found' };
