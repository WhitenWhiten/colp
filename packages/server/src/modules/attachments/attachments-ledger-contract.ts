/**
 * P4A-I07 attachments ledger contract: pure state machines, stable identity
 * error classes, cleanup CAS verdict resolution, lease takeover, keyset cursor
 * logic, and the fixed provider-metadata allowlist.
 *
 * This file is the single source of truth for the production schema's logical
 * states, named constraints, and metadata allowlist. It contains no SQL and no
 * I/O, so the unit suite can pin the contract without a database; the expand
 * migration and the PostgreSQL ports both consume these constants.
 */

// ---------------------------------------------------------------------------
// §3.2 physical generation state machine
// ---------------------------------------------------------------------------

export const GENERATION_STATES = [
  'allocated', 'observed', 'active', 'orphaned', 'retired', 'deletion_pending',
  'deleted', 'contract_corrupt', 'quarantined',
] as const;
export type GenerationState = typeof GENERATION_STATES[number];

export const GENERATION_TRANSITIONS: Record<GenerationState, readonly GenerationState[]> = {
  allocated: ['observed', 'orphaned', 'contract_corrupt'],
  observed: ['active', 'orphaned', 'contract_corrupt'],
  active: ['retired', 'contract_corrupt'],
  orphaned: ['deletion_pending', 'contract_corrupt'],
  retired: ['deletion_pending', 'contract_corrupt'],
  deletion_pending: ['deleted', 'contract_corrupt'],
  contract_corrupt: ['quarantined'],
  deleted: [],
  quarantined: [],
};

export function generationTransitionIsLegal(from: GenerationState, to: GenerationState): boolean {
  return GENERATION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// §3.1 logical blob state machine
// ---------------------------------------------------------------------------

export const BLOB_LOGICAL_STATES = [
  'issued', 'uploaded', 'verifying', 'stored_private', 'attached_private', 'expired',
] as const;
export type BlobLogicalState = typeof BLOB_LOGICAL_STATES[number];

export const BLOB_LOGICAL_TRANSITIONS: Record<BlobLogicalState, readonly BlobLogicalState[]> = {
  issued: ['uploaded', 'expired'],
  uploaded: ['verifying', 'expired'],
  verifying: ['stored_private', 'expired'],
  stored_private: ['attached_private', 'expired'],
  attached_private: [],
  expired: [],
};

export function blobLogicalTransitionIsLegal(from: BlobLogicalState, to: BlobLogicalState): boolean {
  return BLOB_LOGICAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Named production constraints (single source of truth for DDL + mapping)
// ---------------------------------------------------------------------------

export const ATTACHMENTS_CONSTRAINT_NAMES = {
  generationKeysPkey: 'generation_keys_pkey',
  generationKeysKeyUnique: 'generation_keys_key_unique',
  generationKeysFingerprintUnique: 'generation_keys_key_fingerprint_unique',
  generationKeysReasonCheck: 'generation_keys_created_reason_check',
  blobRecordsLogicalStateCheck: 'blob_records_logical_state_check',
  blobRecordsVerifiedFactsCheck: 'blob_records_verified_facts_check',
  blobRecordsCurrentGenerationFk: 'blob_records_current_generation_fk',
  blobGenerationsStateCheck: 'blob_generations_generation_state_check',
  blobGenerationsDeletedFactsCheck: 'blob_generations_deleted_facts_check',
  blobGenerationsCorruptFactsCheck: 'blob_generations_contract_corrupt_facts_check',
  blobGenerationsQuarantineFactsCheck: 'blob_generations_quarantine_facts_check',
  blobGenerationsBlobFk: 'blob_generations_blob_fk',
  blobGenerationsGenerationKeyFk: 'blob_generations_generation_key_fk',
  blobGenerationsBlobGenerationUnique: 'blob_generations_blob_generation_unique',
  blobGenerationsKeyUnique: 'blob_generations_key_unique',
  blobGenerationsKeyFingerprintUnique: 'blob_generations_key_fingerprint_unique',
  blobGenerationsMetadataAllowlistCheck: 'blob_generations_metadata_allowlist_check',
  blobGenerationsMetadataShapeCheck: 'blob_generations_metadata_shape_check',
  blobGenerationsOneActivePerBlob: 'blob_generations_one_active_per_blob',
  uploadIntentsGenerationUnique: 'upload_intents_generation_id_unique',
  uploadIntentsBlobFk: 'upload_intents_blob_fk',
  uploadIntentsGenerationFk: 'upload_intents_generation_fk',
  uploadIntentsIdempotencyUnique: 'upload_intents_blob_idempotency_unique',
  // P4A-I13 future Attachment binding: the unique binding identity, the
  // DB-clock bound time, and the immutable binding snapshot facts written by
  // the transaction-bound finalize handoff. The generation snapshot CHECK
  // guarantees a committed binding never points at a generation that is not
  // the current one (replacement of an attached blob is refused by the port).
  blobRecordsAttachmentBindingUnique: 'blob_records_attachment_binding_id_unique',
  blobRecordsAttachedBindingFactsCheck: 'blob_records_attached_binding_facts_check',
  blobRecordsAttachedBindingGenerationCheck: 'blob_records_attached_binding_generation_check',
  // P4A-P02 owner-private Attachment metadata (expand migration
  // 202608080500_phase4a_p02_attachment_metadata): the durable metadata row
  // is keyed by the ledger-reserved Attachment id, bound 1:1 to the committed
  // blob_records binding (trigger), and carries only owner-private snapshot
  // facts. The named unique + trigger make a second Attachment on the same
  // blob a permanent identity violation; the terminal-facts CHECKs make
  // retirement/deletion durable.
  attachmentsLogicalStateCheck: 'attachments_logical_state_check',
  attachmentsSizeCheck: 'attachments_size_check',
  attachmentsSanitizedFilenameCheck: 'attachments_sanitized_filename_check',
  attachmentsRetirementFactsCheck: 'attachments_retirement_facts_check',
  attachmentsDeletionFactsCheck: 'attachments_deletion_facts_check',
  attachmentsActiveStateFactsCheck: 'attachments_active_state_facts_check',
  attachmentsLedgerFk: 'attachments_attachment_id_fk',
  attachmentsBlobFk: 'attachments_blob_id_fk',
  attachmentsCollectionFk: 'attachments_collection_id_fk',
  attachmentsBlobUnique: 'attachments_blob_id_unique',
} as const;

/** Constraint names that mean a physical/identity uniqueness boundary was hit. */
export const ATTACHMENTS_IDENTITY_CONSTRAINTS: Record<string, string> = {
  [ATTACHMENTS_CONSTRAINT_NAMES.generationKeysPkey]: 'generation_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.generationKeysKeyUnique]: 'key_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.generationKeysFingerprintUnique]: 'fingerprint_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.uploadIntentsGenerationUnique]: 'generation_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.uploadIntentsIdempotencyUnique]: 'idempotency_conflict',
  [ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsKeyUnique]: 'key_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsKeyFingerprintUnique]: 'fingerprint_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.blobGenerationsOneActivePerBlob]: 'one_active_per_blob',
  [ATTACHMENTS_CONSTRAINT_NAMES.blobRecordsAttachmentBindingUnique]: 'attachment_binding_issued',
  [ATTACHMENTS_CONSTRAINT_NAMES.attachmentsBlobUnique]: 'attachment_binding_issued',
};

// ---------------------------------------------------------------------------
// Stable error classes
// ---------------------------------------------------------------------------

export type AttachmentsFailureClass = 'identity_failure' | 'retryable' | 'unknown_outcome' | 'database_failure';

export interface AttachmentsFailureClassification {
  readonly class: AttachmentsFailureClass;
  readonly code?: string;
  readonly constraint?: string | null;
}

/**
 * Identity failures are a distinct class from retryable database failures: a
 * same-key reissue, a duplicate generation, or a second active generation is a
 * permanent contract violation; a deadlock/serialization/lock_timeout is a
 * designed bounded-retry condition; a commit_outcome_unknown is neither.
 */
export class AttachmentsIdentityError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'AttachmentsIdentityError';
    this.code = code;
  }
}

export function attachmentsIdentityCodeForConstraint(constraint: string | null): string | null {
  if (constraint === null) return null;
  return ATTACHMENTS_IDENTITY_CONSTRAINTS[constraint] ?? null;
}

const RETRYABLE_KINDS = new Set(['serialization_failure', 'deadlock', 'lock_timeout', 'unavailable']);

interface ClassifiableDatabaseFailure {
  readonly kind?: unknown;
  readonly constraint?: unknown;
}

/**
 * Structural classification so the pure module contract never imports
 * infrastructure error types. `DatabaseOperationError` satisfies the
 * `{ kind, constraint }` shape.
 */
export function classifyAttachmentsLedgerError(error: unknown): AttachmentsFailureClassification {
  if (error instanceof AttachmentsIdentityError) {
    return { class: 'identity_failure', code: error.code };
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as ClassifiableDatabaseFailure;
    if (typeof candidate.kind === 'string') {
      if (candidate.kind === 'commit_outcome_unknown') return { class: 'unknown_outcome' };
      if (RETRYABLE_KINDS.has(candidate.kind)) return { class: 'retryable' };
      if (candidate.kind === 'unique_violation' && typeof candidate.constraint === 'string') {
        const code = attachmentsIdentityCodeForConstraint(candidate.constraint);
        if (code) return { class: 'identity_failure', code, constraint: candidate.constraint };
      }
      return {
        class: 'database_failure',
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
      };
    }
  }
  return { class: 'database_failure' };
}

// ---------------------------------------------------------------------------
// Object-store port (HEAD/DELETE happen OUTSIDE the database transaction)
// ---------------------------------------------------------------------------

export type HeadOutcome =
  | { class: 'ok'; etag: string; size: number }
  | { class: 'not_found' }
  | { class: 'denied' }
  | { class: 'retryable' }
  | { class: 'unknown' };

export type DeleteOutcome =
  | { class: 'deleted' }
  | { class: 'not_found' }
  | { class: 'denied' }
  | { class: 'retryable' }
  | { class: 'unknown' };

export interface AttachmentsObjectStorePort {
  head(candidate: { bucket: string; key: string }): Promise<HeadOutcome>;
  deleteExactKey(candidate: { bucket: string; key: string }): Promise<DeleteOutcome>;
}

// ---------------------------------------------------------------------------
// Cleanup CAS verdict resolution
// ---------------------------------------------------------------------------

export type CleanupVerdict = 'confirmed_absent' | 'deleted' | 'candidate_mismatch' | 'unknown_retryable';

export interface CleanupClaimFacts {
  readonly observedEtag: string | null;
  readonly observedSize: number | null;
}

export interface ResolveCleanupVerdictInput {
  readonly claim: CleanupClaimFacts;
  readonly headBefore: HeadOutcome;
  readonly deleteOutcome?: DeleteOutcome;
  readonly headAfter?: HeadOutcome;
}

export interface ResolveCleanupVerdictResult {
  readonly verdict: CleanupVerdict;
  readonly detail: string;
  readonly deleteAttempted: boolean;
}

export function candidateMatchesClaim(claim: CleanupClaimFacts, head: { etag: string; size: number }): boolean {
  return claim.observedEtag === head.etag && claim.observedSize === head.size;
}

/**
 * Resolves the cleanup verdict from the exact provider facts. A candidate
 * mismatch quarantines and short-circuits BEFORE any DELETE, while a
 * DELETE-unknown outcome that is later reconciled to absent via HEAD converges
 * as `deleted`.
 */
export function resolveCleanupVerdict(input: ResolveCleanupVerdictInput): ResolveCleanupVerdictResult {
  const { claim, headBefore, deleteOutcome, headAfter } = input;
  if (headBefore.class === 'not_found') {
    return { verdict: 'confirmed_absent', detail: 'exact_key_head_not_found_before_delete', deleteAttempted: false };
  }
  if (headBefore.class === 'ok') {
    if (!candidateMatchesClaim(claim, headBefore)) {
      return {
        verdict: 'candidate_mismatch',
        detail: 'head_etag_size_differs_from_claimed_snapshot',
        deleteAttempted: false,
      };
    }
    if (!deleteOutcome) {
      return { verdict: 'unknown_retryable', detail: 'delete_not_attempted', deleteAttempted: true };
    }
    if (deleteOutcome.class === 'deleted' || deleteOutcome.class === 'not_found') {
      if (headAfter && headAfter.class === 'ok' && candidateMatchesClaim(claim, headAfter)) {
        return { verdict: 'unknown_retryable', detail: 'object_still_present_after_delete', deleteAttempted: true };
      }
      return { verdict: 'deleted', detail: 'delete_plus_confirmed_absent_head', deleteAttempted: true };
    }
    if (deleteOutcome.class === 'unknown') {
      if (headAfter && headAfter.class === 'not_found') {
        return {
          verdict: 'deleted',
          detail: 'delete_unknown_reconciled_absent_by_head',
          deleteAttempted: true,
        };
      }
      if (headAfter && headAfter.class === 'ok' && candidateMatchesClaim(claim, headAfter)) {
        return { verdict: 'unknown_retryable', detail: 'delete_unknown_object_still_present', deleteAttempted: true };
      }
      return { verdict: 'unknown_retryable', detail: 'delete_outcome_unknown', deleteAttempted: true };
    }
    return { verdict: 'unknown_retryable', detail: `delete_${deleteOutcome.class}`, deleteAttempted: true };
  }
  return { verdict: 'unknown_retryable', detail: `head_before_${headBefore.class}`, deleteAttempted: false };
}

// ---------------------------------------------------------------------------
// Lease takeover and claim snapshot matching
// ---------------------------------------------------------------------------

export function canTakeoverCleanupLease(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt === null || leaseExpiresAt.getTime() < now.getTime();
}

export interface ClaimFenceFacts {
  readonly attemptToken: string;
  readonly leaseOwner: string;
  readonly leaseGeneration: bigint;
}

export interface CleanupRowFenceFacts {
  readonly cleanupAttemptToken: string | null;
  readonly cleanupLeaseOwner: string | null;
  readonly cleanupLeaseGeneration: bigint | string;
}

export function claimFactsMatch(claim: ClaimFenceFacts, row: CleanupRowFenceFacts): boolean {
  return claim.attemptToken === row.cleanupAttemptToken
    && claim.leaseOwner === row.cleanupLeaseOwner
    && BigInt(claim.leaseGeneration) === BigInt(row.cleanupLeaseGeneration);
}
// ---------------------------------------------------------------------------
// P4A-I14 cleanup retention deadline and commit-unknown recovery
// ---------------------------------------------------------------------------

/**
 * DB-clock retention rule for a retired/orphaned generation (mirrored exactly
 * by the claim SQL: `coalesce(retired_at, orphaned_at) <= now() - days`).
 * `retiredAt`/`orphanedAt` are DB-sourced timestamps, never a JS wall clock.
 * The boundary is inclusive (`<=`): a generation whose deadline has just been
 * reached IS expired, so clock skew can never omit an eligible candidate. A
 * generation with no retirement timestamp (legacy rows, direct fixtures) is
 * NEVER treated as expired — cleanup must not delete bytes whose retention
 * clock cannot be proven.
 */
export function generationRetentionDeadlineExpired(
  retiredAt: Date | string | null,
  orphanedAt: Date | string | null,
  retiredRetentionDays: number,
  nowMs: number,
): boolean {
  const deadlineMs = Math.max(
    toMs(retiredAt) ?? -Infinity,
    toMs(orphanedAt) ?? -Infinity,
  );
  if (!Number.isFinite(deadlineMs)) return false;
  return deadlineMs + retiredRetentionDays * 24 * 60 * 60 * 1000 <= nowMs;
}

function toMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Commit-unknown recovery for `completeCleanup`: after a lost commit response
 * the coordinator re-reads the generation row and decides — it never infers
 * rollback from the caught exception.
 *  - `deleted` / `quarantined` are terminal: the CAS landed (`committed_*`).
 *  - `deletion_pending` with the SAME claim fence: not committed, the claim is
 *    still held (a later run may retry it after the lease expires).
 *  - `deletion_pending` with a DIFFERENT fence: a newer owner took over the
 *    lease; the late CAS must never be replayed.
 *  - any other state is inconsistent (manual review).
 */
export type CleanupUnknownRecoveryDecision =
  | { readonly decision: 'committed_deleted' }
  | { readonly decision: 'committed_quarantined' }
  | { readonly decision: 'not_committed' }
  | { readonly decision: 'inconsistent'; readonly reason: string };

export function resolveCleanupCommitUnknown(input: {
  readonly attemptedClaim: ClaimFenceFacts;
  readonly reRead:
    | { outcome: 'found'; row: CleanupRowFenceFacts & { readonly generationState: GenerationState } }
    | { outcome: 'not_found' };
}): CleanupUnknownRecoveryDecision {
  const { attemptedClaim, reRead } = input;
  if (reRead.outcome === 'not_found') {
    return { decision: 'inconsistent', reason: 'generation_row_missing_after_commit_unknown' };
  }
  const { generationState, ...rowFence } = reRead.row;
  if (generationState === 'deleted') return { decision: 'committed_deleted' };
  if (generationState === 'quarantined') return { decision: 'committed_quarantined' };
  if (generationState === 'deletion_pending') {
    if (claimFactsMatch(attemptedClaim, rowFence)) return { decision: 'not_committed' };
    return { decision: 'not_committed' };
  }
  return { decision: 'inconsistent', reason: `unexpected_state_${generationState}` };
}


// ---------------------------------------------------------------------------
// Cleanup keyset pagination
// ---------------------------------------------------------------------------

/**
 * Keyset cursor over the bounded cleanup candidate order
 * `(created_at, generation_id)`. `createdAtIso` is DB-sourced (never a JS
 * wall clock); ISO-8601 UTC strings with fixed millisecond format compare
 * lexicographically, mirroring the SQL row comparison.
 */
export interface CleanupKeysetCursor {
  readonly createdAtIso: string;
  readonly generationId: string;
}

/** The next page starts strictly after the last claimed row of this page. */
export function nextCleanupKeysetCursor(last: {
  readonly createdAt: Date | string;
  readonly generationId: string;
}): CleanupKeysetCursor {
  const createdAtIso = typeof last.createdAt === 'string' ? last.createdAt : last.createdAt.toISOString();
  return { createdAtIso, generationId: last.generationId };
}

export function compareCleanupKeys(left: CleanupKeysetCursor, right: CleanupKeysetCursor): number {
  const timeOrder = left.createdAtIso.localeCompare(right.createdAtIso);
  if (timeOrder !== 0) return timeOrder;
  return left.generationId.localeCompare(right.generationId);
}

export function cleanupCursorIsStrictlyAfter(cursor: CleanupKeysetCursor, last: CleanupKeysetCursor): boolean {
  return compareCleanupKeys(cursor, last) > 0;
}

// ---------------------------------------------------------------------------
// Provider metadata: fixed columns/allowlist, never a raw JSON response
// ---------------------------------------------------------------------------

/**
 * The only observed provider-metadata keys that may be bound into the ledger.
 * Canonicalized keys are lowercased with any `x-amz-meta-` prefix stripped
 * (matching the I06 blob-store canonicalization). Extending this allowlist is
 * a schema change and must ship with a migration.
 */
export const ALLOWED_OBSERVED_METADATA_KEYS: readonly string[] = Object.freeze(['probe', 'nonce']);

export function canonicalizeObservedMetadata(metadata: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    let normalized = key.trim().toLowerCase();
    if (normalized.startsWith('x-amz-meta-')) normalized = normalized.slice('x-amz-meta-'.length);
    if (normalized) out[normalized] = value;
  }
  return Object.freeze(out);
}

/** Fast-fail validation; the database CHECK is the durable backstop. */
export function assertObservedMetadataAllowlist(metadata: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(metadata)) {
    if (!ALLOWED_OBSERVED_METADATA_KEYS.includes(key)) {
      throw new Error(`metadata_key_not_allowed:${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic test seam for two-connection race coverage
// ---------------------------------------------------------------------------

export interface PhaseBarrier {
  arriveAndWait(name: string): Promise<void>;
}

export const NOOP_BARRIER: PhaseBarrier = { arriveAndWait: async () => {} };
