/**
 * P4A-I07 transaction-bound attachments ledger port.
 *
 * Every method REQUIRES a caller-provided transaction and never opens a new
 * connection. State transitions use expected state/generation/attempt-token
 * CAS; the database clock is the state-time authority. The port is generic
 * over the transaction type so the module never leaks Kysely/pg types;
 * `src/infrastructure/database/attachments-postgres-ports.ts` binds
 * `DatabaseTransaction`.
 */
import type {
  BlobLogicalState,
  CleanupKeysetCursor,
  CleanupVerdict,
  GenerationState,
  PhaseBarrier,
} from './attachments-ledger-contract.js';

export interface AttachmentsPortOptions {
  /** Deterministic test seam; defaults to a no-op barrier. */
  readonly barrier?: PhaseBarrier;
}

// P4A-I09 port type additions for attachments-repository-port.ts
//

// ---------------------------------------------------------------------------
// P4A-I09 complete: resolve the committed generation for HEAD attestation
// ---------------------------------------------------------------------------

export interface CompleteUploadTargetInput {
  readonly intentId: string;
  readonly generationId: string;
  readonly blobId: string;
}

export interface CompleteUploadTargetFacts {
  readonly intentId: string;
  readonly generationId: string;
  readonly blobId: string;
  readonly key: string;
  readonly bucket: string;
  readonly principalId: string;
  readonly expectedSize: number | null;
  readonly expectedSha256: string | null;
  readonly mediaHint: string | null;
  readonly expiresAt: Date;
  readonly generationState: GenerationState;
  readonly blobLogicalState: BlobLogicalState;
  readonly currentGenerationId: string | null;
  readonly observedEtag: string | null;
  readonly observedSize: number | null;
}

export type CompleteUploadTargetResult =
  | { outcome: 'found'; facts: CompleteUploadTargetFacts }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// P4A-I09 complete CAS: issued -> uploaded + bound observed facts (same commit
// as the verification outbox enqueue, which the use case performs inside the
// SAME transaction through its injected enqueue dep).
// ---------------------------------------------------------------------------

export interface CompleteUploadCasInput {
  readonly intentId: string;
  readonly generationId: string;
  readonly blobId: string;
  readonly actorPrincipalId: string;
  readonly declaredSize: number;
  readonly declaredSha256: string;
  readonly declaredMediaType: string;
  readonly observedEtag: string;
  readonly observedSize: number;
  readonly observedContentType: string | null;
  /** Canonicalized then allowlist-checked before any SQL is issued. */
  readonly observedMetadata: Readonly<Record<string, string>>;
}

export type CompleteUploadCasResult =
  | { outcome: 'uploaded' }
  | { outcome: 'idempotent' }
  | { outcome: 'already_verified' }
  | { outcome: 'late_rejected'; reason: LateCompleteReason }
  | { outcome: 'declared_facts_mismatch'; code: 'size' | 'digest' | 'media' }
  | { outcome: 'identity_mismatch' }
  | { outcome: 'principal_mismatch' }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// P4A-I09 verification lease + CAS (uploaded -> verifying -> stored_private)
// ---------------------------------------------------------------------------

/** The outbox claim fence the worker presents on every verification write. */
export interface VerificationAttemptFence {
  readonly outboxId: string;
  /** Outbox `lease_generation` (bigint as string from the outbox claim). */
  readonly leaseGeneration: string;
}

export interface ClaimVerificationInput {
  readonly blobId: string;
  readonly generationId: string;
  readonly attempt: VerificationAttemptFence;
  readonly leaseTtlSeconds: number;
}

export interface VerificationTargetFacts {
  readonly bucket: string;
  readonly key: string;
  readonly observedEtag: string | null;
  readonly observedSize: number | null;
  readonly expectedSize: number | null;
  readonly expectedSha256: string | null;
  readonly mediaHint: string | null;
  readonly generationState: GenerationState;
  readonly blobLogicalState: BlobLogicalState;
}

export type ClaimVerificationResult =
  | {
      outcome: 'claimed';
      facts: VerificationTargetFacts;
      leaseOwner: string;
      leaseGeneration: string;
      leaseExpiresAt: Date;
    }
  | { outcome: 'already_stored' }
  | { outcome: 'already_expired' }
  /** FIX-L-045: the event's generation is authoritatively replaced/retired
   * (or already deleted) — terminal; the outbox row completes and the new
   * generation is never touched. */
  | { outcome: 'already_replaced' }
  | { outcome: 'lease_lost' }
  | { outcome: 'not_found' };

export interface CompleteVerificationInput {
  readonly blobId: string;
  readonly generationId: string;
  readonly attempt: VerificationAttemptFence;
  readonly verifiedSize: number;
  readonly verifiedSha256: string;
  readonly mediaType: string;
  readonly policyVersion: string;
}

export type CompleteVerificationResult =
  | { outcome: 'stored_private' }
  | { outcome: 'lease_lost' }
  | { outcome: 'not_found' };

export interface QuarantineVerificationInput {
  readonly blobId: string;
  readonly generationId: string;
  readonly attempt: VerificationAttemptFence;
  /** Stable, non-sensitive corruption reason (e.g. `digest_mismatch`). */
  readonly reason: string;
}

export type QuarantineVerificationResult =
  | { outcome: 'quarantined' }
  | { outcome: 'lease_lost' }
  | { outcome: 'not_found' };


// ---------------------------------------------------------------------------
// allocate: ledger-before-grant in ONE transaction
// ---------------------------------------------------------------------------

export interface AllocateGenerationInput {
  readonly blobId: string;
  readonly intentId: string;
  readonly generationId: string;
  readonly principalId: string;
  readonly collectionId: string;
  readonly subjectIdentity: string;
  readonly bucket: string;
  readonly key: string;
  readonly keyFingerprint: string;
  readonly expectedSize?: number | null;
  readonly expectedSha256?: string | null;
  readonly mediaHint?: string | null;
  readonly policyRevision: string;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
}

export type AllocateGenerationResult =
  | { outcome: 'issued'; intentId: string; generationId: string; blobId: string }
  | { outcome: 'already_issued'; intentId: string; generationId: string; blobId: string };

// ---------------------------------------------------------------------------
// complete: bind exact ETag/size/metadata; first complete -> active
// ---------------------------------------------------------------------------

export interface CompleteGenerationInput {
  readonly intentId: string;
  readonly generationId: string;
  readonly blobId: string;
  readonly observedEtag: string;
  readonly observedSize: number;
  readonly observedContentType: string | null;
  /** Canonicalized then allowlist-checked before any SQL is issued. */
  readonly observedMetadata: Readonly<Record<string, string>>;
}

export type LateCompleteReason =
  | 'expired'
  | 'replaced'
  | 'orphaned'
  | 'deleted'
  | 'quarantined'
  | 'contract_corrupt'
  | 'not_current'
  | 'not_completable';

export type CompleteGenerationResult =
  | { outcome: 'verified_active' }
  | { outcome: 'verified_observed' }
  | { outcome: 'idempotent' }
  | { outcome: 'late_rejected'; reason: LateCompleteReason }
  | { outcome: 'identity_mismatch' }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// activateReplacement: one-transaction active/retired CAS
// ---------------------------------------------------------------------------

export interface ActivateReplacementInput {
  readonly blobId: string;
  readonly expectedActiveGenerationId: string | null;
  readonly newGenerationId: string;
}

export type ActivateReplacementResult =
  | { outcome: 'activated' }
  | { outcome: 'idempotent' }
  | { outcome: 'stale_cas' }
  | { outcome: 'new_not_verified' }
  | { outcome: 'new_not_found' }
  | { outcome: 'blob_not_found' }
  // P4A-I13: a blob that already carries a committed future Attachment
  // binding (`attached_private`) is terminal; the current generation pointer
  // can never be moved again, so replacement cannot break the binding.
  | { outcome: 'attached_not_replaced' };

// ---------------------------------------------------------------------------
// claimCleanup: snapshot exact candidate + attempt token + DB-time deadline
// ---------------------------------------------------------------------------

export interface CleanupClaim {
  readonly generationId: string;
  /** DB-sourced created_at of the claimed generation (keyset pagination key). */
  readonly createdAt: Date;
  readonly blobId: string;
  readonly bucket: string;
  readonly key: string;
  readonly keyFingerprint: string;
  readonly observedEtag: string | null;
  readonly observedSize: number | null;
  readonly leaseOwner: string;
  readonly attemptToken: string;
  readonly leaseGeneration: bigint;
  readonly leaseExpiresAt: Date;
  readonly currentGenerationId: string | null;
}

export interface ClaimCleanupInput {
  readonly leaseOwner: string;
  readonly leaseTtlSeconds: number;
  /** Direct claim by identity. */
  readonly generationId?: string;
  /** Keyset batch mode: bounded page size (1..1000). */
  readonly limit?: number;
  /** Keyset batch mode: strictly-after cursor; null starts at the beginning. */
  readonly cursor?: CleanupKeysetCursor | null;
  /**
   * P4A-I14: whole-day retired/orphan retention deadline compared against the
   * DATABASE clock (`coalesce(retired_at, orphaned_at) <= now() - days`, the
   * boundary is inclusive). Omit for the I07 raw-fence behavior (no retention
   * filter). `deletion_pending` rows are always eligible (already past
   * retention); `allocated` generations whose intent expired are reconciled
   * to orphaned (orphaned_at = DB now) before the retention filter applies.
   */
  readonly retiredRetentionDays?: number;
}

export type ClaimCleanupResult =
  | { outcome: 'claimed'; claim: CleanupClaim }
  | { outcome: 'batch'; claims: readonly CleanupClaim[] }
  | { outcome: 'none' }
  | { outcome: 'lease_held' }
  | { outcome: 'not_claimable' };

// ---------------------------------------------------------------------------
// completeCleanup: CAS under the exact claim fence
// ---------------------------------------------------------------------------

export interface CompleteCleanupInput {
  readonly claim: CleanupClaim;
  readonly verdict: CleanupVerdict;
  readonly mismatchReason?: string;
}

export type CompleteCleanupResult =
  | { outcome: 'completed'; state: 'deleted' }
  | { outcome: 'quarantined' }
  | { outcome: 'released' }
  | { outcome: 'lease_lost' }
  | { outcome: 'already_deleted' }
  | { outcome: 'already_quarantined' }
  | { outcome: 'not_claimable' };

// ---------------------------------------------------------------------------
// readCleanupState: re-read a claimed generation's row after commit-unknown
// ---------------------------------------------------------------------------

export interface ReadCleanupStateInput {
  readonly generationId: string;
}

export interface CleanupRowState {
  readonly generationState: GenerationState;
  readonly cleanupAttemptToken: string | null;
  readonly cleanupLeaseOwner: string | null;
  readonly cleanupLeaseGeneration: bigint | string;
}

export type ReadCleanupStateResult =
  | { outcome: 'found'; row: CleanupRowState }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// finalizeLock: FOR UPDATE on stored_private blob + current generation
// ---------------------------------------------------------------------------

export interface FinalizeLockInput {
  readonly blobId: string;
  readonly leaseOwner: string;
  readonly leaseTtlSeconds: number;
  readonly expectedGenerationId?: string | null;
}

export type FinalizeLockResult =
  | {
      outcome: 'locked';
      blobId: string;
      logicalState: 'stored_private';
      currentGenerationId: string;
      finalizeLeaseOwner: string;
      finalizeLeaseExpiresAt: Date;
    }
  | { outcome: 'not_found' }
  | { outcome: 'not_finalizable'; logicalState: string }
  | { outcome: 'generation_mismatch'; expectedGenerationId: string; currentGenerationId: string | null };

// ---------------------------------------------------------------------------
// P4A-I13 finalizeHandoff: transaction-bound stored_private -> attached_private
//
// The future Canonical Mutation calls this port INSIDE its own transaction to
// fence the CURRENT stored_private blob + current active generation and write
// the unique future Attachment binding facts (attachment binding id + DB-clock
// bound_at + immutable binding snapshot) atomically with the
// `stored_private -> attached_private` transition. The port:
//   - REQUIRES a caller-provided transaction object and never opens a new one;
//   - performs NO R2 / network call and never returns a physical key;
//   - takes FOR UPDATE on the blob row and the current generation row (the
//     cleanup claim takes FOR SHARE on the blob row, so the two prove mutual
//     exclusion at the lock level);
//   - verifies logical state, current generation, owner binding, generation
//     ETag, verified size/digest/media, expiry (retention deadline against the
//     DB clock) and the verification policy revision;
//   - does NOT create a production Attachment row, Collection content
//     revision, Operation, Audit or Outbox row — those belong to the future
//     Canonical Mutation caller and are only committed later in the SAME
//     transaction (the caller reserves the Attachment ID in the global
//     resource_id_ledger).
//
// Same-binding replay returns the committed result (idempotent success); a
// different binding on an already-bound blob conflicts. After a lost commit
// response the caller re-reads the binding and uses
// `resolveFinalizeUnknownOutcome` to decide — it must never blindly redo a
// different Attachment.
// ---------------------------------------------------------------------------

export interface FinalizeHandoffInput {
  readonly blobId: string;
  /** Unique future Attachment binding identity reserved by the caller's ID ledger. */
  readonly attachmentBindingId: string;
  /** Must equal the CURRENT active generation; the fence never follows a moved pointer. */
  readonly expectedGenerationId: string;
  /** Must equal the committed owner binding of the blob. */
  readonly ownerSubjectId: string;
  /** Must equal the current generation's observed ETag. */
  readonly expectedEtag: string;
  /** Must equal the verified size bound at stored_private. */
  readonly verifiedSize: number;
  /** Must equal the verified SHA-256 bound at stored_private. */
  readonly verifiedSha256: string;
  /** Must equal the verified media type bound at stored_private. */
  readonly mediaType: string;
  /** Must equal the verification policy revision recorded at stored_private. */
  readonly policyRevision: string;
}

/** The immutable future Attachment binding facts written by the handoff. */
export interface FinalizeBindingFacts {
  readonly blobId: string;
  readonly attachmentBindingId: string;
  /** Generation fenced at bind time (snapshot; CHECK keeps it == current_generation_id). */
  readonly generationId: string;
  /** Generation ETag fenced at bind time. */
  readonly etag: string;
  /** Policy revision verified at bind time. */
  readonly policyVersion: string;
  /** DB-clock bind time. */
  readonly attachedAt: Date;
}

export type FinalizeHandoffResult =
  | { outcome: 'attached'; binding: FinalizeBindingFacts }
  | { outcome: 'idempotent'; binding: FinalizeBindingFacts }
  | { outcome: 'binding_conflict'; existingBindingId: string; binding: FinalizeBindingFacts }
  | { outcome: 'not_found' }
  | { outcome: 'not_finalizable'; logicalState: BlobLogicalState }
  | { outcome: 'generation_mismatch'; expectedGenerationId: string; currentGenerationId: string | null }
  | { outcome: 'owner_mismatch' }
  | { outcome: 'etag_mismatch' }
  | { outcome: 'verified_facts_mismatch'; code: 'size' | 'digest' | 'media' }
  | { outcome: 'policy_mismatch' }
  | { outcome: 'expired' };

/** Row facts the pure evaluator needs; the SQL port loads them under FOR UPDATE. */
export interface FinalizeHandoffRowFacts {
  readonly blobId: string;
  readonly logicalState: BlobLogicalState;
  readonly ownerSubjectId: string;
  readonly currentGenerationId: string | null;
  readonly verifiedSize: number | null;
  readonly verifiedSha256: string | null;
  readonly mediaType: string | null;
  readonly verificationPolicyVersion: string | null;
  readonly retentionDeadline: Date | string | null;
  /** DB clock snapshot used for the expiry check (never a JS wall clock). */
  readonly now: Date | string;
  readonly generationState: GenerationState | null;
  readonly observedEtag: string | null;
  readonly attachmentBindingId: string | null;
  readonly attachedAt: Date | string | null;
  readonly attachmentBindingGenerationId: string | null;
  readonly attachmentBindingEtag: string | null;
  readonly attachmentBindingPolicyVersion: string | null;
}

export type FinalizeHandoffRejection =
  | { code: 'not_finalizable'; logicalState: BlobLogicalState }
  | { code: 'generation_mismatch'; expectedGenerationId: string; currentGenerationId: string | null }
  | { code: 'owner_mismatch'; expectedOwnerSubjectId: string; ownerSubjectId: string }
  | { code: 'etag_mismatch'; expectedEtag: string; observedEtag: string | null }
  | { code: 'verified_facts_mismatch'; verifiedFacts: ('size' | 'digest' | 'media')[] }
  | { code: 'policy_mismatch'; expectedPolicyRevision: string; policyRevision: string | null }
  | { code: 'expired'; retentionDeadline: Date | string | null }
  | { code: 'binding_corrupt' };

export type FinalizeHandoffEvaluation =
  | { verdict: 'attach' }
  | { verdict: 'idempotent'; binding: FinalizeBindingFacts }
  | { verdict: 'binding_conflict'; binding: FinalizeBindingFacts }
  | { verdict: 'reject'; rejection: FinalizeHandoffRejection };

function toDate(value: Date | string | null): number | null {
  if (value === null) return null;
  return new Date(value).getTime();
}

function bindingFactsFromRow(row: FinalizeHandoffRowFacts): FinalizeBindingFacts | null {
  if (row.attachmentBindingId === null || row.attachedAt === null
    || row.attachmentBindingGenerationId === null || row.attachmentBindingEtag === null
    || row.attachmentBindingPolicyVersion === null) {
    return null;
  }
  return {
    blobId: row.blobId,
    attachmentBindingId: row.attachmentBindingId,
    generationId: row.attachmentBindingGenerationId,
    etag: row.attachmentBindingEtag,
    policyVersion: row.attachmentBindingPolicyVersion,
    attachedAt: new Date(row.attachedAt),
  };
}

/**
 * Pure handoff decision: given the locked row facts and the caller input,
 * decide attach / idempotent / binding_conflict / reject. The SQL port runs
 * this against facts read under FOR UPDATE and then performs the CAS update
 * only for `attach`. Unit tests pin the full verification matrix here so the
 * SQL layer only maps the decision to SQL.
 */
export function evaluateFinalizeHandoff(
  row: FinalizeHandoffRowFacts,
  input: FinalizeHandoffInput,
): FinalizeHandoffEvaluation {
  if (row.logicalState === 'attached_private') {
    const existing = bindingFactsFromRow(row);
    if (existing === null) return { verdict: 'reject', rejection: { code: 'binding_corrupt' } };
    if (existing.attachmentBindingId === input.attachmentBindingId) {
      return { verdict: 'idempotent', binding: existing };
    }
    return { verdict: 'binding_conflict', binding: existing };
  }
  if (row.logicalState !== 'stored_private') {
    return { verdict: 'reject', rejection: { code: 'not_finalizable', logicalState: row.logicalState } };
  }
  if (row.currentGenerationId === null) {
    return { verdict: 'reject', rejection: { code: 'not_finalizable', logicalState: row.logicalState } };
  }
  if (input.expectedGenerationId !== row.currentGenerationId) {
    return {
      verdict: 'reject',
      rejection: {
        code: 'generation_mismatch',
        expectedGenerationId: input.expectedGenerationId,
        currentGenerationId: row.currentGenerationId,
      },
    };
  }
  // The current generation must exist and be active for the handoff to fence it.
  if (row.generationState === null || row.generationState !== 'active') {
    return { verdict: 'reject', rejection: { code: 'not_finalizable', logicalState: row.logicalState } };
  }
  const retentionDeadlineMs = toDate(row.retentionDeadline);
  const nowMs = toDate(row.now);
  if (retentionDeadlineMs !== null && nowMs !== null && retentionDeadlineMs <= nowMs) {
    return { verdict: 'reject', rejection: { code: 'expired', retentionDeadline: row.retentionDeadline } };
  }
  if (input.ownerSubjectId !== row.ownerSubjectId) {
    return {
      verdict: 'reject',
      rejection: { code: 'owner_mismatch', expectedOwnerSubjectId: input.ownerSubjectId, ownerSubjectId: row.ownerSubjectId },
    };
  }
  if (input.expectedEtag !== row.observedEtag) {
    return {
      verdict: 'reject',
      rejection: { code: 'etag_mismatch', expectedEtag: input.expectedEtag, observedEtag: row.observedEtag },
    };
  }
  const verifiedFacts: ('size' | 'digest' | 'media')[] = [];
  if (row.verifiedSize === null || row.verifiedSize !== input.verifiedSize) verifiedFacts.push('size');
  if (row.verifiedSha256 === null || row.verifiedSha256 !== input.verifiedSha256) verifiedFacts.push('digest');
  if (row.mediaType === null || row.mediaType !== input.mediaType) verifiedFacts.push('media');
  if (verifiedFacts.length > 0) {
    return { verdict: 'reject', rejection: { code: 'verified_facts_mismatch', verifiedFacts } };
  }
  if (row.verificationPolicyVersion === null || row.verificationPolicyVersion !== input.policyRevision) {
    return {
      verdict: 'reject',
      rejection: {
        code: 'policy_mismatch',
        expectedPolicyRevision: input.policyRevision,
        policyRevision: row.verificationPolicyVersion,
      },
    };
  }
  return { verdict: 'attach' };
}

// ---------------------------------------------------------------------------
// Commit-unknown recovery: re-read the binding to decide, never blindly redo
// a different Attachment. The caller passes the attempted binding id and the
// CURRENT committed facts read from the database after a lost commit response.
// ---------------------------------------------------------------------------

export type FinalizeUnknownRecoveryDecision =
  | { decision: 'committed_same_binding'; binding: FinalizeBindingFacts }
  | { decision: 'committed_different_binding'; existingBindingId: string; binding: FinalizeBindingFacts }
  | { decision: 'not_committed' }
  | { decision: 'inconsistent'; reason: string };

export function resolveFinalizeUnknownOutcome(input: {
  readonly attemptedBindingId: string;
  readonly reRead:
    | { outcome: 'attached'; binding: FinalizeBindingFacts }
    | { outcome: 'stored_private' }
    | { outcome: 'not_found' }
    | { outcome: 'other'; logicalState: BlobLogicalState };
}): FinalizeUnknownRecoveryDecision {
  const { attemptedBindingId, reRead } = input;
  if (reRead.outcome === 'attached') {
    if (reRead.binding.attachmentBindingId === attemptedBindingId) {
      return { decision: 'committed_same_binding', binding: reRead.binding };
    }
    return { decision: 'committed_different_binding', existingBindingId: reRead.binding.attachmentBindingId, binding: reRead.binding };
  }
  if (reRead.outcome === 'stored_private') return { decision: 'not_committed' };
  if (reRead.outcome === 'not_found') {
    return { decision: 'inconsistent', reason: 'blob_not_found_after_commit_attempt' };
  }
  return { decision: 'inconsistent', reason: `unexpected_state_${reRead.logicalState}` };
}

// ---------------------------------------------------------------------------
// quarantineGeneration: explicit contract-corruption quarantine
// ---------------------------------------------------------------------------

export interface QuarantineGenerationInput {
  readonly generationId: string;
  readonly reason: string;
}

export type QuarantineGenerationResult =
  | { outcome: 'quarantined' }
  | { outcome: 'already_quarantined' }
  | { outcome: 'already_deleted' }
  | { outcome: 'not_claimable' }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// findIntentByBinding: recover the committed intent/generation for an
// idempotency binding. P4A-I08 uses this both for same-binding recovery and
// for the database re-read after any unknown outcome (commit response lost,
// collision, race). The physical key is returned because the grant for the
// committed generation can only be re-signed from committed ledger facts; the
// receipt never contains it and it is never logged.
// ---------------------------------------------------------------------------

export interface FindIntentByBindingInput {
  readonly collectionId: string;
  readonly subjectIdentity: string;
  readonly idempotencyKey: string;
}

export interface StoredIntentFacts {
  readonly intentId: string;
  readonly generationId: string;
  readonly blobId: string;
  readonly key: string;
  readonly principalId: string;
  readonly collectionId: string;
  readonly subjectIdentity: string;
  readonly expectedSize: number | null;
  readonly expectedSha256: string | null;
  readonly mediaHint: string | null;
  readonly policyRevision: string;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
}

export type FindIntentByBindingResult =
  | { outcome: 'found'; intent: StoredIntentFacts }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// P4A-I10 delivery admission: resolve the CURRENT active generation + owner +
// policy facts from the opaque logical blob identity. The physical key is
// NEVER returned: delivery admission must not leak the R2 key, and the
// isolated origin (I11) resolves the exact generation itself from the
// capability binding (blobId + generationId) over its own RO path.
// ---------------------------------------------------------------------------

export interface FindBlobForDeliveryInput {
  readonly blobId: string;
}

export interface BlobForDeliveryFacts {
  readonly blobId: string;
  readonly ownerSubjectId: string;
  readonly logicalState: BlobLogicalState;
  /** Owning collection resolved from the current generation's intent. */
  readonly collectionId: string | null;
  readonly currentGenerationId: string | null;
  readonly currentGenerationState: GenerationState | null;
  readonly verifiedSize: number | null;
  readonly verifiedSha256: string | null;
  readonly mediaType: string | null;
  readonly verificationPolicyVersion: string | null;
}

export type FindBlobForDeliveryResult =
  | { outcome: 'found'; facts: BlobForDeliveryFacts }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// P4A-P04 status read: resolve the current blob/generation/intent facts for
// the owner-private status DTO. The physical key, key fingerprint, digest,
// provider metadata, and lease facts are NEVER selected or returned — the DTO
// cannot leak what the port never loads. The attachment metadata join carries
// the terminal `retired`/`deleted` facts so the read can conceal them exactly
// like a missing blob (frozen contract).
// ---------------------------------------------------------------------------

export interface FindBlobForStatusInput {
  readonly blobId: string;
}

export interface StatusBlobFacts {
  readonly blobId: string;
  readonly ownerSubjectId: string;
  readonly logicalState: BlobLogicalState;
  readonly currentGenerationId: string | null;
  readonly currentGenerationState: GenerationState | null;
  /** Owning collection resolved from the current generation's intent. */
  readonly collectionId: string | null;
  /** Verified size bound at stored_private (DB fact; never a digest). */
  readonly verifiedSize: number | null;
  /** Verified media type bound at stored_private. */
  readonly mediaType: string | null;
  /** Declared intent size (pre-verification facts). */
  readonly expectedSize: number | null;
  /** Declared intent media hint (pre-verification facts). */
  readonly mediaHint: string | null;
  /** DB-clock blob facts. */
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Terminal attachment metadata fact; null when no metadata row exists. */
  readonly attachmentLogicalState: 'attached_private' | 'retired' | 'deleted' | null;
}

export type FindBlobForStatusResult =
  | { outcome: 'found'; facts: StatusBlobFacts }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// P4A-P06 finalize resolution: current blob/generation/intent/metadata facts
// the Product finalize use case derives its canonical input from, plus the
// committed idempotency receipt re-read keyed by the persisted commandId.
// The physical key, key fingerprint, provider metadata, and lease facts are
// never selected; the attachment metadata join surfaces the terminal
// retired/deleted facts for concealment.
// ---------------------------------------------------------------------------

export interface FinalizeBlobFacts {
  readonly blobId: string;
  readonly ownerSubjectId: string;
  readonly logicalState: BlobLogicalState;
  readonly currentGenerationId: string | null;
  readonly currentGenerationState: GenerationState | null;
  /** Owning collection resolved from the current generation's intent. */
  readonly collectionId: string | null;
  /** The current generation's observed ETag (the handoff fences it). */
  readonly observedEtag: string | null;
  /** Verified facts bound at stored_private (never a digest leak). */
  readonly verifiedSize: number | null;
  readonly verifiedSha256: string | null;
  readonly mediaType: string | null;
  readonly verificationPolicyVersion: string | null;
  /** Terminal attachment metadata fact; null when no metadata row exists. */
  readonly attachmentLogicalState: 'attached_private' | 'retired' | 'deleted' | null;
}

export type FindBlobForFinalizeResult =
  | { outcome: 'found'; facts: FinalizeBlobFacts }
  | { outcome: 'not_found' };

export interface FindBlobForFinalizeInput {
  readonly blobId: string;
}

/** The committed finalize receipt facts for one Known-Command-Id. */
export interface CommittedFinalizeFacts {
  readonly operationId: string;
  readonly commitOrdinal: bigint;
  readonly collectionId: string;
  readonly attachmentId: string;
  readonly blobId: string;
}

export type FindFinalizeByCommandIdResult =
  | { outcome: 'found'; facts: CommittedFinalizeFacts }
  | { outcome: 'not_found' };

export interface FindFinalizeByCommandIdInput {
  readonly commandId: string;
}

// ---------------------------------------------------------------------------
// P4A-P07 replacement resolution: recover the committed replacement intent
// for an idempotency binding on ONE blob. The physical key is returned because
// the grant for the committed generation can only be re-signed from committed
// ledger facts; the receipt never contains it and it is never logged.
// ---------------------------------------------------------------------------

export interface FindReplacementIntentByBindingInput {
  readonly blobId: string;
  readonly idempotencyKey: string;
}

export type FindReplacementIntentByBindingResult =
  | { outcome: 'found'; intent: StoredIntentFacts }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// P4A-P07 retire resolution: current blob/generation + the committed
// Attachment metadata identity/state. The physical key, key fingerprint,
// digest, provider metadata and lease facts are never selected; the
// attachments join surfaces the terminal retired/deleted facts for
// concealment AND the committed attachment id the canonical retirement needs.
// ---------------------------------------------------------------------------

export interface FindBlobForRetireInput {
  readonly blobId: string;
}

export interface RetireBlobFacts {
  readonly blobId: string;
  readonly ownerSubjectId: string;
  readonly logicalState: BlobLogicalState;
  readonly currentGenerationId: string | null;
  readonly currentGenerationState: GenerationState | null;
  /** Owning collection resolved from the current generation's intent. */
  readonly collectionId: string | null;
  /** Committed Attachment metadata identity/state; null when not finalized. */
  readonly attachment: {
    readonly attachmentId: string;
    readonly logicalState: 'attached_private' | 'retired' | 'deleted';
  } | null;
}

export type FindBlobForRetireResult =
  | { outcome: 'found'; facts: RetireBlobFacts }
  | { outcome: 'not_found' };

/** The committed retire receipt facts for one Known-Command-Id. */
export interface CommittedRetireFacts {
  readonly operationId: string;
  readonly commitOrdinal: bigint;
  readonly collectionId: string;
  readonly attachmentId: string;
  readonly blobId: string;
}

export type FindRetireByCommandIdResult =
  | { outcome: 'found'; facts: CommittedRetireFacts }
  | { outcome: 'not_found' };

export interface FindRetireByCommandIdInput {
  readonly commandId: string;
}
// ---------------------------------------------------------------------------
// Combined transaction-bound port
// ---------------------------------------------------------------------------

export interface AttachmentsLedgerPort<Transaction> {
  findIntentByBinding(
    transaction: Transaction,
    input: FindIntentByBindingInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindIntentByBindingResult>;

  allocate(
    transaction: Transaction,
    input: AllocateGenerationInput,
    options?: AttachmentsPortOptions,
  ): Promise<AllocateGenerationResult>;

  complete(
    transaction: Transaction,
    input: CompleteGenerationInput,
    options?: AttachmentsPortOptions,
  ): Promise<CompleteGenerationResult>;

  activateReplacement(
    transaction: Transaction,
    input: ActivateReplacementInput,
    options?: AttachmentsPortOptions,
  ): Promise<ActivateReplacementResult>;

  claimCleanup(
    transaction: Transaction,
    input: ClaimCleanupInput,
    options?: AttachmentsPortOptions,
  ): Promise<ClaimCleanupResult>;

  completeCleanup(
    transaction: Transaction,
    input: CompleteCleanupInput,
    options?: AttachmentsPortOptions,
  ): Promise<CompleteCleanupResult>;

  readCleanupState(
    transaction: Transaction,
    input: ReadCleanupStateInput,
    options?: AttachmentsPortOptions,
  ): Promise<ReadCleanupStateResult>;

  finalizeLock(
    transaction: Transaction,
    input: FinalizeLockInput,
    options?: AttachmentsPortOptions,
  ): Promise<FinalizeLockResult>;

  finalizeHandoff(
    transaction: Transaction,
    input: FinalizeHandoffInput,
    options?: AttachmentsPortOptions,
  ): Promise<FinalizeHandoffResult>;

  quarantineGeneration(
    transaction: Transaction,
    input: QuarantineGenerationInput,
    options?: AttachmentsPortOptions,
  ): Promise<QuarantineGenerationResult>;

  // ---- P4A-I09 attest + verify ------------------------------------------

  findCompleteTarget(
    transaction: Transaction,
    input: CompleteUploadTargetInput,
    options?: AttachmentsPortOptions,
  ): Promise<CompleteUploadTargetResult>;

  completeUploadCas(
    transaction: Transaction,
    input: CompleteUploadCasInput,
    options?: AttachmentsPortOptions,
  ): Promise<CompleteUploadCasResult>;

  claimVerification(
    transaction: Transaction,
    input: ClaimVerificationInput,
    options?: AttachmentsPortOptions,
  ): Promise<ClaimVerificationResult>;

  completeVerification(
    transaction: Transaction,
    input: CompleteVerificationInput,
    options?: AttachmentsPortOptions,
  ): Promise<CompleteVerificationResult>;

  quarantineVerification(
    transaction: Transaction,
    input: QuarantineVerificationInput,
    options?: AttachmentsPortOptions,
  ): Promise<QuarantineVerificationResult>;

  findBlobForDelivery(
    transaction: Transaction,
    input: FindBlobForDeliveryInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindBlobForDeliveryResult>;

  findBlobForStatus(
    transaction: Transaction,
    input: FindBlobForStatusInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindBlobForStatusResult>;

  findBlobForFinalize(
    transaction: Transaction,
    input: FindBlobForFinalizeInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindBlobForFinalizeResult>;

  findFinalizeByCommandId(
    transaction: Transaction,
    input: FindFinalizeByCommandIdInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindFinalizeByCommandIdResult>;

  // ---- P4A-P07 replacement / retirement lifecycle -------------------------

  findReplacementIntentByBinding(
    transaction: Transaction,
    input: FindReplacementIntentByBindingInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindReplacementIntentByBindingResult>;

  findBlobForRetire(
    transaction: Transaction,
    input: FindBlobForRetireInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindBlobForRetireResult>;

  findRetireByCommandId(
    transaction: Transaction,
    input: FindRetireByCommandIdInput,
    options?: AttachmentsPortOptions,
  ): Promise<FindRetireByCommandIdResult>;
}
