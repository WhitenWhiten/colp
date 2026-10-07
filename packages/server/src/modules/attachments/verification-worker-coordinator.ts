import { createAttachmentProviderScope, type AttachmentProviderScope } from './provider-operation.js';
/**
 * P4A-I09 verification worker coordinator (`phase4a: attest and verify
 * uploaded generations`).
 *
 * Drives one verification Outbox delivery:
 *
 *   1. CLAIM (transaction): CAS `uploaded -> verifying` on the blob record and
 *      take the verification lease (owner = outbox row, lease token = the
 *      outbox `lease_generation`, expiry = DB clock + lease TTL). The outbox
 *      row must still be leased by this attempt; a lost lease aborts
 *      immediately. `verifying` rows with an EXPIRED lease are takeoverable by
 *      a new worker.
 *   2. HEAD attestation OUTSIDE the transaction (exact key, bound ETag).
 *   3. Conditional streamed GET OUTSIDE the transaction (I06 readBounded) with
 *      the AbortSignal + byte ceiling.
 *   4. `verifyGenerationStream` (pure; NO database writes).
 *   5. CAS (transaction): `verifying -> stored_private` with the lease token
 *      (old-lease late results CAS-fail -> `lease_lost`), or corruption ->
 *      generation `contract_corrupt -> quarantined` + blob `expired` with the
 *      lease token. Retryable provider/read outcomes leave the blob in
 *      `verifying` for a later worker.
 *
 * `stored_private` NEVER contains a scanner verdict or a `safe` boolean; the
 * stored media type degrades unknown/suspicious content to generic
 * octet-stream. Deterministic crash hooks (throwing `VerificationFatalError`)
 * cover the claim-after / HEAD-after / first-byte-before / partial-stream /
 * digest-after / CAS-before restart matrix.
 */
import {
  ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES,
  VerificationFatalError,
  storedMediaTypeForEvidence,
  verifyGenerationStream,
  type VerificationEvidence,
} from './verify-generation.js';
import type { AttachmentsFeatureConfig } from './attachments-config.js';
import type {
  GenerationObjectStorePort,
} from './attachments-object-store-port.js';
import type {
  AttachmentsLedgerPort,
  VerificationAttemptFence,
} from './attachments-repository-port.js';
import type { IntentUnitOfWork } from './issue-upload-intent.js';
import type { VerificationOutboxPayload } from './complete-upload.js';

export type { VerificationAttemptFence };

// ---------------------------------------------------------------------------
// Deterministic crash hooks (plan §6 I09 crash matrix)
// ---------------------------------------------------------------------------

export interface VerificationFaultInjector {
  /** After the claim transaction committed (blob is `verifying`). */
  afterClaim?(): void | Promise<void>;
  /** After the exact-key HEAD attestation. */
  afterHead?(): void | Promise<void>;
  /** Before the first body byte is consumed. */
  beforeFirstByte?(): void | Promise<void>;
  /** After a partial chunk was consumed (mid-stream). */
  afterPartial?(): void | Promise<void>;
  /** After the verification pipeline returned (digest computed). */
  afterDigest?(): void | Promise<void>;
  /** Immediately before the `verifying -> stored_private` CAS. */
  beforeStoredCas?(): void | Promise<void>;
  /** Immediately before the corruption quarantine CAS. */
  beforeQuarantine?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Outcome union
// ---------------------------------------------------------------------------

export type VerificationWorkerOutcome =
  | {
      outcome: 'stored_private';
      blobId: string;
      generationId: string;
      verifiedSize: number;
      verifiedSha256: string;
      mediaType: string;
    }
  | { outcome: 'already_stored'; blobId: string; generationId: string }
  | { outcome: 'quarantined'; blobId: string; generationId: string; reason: string }
  | { outcome: 'already_expired'; blobId: string; generationId: string }
  /** FIX-L-045: the event's generation is authoritatively replaced/retired
   * (or deleted) — terminal; the outbox row completes, the new generation is
   * never touched. */
  | { outcome: 'already_replaced'; blobId: string; generationId: string }
  | { outcome: 'retryable'; blobId: string; generationId: string; reason: string }
  | { outcome: 'lease_lost'; blobId: string; generationId: string }
  | { outcome: 'not_found'; blobId: string; generationId: string };

// ---------------------------------------------------------------------------
// Deps and logging
// ---------------------------------------------------------------------------

export interface VerificationWorkerDeps<Transaction> {
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** Narrow structural subset of the I06 `BlobStorePort`. */
  readonly blobStore: GenerationObjectStorePort;
  readonly uow: IntentUnitOfWork<Transaction>;
  readonly config: AttachmentsFeatureConfig;
  readonly faultInjector?: VerificationFaultInjector;
  readonly log?: VerificationLogger;
}

export type VerificationLogClass =
  | 'verification_claimed'
  | 'verification_attested'
  | 'verification_stored_private'
  | 'verification_quarantined'
  | 'verification_already_stored'
  | 'verification_already_expired'
  | 'verification_already_replaced'
  | 'verification_retryable'
  | 'verification_lease_lost'
  | 'verification_not_found';

export interface VerificationLogEntry {
  readonly class: VerificationLogClass;
  readonly blobId?: string;
  readonly generationId?: string;
  readonly reason?: string;
}

export type VerificationLogger = (entry: VerificationLogEntry) => void;

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export async function verifyUploadedGeneration<Transaction>(
  deps: VerificationWorkerDeps<Transaction>,
  payload: VerificationOutboxPayload,
  attempt: VerificationAttemptFence,
  signal: AbortSignal,
): Promise<VerificationWorkerOutcome> {
  const scope = createAttachmentProviderScope(signal, deps.config.verification.timeoutMs);
  try { return await verifyInScope(deps, payload, attempt, scope); }
  catch (error) {
    if (scope.signal.aborted) return retryable(deps, payload, 'provider_cancelled');
    throw error;
  } finally { scope.close(); }
}

async function verifyInScope<Transaction>(
  deps: VerificationWorkerDeps<Transaction>, payload: VerificationOutboxPayload,
  attempt: VerificationAttemptFence, scope: AttachmentProviderScope,
): Promise<VerificationWorkerOutcome> {
  const signal = scope.signal;
  signal.throwIfAborted();
  const { blobId, generationId } = payload;
  const leaseTtlSeconds = Math.max(1, Math.ceil(deps.config.verification.leaseMs / 1000));

  // 1. Claim the verification lease (transaction; outbox-fenced).
  const claim = await deps.uow.execute(({ transaction: tx }) =>
    deps.ledger.claimVerification(tx, { blobId, generationId, attempt, leaseTtlSeconds }));
  if (claim.outcome === 'already_stored') {
    deps.log?.({ class: 'verification_already_stored', blobId, generationId });
    return { outcome: 'already_stored', blobId, generationId };
  }
  if (claim.outcome === 'already_expired') {
    deps.log?.({ class: 'verification_already_expired', blobId, generationId });
    return { outcome: 'already_expired', blobId, generationId };
  }
  if (claim.outcome === 'already_replaced') {
    deps.log?.({ class: 'verification_already_replaced', blobId, generationId });
    return { outcome: 'already_replaced', blobId, generationId };
  }
  if (claim.outcome === 'lease_lost') {
    deps.log?.({ class: 'verification_lease_lost', blobId, generationId });
    return { outcome: 'lease_lost', blobId, generationId };
  }
  if (claim.outcome === 'not_found') {
    deps.log?.({ class: 'verification_not_found', blobId, generationId });
    return { outcome: 'not_found', blobId, generationId };
  }
  const facts = claim.facts;
  deps.log?.({ class: 'verification_claimed', blobId, generationId });
  await deps.faultInjector?.afterClaim?.();

  // 2. Exact-key HEAD attestation OUTSIDE the transaction.
  const head = await scope.run(() => deps.blobStore.headExact(
    { generationId, key: facts.key },
    { expectedEtag: facts.observedEtag ?? undefined, signal },
  ));
  await deps.faultInjector?.afterHead?.();
  signal.throwIfAborted();
  if (head.class === 'etag_mismatch' || head.class === 'not_found') {
    const reason = head.class === 'not_found'
      ? 'object_missing_after_attestation'
      : 'etag_mismatch_after_attestation';
    return quarantineCorruption(deps, payload, attempt, reason);
  }
  if (head.class !== 'ok') {
    return retryable(deps, payload, `head_${head.class}`);
  }
  const observedEtag = head.identity.etag;
  deps.log?.({ class: 'verification_attested', blobId, generationId });

  // 3. Conditional streamed read OUTSIDE the transaction, bounded by the
  //    outbox AbortSignal and a hard read timeout.

  let read;
  try {
    read = await scope.run(() => deps.blobStore.readBounded(
      { generationId, key: facts.key },
      {
        expectedEtag: observedEtag,
        byteCeiling: deps.config.singlePutMaxBytes,
        signal,
      },
    ));
  } catch {
    return retryable(deps, payload, 'read_unknown');
  }
  signal.throwIfAborted();
  if (read.class === 'overflow') {
    return quarantineCorruption(deps, payload, attempt, 'oversize');
  }
  if (read.class === 'etag_mismatch' || read.class === 'not_found') {
    const reason = read.class === 'not_found'
      ? 'object_missing_after_attestation'
      : 'etag_mismatch_after_attestation';
    return quarantineCorruption(deps, payload, attempt, reason);
  }
  if (read.class !== 'ok') {
    return retryable(deps, payload, `read_${read.class}`);
  }

  // 4. Pure streamed verification (no database writes; crash hooks inside).
  const evidence: VerificationEvidence = await scope.run(() => verifyGenerationStream(
    { stream: withStreamHooks(read.stream, deps.faultInjector), signal },
    { size: read.identity.size, sha256: facts.expectedSha256, mediaType: facts.mediaHint },
    { hardByteCeiling: deps.config.singlePutMaxBytes,
      mimeSniffPrefixBytes: ATTACHMENTS_VERIFICATION_MIME_SNIFF_PREFIX_BYTES },
  ));
  await deps.faultInjector?.afterDigest?.();
  signal.throwIfAborted();

  switch (evidence.verdict) {
    case 'verified':
      return storeVerified(deps, payload, attempt, evidence);
    case 'over_hard_limit':
    case 'truncated':
    case 'extra_trailing_bytes':
    case 'size_mismatch':
    case 'digest_mismatch':
    case 'media_mismatch':
    case 'etag_mismatch':
      return quarantineCorruption(deps, payload, attempt, evidence.verdict);
    case 'read_timeout':
    case 'aborted':
    case 'unknown':
    case 'not_found':
    case 'denied':
    case 'retryable':
      return retryable(deps, payload, evidence.verdict);
    default:
      return retryable(deps, payload, 'unknown');
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function retryable<Transaction>(
  deps: VerificationWorkerDeps<Transaction>,
  payload: VerificationOutboxPayload,
  reason: string,
): VerificationWorkerOutcome {
  deps.log?.({ class: 'verification_retryable', blobId: payload.blobId, generationId: payload.generationId, reason });
  return { outcome: 'retryable', blobId: payload.blobId, generationId: payload.generationId, reason };
}

async function storeVerified<Transaction>(
  deps: VerificationWorkerDeps<Transaction>,
  payload: VerificationOutboxPayload,
  attempt: VerificationAttemptFence,
  evidence: VerificationEvidence,
): Promise<VerificationWorkerOutcome> {
  const { blobId, generationId } = payload;
  const mediaType = storedMediaTypeForEvidence(evidence);
  await deps.faultInjector?.beforeStoredCas?.();
  const completed = await deps.uow.execute(({ transaction: tx }) =>
    deps.ledger.completeVerification(tx, {
      blobId,
      generationId,
      attempt,
      verifiedSize: evidence.byteCount,
      verifiedSha256: evidence.sha256,
      mediaType,
      policyVersion: evidence.policyVersion,
    }));
  if (completed.outcome === 'stored_private') {
    deps.log?.({ class: 'verification_stored_private', blobId, generationId });
    return {
      outcome: 'stored_private',
      blobId,
      generationId,
      verifiedSize: evidence.byteCount,
      verifiedSha256: evidence.sha256,
      mediaType,
    };
  }
  if (completed.outcome === 'not_found') {
    return { outcome: 'not_found', blobId, generationId };
  }
  // The lease was lost (or the blob already stored by a newer owner): the late
  // CAS failed and the outbox row will retry to an idempotent convergence.
  deps.log?.({ class: 'verification_lease_lost', blobId, generationId });
  return { outcome: 'lease_lost', blobId, generationId };
}

async function quarantineCorruption<Transaction>(
  deps: VerificationWorkerDeps<Transaction>,
  payload: VerificationOutboxPayload,
  attempt: VerificationAttemptFence,
  reason: string,
): Promise<VerificationWorkerOutcome> {
  const { blobId, generationId } = payload;
  await deps.faultInjector?.beforeQuarantine?.();
  const result = await deps.uow.execute(({ transaction: tx }) =>
    deps.ledger.quarantineVerification(tx, { blobId, generationId, attempt, reason }));
  if (result.outcome === 'quarantined') {
    deps.log?.({ class: 'verification_quarantined', blobId, generationId, reason });
    return { outcome: 'quarantined', blobId, generationId, reason };
  }
  if (result.outcome === 'not_found') return { outcome: 'not_found', blobId, generationId };
  deps.log?.({ class: 'verification_lease_lost', blobId, generationId });
  return { outcome: 'lease_lost', blobId, generationId };
}

/**
 * Wraps the provider stream so deterministic crash hooks fire at the
 * first-byte-before and partial-stream points. Hooks that throw
 * `VerificationFatalError` abort the worker exactly like a process death.
 */
async function* withStreamHooks(
  stream: AsyncIterable<Uint8Array>,
  injector: VerificationFaultInjector | undefined,
): AsyncGenerator<Uint8Array> {
  let first = true;
  for await (const chunk of stream) {
    if (first) {
      first = false;
      await injector?.beforeFirstByte?.();
    }
    yield chunk;
    await injector?.afterPartial?.();
  }
}

// Re-export the fatal fault marker for crash-hook tests.
export { VerificationFatalError };
