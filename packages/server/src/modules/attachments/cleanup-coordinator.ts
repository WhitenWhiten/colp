import { createAttachmentProviderScope, type AttachmentProviderScope } from './provider-operation.js';
/**
 * P4A-I14 bounded cleanup coordinator (`phase4a: clean retired and orphaned
 * generations`).
 *
 * Drives one bounded batch of retired/orphaned generation cleanup:
 *
 *   1. CLAIM (transaction): keyset-claim a bounded batch (config batch size,
 *      1..1000) over retention-expired retired/orphan generations, using the
 *      DATABASE clock for both the retention deadline
 *      (`coalesce(retired_at, orphaned_at) <= now() - retiredRetentionDays`,
 *      boundary inclusive) and the claim lease. `allocated` generations whose
 *      intent already expired are reconciled to `orphaned` (DB-clock
 *      orphaned_at) in the same claim transaction. The claim snapshots the
 *      exact candidate (generation id, exact key, observed etag/size, attempt
 *      token, lease fence).
 *   2. Conditional HEAD OUTSIDE any transaction on the exact claimed key
 *      (etag/size identity check). A mismatch quarantines with NO delete; a
 *      not-found confirms absence with NO delete.
 *   3. Exact-key DELETE OUTSIDE the transaction, then a repeated exact-key
 *      HEAD confirms absence — a DELETE 2xx alone is never completion.
 *   4. CAS commit of the deletion evidence under the exact claim fence
 *      (`completeCleanup`), retaining the permanent tombstone row.
 *
 * Safety invariants (plan §6 I14 / ADR-0020):
 *  - candidates come ONLY from claimed generation rows; the coordinator NEVER
 *    lists the bucket or derives a key from the blob current pointer;
 *  - a candidate mismatch (same key, different etag/size) sends NO DELETE and
 *    quarantines the generation;
 *  - timeout/5xx/unknown outcomes are bounded-retried in-process and then
 *    recorded as `unknown_retryable`, which releases the claim lease so a
 *    later worker (or a lease-expired takeover) converges;
 *  - a lost `completeCleanup` commit response re-reads the DATABASE and
 *    decides via `resolveCleanupCommitUnknown` — never from the exception;
 *  - the coordinator never deletes the generation/tombstone/audit row and
 *    never touches active/attached-private bodies (claim SQL fences
 *    `current_generation_id is distinct from generation_id`).
 */
import { randomUUID } from 'node:crypto';
import {
  ATTACHMENTS_CLEANUP_BATCH_MAX,
  type AttachmentsFeatureConfig,
} from './attachments-config.js';
import {
  classifyAttachmentsLedgerError,
  type DeleteOutcome,
  type HeadOutcome,
  nextCleanupKeysetCursor,
  resolveCleanupCommitUnknown,
  resolveCleanupVerdict,
  type CleanupKeysetCursor,
  type CleanupUnknownRecoveryDecision,
  type CleanupVerdict,
} from './attachments-ledger-contract.js';
import type {
  GenerationDeleteOutcome,
  GenerationHeadOutcome,
  GenerationObjectHandle,
  GenerationObjectStorePort,
} from './attachments-object-store-port.js';
import type {
  AttachmentsLedgerPort,
  CleanupClaim,
  CompleteCleanupResult,
  ReadCleanupStateResult,
} from './attachments-repository-port.js';
import type { IntentUnitOfWork } from './issue-upload-intent.js';

// ---------------------------------------------------------------------------
// Deterministic crash hooks (plan §6 I14 crash matrix)
// ---------------------------------------------------------------------------

export interface CleanupFaultInjector {
  /** After the claim transaction committed. */
  afterClaim?(): void | Promise<void>;
  /** Before the first conditional HEAD (identity check). */
  beforeHead?(): void | Promise<void>;
  /** After the conditional HEAD resolved. */
  afterHead?(): void | Promise<void>;
  /** Immediately before the exact-key DELETE. */
  beforeDelete?(): void | Promise<void>;
  /** Immediately after the exact-key DELETE. */
  afterDelete?(): void | Promise<void>;
  /** Before the repeat HEAD that confirms absence. */
  beforeConfirmHead?(): void | Promise<void>;
  /** After the confirm HEAD resolved. */
  afterConfirmHead?(): void | Promise<void>;
  /** Immediately before the `completeCleanup` CAS. */
  beforeCompleteCas?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Logging (fixed classes only; never keys/URLs/credentials)
// ---------------------------------------------------------------------------

export type CleanupLogClass =
  | 'cleanup_batch_claimed'
  | 'cleanup_no_candidates'
  | 'cleanup_deleted'
  | 'cleanup_confirmed_absent'
  | 'cleanup_quarantined'
  | 'cleanup_unknown_released'
  | 'cleanup_lease_lost'
  | 'cleanup_commit_unknown'
  | 'cleanup_inconsistent';

export interface CleanupLogEntry {
  readonly class: CleanupLogClass;
  readonly generationId?: string;
  readonly reason?: string;
  readonly attemptToken?: string;
}

export type CleanupLogger = (entry: CleanupLogEntry) => void;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type CleanupCandidateOutcome =
  | { readonly kind: 'deleted'; readonly generationId: string }
  | { readonly kind: 'confirmed_absent'; readonly generationId: string }
  | { readonly kind: 'quarantined'; readonly generationId: string; readonly reason: string }
  | { readonly kind: 'unknown_retryable'; readonly generationId: string; readonly reason: string }
  | { readonly kind: 'lease_lost'; readonly generationId: string }
  | { readonly kind: 'already_terminal'; readonly generationId: string; readonly state: 'deleted' | 'quarantined' }
  | { readonly kind: 'commit_unknown'; readonly generationId: string; readonly decision: CleanupUnknownRecoveryDecision['decision'] }
  | { readonly kind: 'inconsistent'; readonly generationId: string; readonly reason: string };

export interface CleanupBatchResult {
  readonly claimed: number;
  readonly outcomes: readonly CleanupCandidateOutcome[];
  /**
   * Keyset cursor for the next page; `null` when the claimed page was short
   * (the scan reached the end of the candidate window, so the next run should
   * restart from the beginning to pick up any rows that were skipped by other
   * workers' locks — bounded fairness, no starvation).
   */
  readonly nextCursor: CleanupKeysetCursor | null;
  /** Caller/attempt correlation token (never the per-claim CAS fence). */
  readonly attemptToken?: string;
}

// ---------------------------------------------------------------------------
// Deps and entry point
// ---------------------------------------------------------------------------

export interface RunCleanupBatchInput<Transaction> {
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  readonly objectStore: GenerationObjectStorePort;
  readonly config: AttachmentsFeatureConfig;
  readonly uow: IntentUnitOfWork<Transaction>;
  readonly leaseOwner: string;
  readonly signal?: AbortSignal;
  readonly providerTimeoutMs?: number;
  /**
   * Optional caller-supplied attempt correlation token. The per-claim CAS
   * fence token is always the DB-generated `claim.attemptToken`.
   */
  readonly attemptToken?: string;
  /** Keyset cursor; null starts at the beginning. */
  readonly cursor?: CleanupKeysetCursor | null;
  readonly faultInjector?: CleanupFaultInjector;
  readonly log?: CleanupLogger;
}

export async function runCleanupBatch<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
): Promise<CleanupBatchResult> {
  if (input.signal?.aborted) return { claimed: 0, outcomes: [], nextCursor: null };
  const attemptToken = input.attemptToken ?? randomUUID();
  const batchSize = Math.min(Math.max(1, Math.floor(input.config.cleanupBatchSize)), ATTACHMENTS_CLEANUP_BATCH_MAX);
  const leaseTtlSeconds = Math.max(1, Math.floor(input.config.cleanup.leaseMs / 1000));

  const claimResult = await input.uow.execute(({ transaction }) =>
    input.ledger.claimCleanup(transaction, {
      leaseOwner: input.leaseOwner,
      leaseTtlSeconds,
      limit: batchSize,
      cursor: input.cursor ?? null,
      retiredRetentionDays: input.config.retention.retiredRetentionDays,
    }));

  if (claimResult.outcome !== 'batch' || claimResult.claims.length === 0) {
    input.log?.({ class: 'cleanup_no_candidates', attemptToken });
    return { claimed: 0, outcomes: [], nextCursor: null, attemptToken };
  }

  const claims = claimResult.claims;
  await input.faultInjector?.afterClaim?.();

  const outcomes: CleanupCandidateOutcome[] = [];
  for (const claim of claims) {
    if (input.signal?.aborted) break;
    outcomes.push(await processClaim(input, claim));
  }

  const last = claims[claims.length - 1]!;
  const nextCursor = claims.length >= batchSize
    ? nextCleanupKeysetCursor({ createdAt: last.createdAt, generationId: last.generationId })
    : null;
  input.log?.({ class: 'cleanup_batch_claimed', attemptToken, reason: `claimed=${claims.length}` });
  return { claimed: claims.length, outcomes, nextCursor, attemptToken };
}

// ---------------------------------------------------------------------------
// Per-candidate provider flow (all provider calls OUTSIDE any transaction)
// ---------------------------------------------------------------------------

async function processClaim<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
  claim: CleanupClaim,
): Promise<CleanupCandidateOutcome> {
  const scope = createAttachmentProviderScope(input.signal,
    input.providerTimeoutMs ?? Math.min(30_000, input.config.cleanup.leaseMs));
  try { return await processClaimInScope(input, claim, scope); }
  catch (error) {
    if (scope.signal.aborted) return completeCandidate(input, claim, 'unknown_retryable');
    throw error;
  } finally { scope.close(); }
}

async function processClaimInScope<Transaction>(
  input: RunCleanupBatchInput<Transaction>, claim: CleanupClaim, scope: AttachmentProviderScope,
): Promise<CleanupCandidateOutcome> {
  const handle: GenerationObjectHandle = { generationId: claim.generationId, key: claim.key };

  await input.faultInjector?.beforeHead?.();
  const headBefore = toLedgerHeadOutcome(await headWithRetry(input, handle, scope));
  await input.faultInjector?.afterHead?.();
  scope.signal.throwIfAborted();

  let resolution = resolveCleanupVerdict({ claim, headBefore });
  if (resolution.verdict === 'candidate_mismatch') {
    // Same-key identity mismatch: quarantine, NO DELETE.
    return completeCandidate(input, claim, resolution.verdict, 'candidate_mismatch');
  }
  if (resolution.deleteAttempted) {
    await input.faultInjector?.beforeDelete?.();
    const deleteOutcome = toLedgerDeleteOutcome(await deleteWithRetry(input, handle, scope));
    await input.faultInjector?.afterDelete?.();
    await input.faultInjector?.beforeConfirmHead?.();
    const headAfter = toLedgerHeadOutcome(await headWithRetry(input, handle, scope));
    await input.faultInjector?.afterConfirmHead?.();
    resolution = resolveCleanupVerdict({ claim, headBefore, deleteOutcome, headAfter });
  }
  scope.signal.throwIfAborted();
  return completeCandidate(input, claim, resolution.verdict);
}

async function completeCandidate<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
  claim: CleanupClaim,
  verdict: CleanupVerdict,
  mismatchReason?: string,
): Promise<CleanupCandidateOutcome> {
  await input.faultInjector?.beforeCompleteCas?.();
  let complete: CompleteCleanupResult;
  try {
    complete = await input.uow.execute(({ transaction }) =>
      input.ledger.completeCleanup(transaction, { claim, verdict, mismatchReason }));
  } catch (error) {
    const classification = classifyAttachmentsLedgerError(error);
    if (classification.class === 'unknown_outcome') {
      // Lost commit response: re-read the DATABASE, never guess from the exception.
      const decision = await recoverCommitUnknown(input, claim);
      input.log?.({ class: 'cleanup_commit_unknown', generationId: claim.generationId, reason: decision.decision });
      return { kind: 'commit_unknown', generationId: claim.generationId, decision: decision.decision };
    }
    throw error;
  }
  return mapCompleteResult(input, claim, verdict, complete);
}

function mapCompleteResult<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
  claim: CleanupClaim,
  verdict: CleanupVerdict,
  result: CompleteCleanupResult,
): CleanupCandidateOutcome {
  switch (result.outcome) {
    case 'completed':
      if (verdict === 'confirmed_absent') {
        input.log?.({ class: 'cleanup_confirmed_absent', generationId: claim.generationId });
        return { kind: 'confirmed_absent', generationId: claim.generationId };
      }
      input.log?.({ class: 'cleanup_deleted', generationId: claim.generationId });
      return { kind: 'deleted', generationId: claim.generationId };
    case 'quarantined':
      input.log?.({ class: 'cleanup_quarantined', generationId: claim.generationId, reason: 'candidate_mismatch' });
      return { kind: 'quarantined', generationId: claim.generationId, reason: 'candidate_mismatch' };
    case 'released':
      input.log?.({ class: 'cleanup_unknown_released', generationId: claim.generationId, reason: 'unknown_retryable' });
      return { kind: 'unknown_retryable', generationId: claim.generationId, reason: 'unknown_retryable' };
    case 'lease_lost':
      input.log?.({ class: 'cleanup_lease_lost', generationId: claim.generationId });
      return { kind: 'lease_lost', generationId: claim.generationId };
    case 'already_deleted':
      return { kind: 'already_terminal', generationId: claim.generationId, state: 'deleted' };
    case 'already_quarantined':
      return { kind: 'already_terminal', generationId: claim.generationId, state: 'quarantined' };
    case 'not_claimable':
      input.log?.({ class: 'cleanup_inconsistent', generationId: claim.generationId, reason: 'row_missing_at_complete' });
      return { kind: 'inconsistent', generationId: claim.generationId, reason: 'row_missing_at_complete' };
    default: {
      const exhaustive: never = result;
      throw new Error(`cleanup_complete_unhandled_outcome:${String(exhaustive)}`);
    }
  }
}

async function recoverCommitUnknown<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
  claim: CleanupClaim,
): Promise<CleanupUnknownRecoveryDecision> {
  const reRead: ReadCleanupStateResult = await input.uow.execute(({ transaction }) =>
    input.ledger.readCleanupState(transaction, { generationId: claim.generationId }));
  return resolveCleanupCommitUnknown({
    attemptedClaim: {
      attemptToken: claim.attemptToken,
      leaseOwner: claim.leaseOwner,
      leaseGeneration: claim.leaseGeneration,
    },
    reRead,
  });
}

// ---------------------------------------------------------------------------
// Outcome conversion: the I09 module port surfaces are translated into the
// I07 ledger-contract verdict shapes (etag/size flattened out of the identity)
// so `resolveCleanupVerdict` remains the single pure verdict source.
// ---------------------------------------------------------------------------

function toLedgerHeadOutcome(outcome: GenerationHeadOutcome): HeadOutcome {
  if (outcome.class === 'ok') {
    return { class: 'ok', etag: outcome.identity.etag, size: outcome.identity.size };
  }
  if (outcome.class === 'etag_mismatch') return { class: 'unknown' };
  return outcome;
}

function toLedgerDeleteOutcome(outcome: GenerationDeleteOutcome): DeleteOutcome {
  return outcome;
}

// ---------------------------------------------------------------------------
// Bounded provider retry: timeout/5xx/unknown classes are retried at most
// `config.cleanup.retryCount` times in-process, then stay `unknown_retryable`
// (the claim is released and a later worker/takeover converges). Denied is
// never retried (persistent credential class).
// ---------------------------------------------------------------------------

function headIsRetryable(outcome: GenerationHeadOutcome): boolean {
  return outcome.class === 'retryable' || outcome.class === 'unknown';
}

function deleteIsRetryable(outcome: GenerationDeleteOutcome): boolean {
  return outcome.class === 'retryable' || outcome.class === 'unknown';
}

async function headWithRetry<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
  handle: GenerationObjectHandle, scope: AttachmentProviderScope,
): Promise<GenerationHeadOutcome> {
  let last: GenerationHeadOutcome = { class: 'unknown' };
  for (let attempt = 0; attempt <= input.config.cleanup.retryCount; attempt += 1) {
    last = await scope.run(signal => input.objectStore.headExact(handle, { signal }));
    if (!headIsRetryable(last)) return last;
  }
  return last;
}

async function deleteWithRetry<Transaction>(
  input: RunCleanupBatchInput<Transaction>,
  handle: GenerationObjectHandle, scope: AttachmentProviderScope,
): Promise<GenerationDeleteOutcome> {
  let last: GenerationDeleteOutcome = { class: 'unknown' };
  for (let attempt = 0; attempt <= input.config.cleanup.retryCount; attempt += 1) {
    last = await scope.run(signal => input.objectStore.deleteExact(handle, { signal }));
    if (!deleteIsRetryable(last)) return last;
  }
  return last;
}
