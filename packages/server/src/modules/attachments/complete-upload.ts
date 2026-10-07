/**
 * P4A-I09 internal application use case: authenticated explicit complete
 * coordinator (`phase4a: attest and verify uploaded generations`).
 *
 * The opaque request binding is `{ intentId, generationId, blobId }` plus
 * declared `{ size, sha256, mediaType, etag }`. The physical key is NEVER an
 * authoritative input: it is resolved from the committed ledger before the
 * provider HEAD attestation, which happens OUTSIDE any transaction. Then a
 * single transaction re-reads the intent/generation under row locks, verifies
 * the authenticated principal, the DB-clock expiry, and the declared-vs-
 * committed facts, CASes `issued -> uploaded` with the exact observed
 * ETag/size/metadata, and enqueues the verification Outbox job in the SAME
 * commit (the injected `enqueueVerification` dep).
 *
 * Duplicate/concurrent complete converges idempotently (one outbox row).
 * Unknown outcomes (before-commit failure, commit-response-lost) surface as
 * errors and are recovered by a safe EXTERNAL retry: a re-run re-reads the
 * database and converges (`idempotent` / `already_verified`) without a second
 * outbox row. Late/expired/replaced/deleted generations follow the frozen
 * late-upload policy.
 *
 * Logging records only fixed result classes — never the URL, key,
 * fingerprint, credential, or digest.
 */
import {
  ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES,
  type AttachmentsFeatureConfig,
} from './attachments-config.js';
import {
  assertObservedMetadataAllowlist,
  type PhaseBarrier,
} from './attachments-ledger-contract.js';
import type {
  GenerationObjectIdentity,
  GenerationObjectStorePort,
} from './attachments-object-store-port.js';
import type {
  AttachmentsLedgerPort,
  LateCompleteReason,
} from './attachments-repository-port.js';
import type { ActorPrincipal } from '../access-policy/index.js';
import type { IntentUnitOfWork, UploadIntentReceipt } from './issue-upload-intent.js';

export interface VerificationOutboxPayload {
  readonly blobId: string;
  readonly generationId: string;
  readonly intentId: string;
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface CompleteUploadInput {
  /** Trusted actor; the complete is authenticated against the intent principal. */
  readonly actor: ActorPrincipal;
  /** Opaque intent/generation/blob binding (the key is NOT an input). */
  readonly binding: { intentId: string; generationId: string; blobId: string };
  /** Untrusted client declarations; all are re-verified against the ledger + provider. */
  readonly declared: {
    readonly size: number;
    readonly sha256: string;
    readonly mediaType: string;
    readonly etag: string;
  };
}

export type CompleteUploadResult =
  | { outcome: 'completed'; receipt: UploadIntentReceipt; enqueuedVerification: true }
  | { outcome: 'idempotent'; receipt: UploadIntentReceipt; enqueuedVerification: false }
  | { outcome: 'already_verified'; receipt: UploadIntentReceipt; enqueuedVerification: false }
  | { outcome: 'missing' }
  | { outcome: 'etag_mismatch' }
  | { outcome: 'size_mismatch' }
  | { outcome: 'metadata_not_allowed' }
  | { outcome: 'declared_facts_mismatch'; code: 'size' | 'digest' | 'media' }
  | { outcome: 'late_rejected'; reason: LateCompleteReason }
  | { outcome: 'identity_mismatch' }
  | { outcome: 'principal_mismatch' }
  | { outcome: 'not_found' };

// ---------------------------------------------------------------------------
// Use case deps
// ---------------------------------------------------------------------------

export interface CompleteUploadDeps<Transaction> {
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** Narrow structural subset of the I06 `BlobStorePort` (headExact). */
  readonly blobStore: GenerationObjectStorePort;
  /** Matches the production `UnitOfWork` (`{ transaction }` context). */
  readonly uow: { execute<Result>(callback: (context: { transaction: Transaction }) => Promise<Result>): Promise<Result> };
  /** Verification Outbox append executed INSIDE the complete transaction. */
  readonly enqueueVerification: (transaction: Transaction, payload: VerificationOutboxPayload) => Promise<void>;
  readonly config: AttachmentsFeatureConfig;
  /** Deterministic test seam for two-connection complete races. */
  readonly barrier?: PhaseBarrier;
  readonly log?: CompleteLogger;
}

// ---------------------------------------------------------------------------
// Errors (stable codes; never provider/SDK text)
// ---------------------------------------------------------------------------

export type CompleteUploadInputErrorCode =
  | 'intent_id_required'
  | 'generation_id_required'
  | 'blob_id_required'
  | 'identifier_too_long'
  | 'size_required'
  | 'size_out_of_range'
  | 'digest_invalid'
  | 'media_not_allowed'
  | 'etag_required'
  | 'etag_too_long';

export class CompleteUploadInputError extends Error {
  readonly code: CompleteUploadInputErrorCode;
  constructor(code: CompleteUploadInputErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CompleteUploadInputError';
    this.code = code;
  }
}

/** Provider-side non-deterministic outcome (denied/retryable/unknown). */
export class CompleteUploadProviderError extends Error {
  readonly providerClass: 'denied' | 'retryable' | 'unknown';
  constructor(providerClass: 'denied' | 'retryable' | 'unknown', message?: string) {
    super(message ?? `complete_provider_${providerClass}`);
    this.name = 'CompleteUploadProviderError';
    this.providerClass = providerClass;
  }
}

// ---------------------------------------------------------------------------
// Fixed log classes (never URLs/keys/credentials/digests)
// ---------------------------------------------------------------------------

export type CompleteLogClass =
  | 'complete_target_resolved'
  | 'complete_attested'
  | 'complete_uploaded'
  | 'complete_idempotent'
  | 'complete_already_verified'
  | 'complete_late_rejected'
  | 'complete_missing'
  | 'complete_etag_mismatch'
  | 'complete_size_mismatch'
  | 'complete_metadata_not_allowed'
  | 'complete_facts_mismatch'
  | 'complete_principal_mismatch'
  | 'complete_identity_mismatch'
  | 'complete_not_found'
  // P4A-P07: the replacement generation's CAS activation (fixed classes only).
  | 'complete_replacement_activated'
  | 'complete_replacement_cas_lost';

export interface CompleteLogEntry {
  readonly class: CompleteLogClass;
  readonly intentId?: string;
  readonly generationId?: string;
  readonly reason?: string;
}

export type CompleteLogger = (entry: CompleteLogEntry) => void;

// ---------------------------------------------------------------------------
// Validation (pure, synchronous, fast-fail before any provider call)
// ---------------------------------------------------------------------------

const MAX_IDENTIFIER_LENGTH = 512;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface ValidatedCompleteUploadInput {
  readonly actor: ActorPrincipal;
  readonly binding: { intentId: string; generationId: string; blobId: string };
  readonly declared: { size: number; sha256: string; mediaType: string; etag: string };
}

export function validateCompleteUploadInput(
  input: CompleteUploadInput,
  config: AttachmentsFeatureConfig,
): ValidatedCompleteUploadInput {
  const intentId = input.binding.intentId.trim();
  const generationId = input.binding.generationId.trim();
  const blobId = input.binding.blobId.trim();
  if (intentId.length === 0) throw new CompleteUploadInputError('intent_id_required');
  if (generationId.length === 0) throw new CompleteUploadInputError('generation_id_required');
  if (blobId.length === 0) throw new CompleteUploadInputError('blob_id_required');
  if ([intentId, generationId, blobId].some((value) => value.length > MAX_IDENTIFIER_LENGTH)) {
    throw new CompleteUploadInputError('identifier_too_long');
  }

  if (!Number.isSafeInteger(input.declared.size) || input.declared.size < 0) {
    throw new CompleteUploadInputError('size_required', 'declared size must be a non-negative safe integer');
  }
  if (input.declared.size > config.singlePutMaxBytes) {
    throw new CompleteUploadInputError('size_out_of_range', `declared size must be <= singlePutMaxBytes (${config.singlePutMaxBytes})`);
  }
  if (input.declared.size > ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES) {
    throw new CompleteUploadInputError('size_out_of_range', `declared size must be <= the compile ceiling (${ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES})`);
  }

  const sha256 = input.declared.sha256.trim().toLowerCase();
  if (!DIGEST_PATTERN.test(sha256)) throw new CompleteUploadInputError('digest_invalid');

  const mediaType = input.declared.mediaType.trim().toLowerCase();
  if (!config.allowedMedia.includes(mediaType)) throw new CompleteUploadInputError('media_not_allowed');

  const etag = input.declared.etag.trim();
  if (etag.length === 0) throw new CompleteUploadInputError('etag_required');
  if (etag.length > 512) throw new CompleteUploadInputError('etag_too_long');

  return {
    actor: input.actor,
    binding: { intentId, generationId, blobId },
    declared: { size: input.declared.size, sha256, mediaType, etag },
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Completes an uploaded generation. Provider HEAD attestation happens OUTSIDE
 * the transaction; the CAS + verification Outbox enqueue commit together.
 * Unknown transaction outcomes propagate and are recovered by a safe external
 * retry (idempotent convergence, never a duplicate outbox row).
 */
export async function completeUpload<Transaction>(
  deps: CompleteUploadDeps<Transaction>,
  input: CompleteUploadInput,
): Promise<CompleteUploadResult> {
  const validated = validateCompleteUploadInput(input, deps.config);

  // Step 1 (OUTSIDE the tx): resolve the committed generation — the physical
  // key is a ledger fact, never a client input.
  const target = await deps.uow.execute(({ transaction: tx }) =>
    deps.ledger.findCompleteTarget(tx, {
      intentId: validated.binding.intentId,
      generationId: validated.binding.generationId,
      blobId: validated.binding.blobId,
    }, { barrier: deps.barrier }));
  if (target.outcome === 'not_found') {
    deps.log?.({ class: 'complete_not_found', intentId: validated.binding.intentId });
    return { outcome: 'not_found' };
  }
  const facts = target.facts;

  // Step 2 (OUTSIDE the tx): exact-key HEAD attestation bounded by the
  // declared ETag. Only an `ok` head may proceed; the observed size/metadata
  // come from the provider, never from the client.
  const head = await deps.blobStore.headExact(
    { generationId: validated.binding.generationId, key: facts.key },
    { expectedEtag: validated.declared.etag },
  );
  if (head.class === 'not_found') {
    deps.log?.({ class: 'complete_missing', intentId: validated.binding.intentId });
    return { outcome: 'missing' };
  }
  if (head.class === 'etag_mismatch') {
    deps.log?.({ class: 'complete_etag_mismatch', intentId: validated.binding.intentId });
    return { outcome: 'etag_mismatch' };
  }
  if (head.class !== 'ok') {
    throw new CompleteUploadProviderError(head.class);
  }
  const identity: GenerationObjectIdentity = head.identity;
  if (identity.size !== validated.declared.size) {
    deps.log?.({ class: 'complete_size_mismatch', intentId: validated.binding.intentId });
    return { outcome: 'size_mismatch' };
  }
  try {
    assertObservedMetadataAllowlist(identity.metadata);
  } catch {
    deps.log?.({ class: 'complete_metadata_not_allowed', intentId: validated.binding.intentId });
    return { outcome: 'metadata_not_allowed' };
  }
  deps.log?.({ class: 'complete_attested', intentId: validated.binding.intentId, generationId: validated.binding.generationId });

  // Step 3 (IN one tx): re-read intent/generation under locks, CAS
  // `issued -> uploaded` with the observed facts, and enqueue verification.
  return completeInTransaction(deps, validated, identity);
}

async function completeInTransaction<Transaction>(
  deps: CompleteUploadDeps<Transaction>,
  validated: ValidatedCompleteUploadInput,
  identity: GenerationObjectIdentity,
): Promise<CompleteUploadResult> {
  const receipt: UploadIntentReceipt = {
    intentId: validated.binding.intentId,
    generationId: validated.binding.generationId,
  };
  const result = await deps.uow.execute(async ({ transaction: tx }) => {
    const cas = await deps.ledger.completeUploadCas(tx, {
      intentId: validated.binding.intentId,
      generationId: validated.binding.generationId,
      blobId: validated.binding.blobId,
      actorPrincipalId: validated.actor.principalId,
      declaredSize: validated.declared.size,
      declaredSha256: validated.declared.sha256,
      declaredMediaType: validated.declared.mediaType,
      observedEtag: identity.etag,
      observedSize: identity.size,
      observedContentType: identity.contentType ?? null,
      observedMetadata: identity.metadata,
    }, { barrier: deps.barrier });
    if (cas.outcome === 'uploaded') {
      // P4A-P07 replacement activation in the SAME canonical transaction: a
      // completed generation whose blob already carried a DIFFERENT current
      // generation is a replacement candidate (`observed`; the complete CAS
      // bound the exact attested etag/size). Only then does the CAS switch
      // the current pointer (old generation -> retired) — the frozen
      // `activateReplacement` gate (`new_not_verified` unless `observed`)
      // guarantees the pointer never moves before the complete attestation.
      // The old generation only enters `retired`; its external deletion
      // converges asynchronously through the cleanup coordinator. The blob
      // is demoted back to `uploaded` with cleared verified facts so the
      // verification worker re-verifies the NEW current generation's digest
      // before any status read or finalize can consume it.
      const blobFacts = await deps.ledger.findBlobForStatus(tx, { blobId: validated.binding.blobId });
      if (blobFacts.outcome === 'found'
        && blobFacts.facts.currentGenerationId !== null
        && blobFacts.facts.currentGenerationId !== validated.binding.generationId
        && blobFacts.facts.logicalState !== 'attached_private') {
        const activation = await deps.ledger.activateReplacement(tx, {
          blobId: validated.binding.blobId,
          expectedActiveGenerationId: blobFacts.facts.currentGenerationId,
          newGenerationId: validated.binding.generationId,
        });
        if (activation.outcome === 'activated' || activation.outcome === 'idempotent') {
          deps.log?.({ class: 'complete_replacement_activated', intentId: validated.binding.intentId, generationId: validated.binding.generationId });
        } else {
          // stale_cas / attached_not_replaced / new_not_verified / …: the
          // upload itself committed (the generation is observed); the CAS
          // race is resolved by the ledger's atomic active/retired fence and
          // a retry of the identical complete converges idempotently.
          deps.log?.({ class: 'complete_replacement_cas_lost', intentId: validated.binding.intentId, generationId: validated.binding.generationId, reason: activation.outcome });
        }
      }
      await deps.enqueueVerification(tx, {
        blobId: validated.binding.blobId,
        generationId: validated.binding.generationId,
        intentId: validated.binding.intentId,
      });
    }
    return cas;
  });

  switch (result.outcome) {
    case 'uploaded':
      deps.log?.({ class: 'complete_uploaded', intentId: validated.binding.intentId, generationId: validated.binding.generationId });
      return { outcome: 'completed', receipt, enqueuedVerification: true };
    case 'idempotent':
      deps.log?.({ class: 'complete_idempotent', intentId: validated.binding.intentId });
      return { outcome: 'idempotent', receipt, enqueuedVerification: false };
    case 'already_verified':
      deps.log?.({ class: 'complete_already_verified', intentId: validated.binding.intentId });
      return { outcome: 'already_verified', receipt, enqueuedVerification: false };
    case 'late_rejected':
      deps.log?.({ class: 'complete_late_rejected', intentId: validated.binding.intentId, reason: result.reason });
      return { outcome: 'late_rejected', reason: result.reason };
    case 'declared_facts_mismatch':
      deps.log?.({ class: 'complete_facts_mismatch', intentId: validated.binding.intentId });
      return { outcome: 'declared_facts_mismatch', code: result.code };
    case 'identity_mismatch':
      deps.log?.({ class: 'complete_identity_mismatch', intentId: validated.binding.intentId });
      return { outcome: 'identity_mismatch' };
    case 'principal_mismatch':
      deps.log?.({ class: 'complete_principal_mismatch', intentId: validated.binding.intentId });
      return { outcome: 'principal_mismatch' };
    case 'not_found':
      deps.log?.({ class: 'complete_not_found', intentId: validated.binding.intentId });
      return { outcome: 'not_found' };
    default:
      // Exhaustive; all CAS outcomes are mapped above.
      return { outcome: 'not_found' };
  }
}

