/**
 * P4A-I07 transaction-bound PostgreSQL attachments ledger ports.
 *
 * Every method REQUIRES the caller-provided transaction and never opens a new
 * connection. State transitions use expected state/generation/attempt-token
 * CAS and the DATABASE CLOCK is the state-time authority (intent expiry and
 * lease expiry are evaluated in SQL with `now()`, never with a JS wall clock).
 * Provider metadata is bound as fixed allowlist columns, never a raw JSON
 * response.
 *
 * The SQL shapes are the productionized evolution of the proven I04 spike
 * ports: ledger-before-grant ordering, first-complete activation, replacement
 * active/retired CAS, cleanup claim/complete fencing with lease takeover, and
 * the bounded cleanup-candidate index with keyset pagination.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from './unit-of-work.js';
import { findLatestAttachmentOperationByCommandId } from './operation-payload-lookups.js';
import { DatabaseOperationError, classifyDatabaseError } from './errors.js';
import {
  AttachmentsIdentityError,
  NOOP_BARRIER,
  assertObservedMetadataAllowlist,
  attachmentsIdentityCodeForConstraint,
  canonicalizeObservedMetadata,
  type ActivateReplacementInput,
  type ActivateReplacementResult,
  type FindIntentByBindingInput,
  type FindIntentByBindingResult,
  type AllocateGenerationInput,
  type AllocateGenerationResult,
  type AttachmentsLedgerPort,
  type AttachmentsPortOptions,
  type ClaimCleanupInput,
  type ClaimCleanupResult,
  type CleanupClaim,
  type CompleteCleanupInput,
  type CompleteCleanupResult,
  type CompleteGenerationInput,
  type CompleteGenerationResult,
  evaluateFinalizeHandoff,
  type FinalizeBindingFacts,
  type FinalizeHandoffInput,
  type FinalizeHandoffResult,
  type FinalizeHandoffRowFacts,
  type FinalizeLockInput,
  type FinalizeLockResult,
  type FindBlobForStatusInput,
  type FindBlobForStatusResult,
  type FindBlobForFinalizeInput,
  type FindBlobForFinalizeResult,
  type FindFinalizeByCommandIdInput,
  type FindFinalizeByCommandIdResult,
  type FindReplacementIntentByBindingInput,
  type FindReplacementIntentByBindingResult,
  type FindBlobForRetireInput,
  type FindBlobForRetireResult,
  type FindRetireByCommandIdInput,
  type FindRetireByCommandIdResult,
  type PhaseBarrier,
  type QuarantineGenerationInput,
  type QuarantineGenerationResult,
} from '../../modules/attachments/index.js';
import type {
  BlobLogicalState,
  ClaimVerificationInput,
  ClaimVerificationResult,
  CompleteUploadCasInput,
  CompleteUploadCasResult,
  CompleteUploadTargetInput,
  CompleteUploadTargetResult,
  CompleteVerificationInput,
  CompleteVerificationResult,
  FindBlobForDeliveryInput,
  FindBlobForDeliveryResult,
  GenerationState,
  QuarantineVerificationInput,
  QuarantineVerificationResult,
  ReadCleanupStateInput,
  ReadCleanupStateResult,
} from '../../modules/attachments/index.js';


/** Bounded batch ceiling for the keyset cleanup claim. */
export const ATTACHMENTS_CLEANUP_BATCH_LIMIT_MAX = 1_000;

function barrierOf(options: AttachmentsPortOptions | undefined): PhaseBarrier {
  return options?.barrier ?? NOOP_BARRIER;
}

function classifyConstraintViolation(error: unknown): DatabaseOperationError {
  return error instanceof DatabaseOperationError ? error : classifyDatabaseError(error, false);
}

function rethrowIdentityViolation(error: unknown): never {
  const classified = classifyConstraintViolation(error);
  if (classified.kind === 'unique_violation') {
    const code = attachmentsIdentityCodeForConstraint(classified.constraint);
    if (code) throw new AttachmentsIdentityError(code);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// findIntentByBinding: recover a committed intent/generation by binding
// ---------------------------------------------------------------------------

interface FindIntentRow {
  intent_id: string;
  blob_id: string;
  generation_id: string;
  principal_id: string;
  collection_id: string;
  subject_identity: string;
  expected_size: string | null;
  expected_sha256: string | null;
  media_hint: string | null;
  policy_revision: string;
  idempotency_key: string;
  expires_at: Date;
  key: string;
}

async function findIntentByBinding(
  tx: DatabaseTransaction,
  input: FindIntentByBindingInput,
  options: AttachmentsPortOptions = {},
): Promise<FindIntentByBindingResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('find_intent_before');
  const rows = await sql<FindIntentRow>`
    select ui.intent_id, ui.blob_id, ui.generation_id, ui.principal_id, ui.collection_id,
           ui.subject_identity, ui.expected_size::text, ui.expected_sha256, ui.media_hint,
           ui.policy_revision, ui.idempotency_key, ui.expires_at, bg.key
    from upload_intents ui
    join blob_generations bg on bg.generation_id = ui.generation_id
    where ui.collection_id = ${input.collectionId}
      and ui.subject_identity = ${input.subjectIdentity}
      and ui.idempotency_key = ${input.idempotencyKey}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    intent: {
      intentId: row.intent_id,
      generationId: row.generation_id,
      blobId: row.blob_id,
      key: row.key,
      principalId: row.principal_id,
      collectionId: row.collection_id,
      subjectIdentity: row.subject_identity,
      expectedSize: row.expected_size === null ? null : Number(row.expected_size),
      expectedSha256: row.expected_sha256,
      mediaHint: row.media_hint,
      policyRevision: row.policy_revision,
      idempotencyKey: row.idempotency_key,
      expiresAt: row.expires_at,
    },
  };
}
// ---------------------------------------------------------------------------
// allocate: ledger-before-grant in ONE transaction
// ---------------------------------------------------------------------------

async function allocateGeneration(
  tx: DatabaseTransaction,
  input: AllocateGenerationInput,
  options: AttachmentsPortOptions = {},
): Promise<AllocateGenerationResult> {
  const barrier = barrierOf(options);

  const existing = await sql<{ generation_id: string; blob_id: string }>`
    select generation_id, blob_id from upload_intents where intent_id = ${input.intentId}
  `.execute(tx);
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    if (row.generation_id === input.generationId && row.blob_id === input.blobId) {
      return { outcome: 'already_issued', intentId: input.intentId, generationId: input.generationId, blobId: input.blobId };
    }
    throw new AttachmentsIdentityError('intent_generation_mismatch');
  }

  await barrier.arriveAndWait('allocate_before_key');
  try {
    await sql`
      insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
      values (${input.generationId}, ${input.key}, ${input.keyFingerprint}, ${input.blobId}, 'allocate')
    `.execute(tx);
  } catch (error) {
    rethrowIdentityViolation(error);
  }

  await sql`
    insert into blob_records (blob_id, owner_subject_id, logical_state)
    values (${input.blobId}, ${input.subjectIdentity}, 'issued')
    on conflict (blob_id) do nothing
  `.execute(tx);
  await sql`select blob_id from blob_records where blob_id = ${input.blobId} for update`.execute(tx);

  // The blob_generations and upload_intents writes are identity-sensitive too:
  // any unique violation here is a permanent contract violation (a duplicate
  // generation/key/fingerprint or an idempotency conflict), never a retryable
  // database failure. The generation_keys write above already rejects the
  // common same-key/same-generation cases; these guards keep the stable
  // identity mapping at every write point in the ledger-before-grant order.
  try {
    await sql`
      insert into blob_generations (generation_id, blob_id, bucket, key, key_fingerprint, generation_state)
      values (${input.generationId}, ${input.blobId}, ${input.bucket}, ${input.key}, ${input.keyFingerprint}, 'allocated')
    `.execute(tx);
  } catch (error) {
    rethrowIdentityViolation(error);
  }

  try {
    await sql`
      insert into upload_intents (
        intent_id, blob_id, generation_id, principal_id, collection_id, subject_identity,
        expected_size, expected_sha256, media_hint, policy_revision, idempotency_key, expires_at
      ) values (
        ${input.intentId}, ${input.blobId}, ${input.generationId}, ${input.principalId}, ${input.collectionId},
        ${input.subjectIdentity}, ${input.expectedSize ?? null}, ${input.expectedSha256 ?? null},
        ${input.mediaHint ?? null}, ${input.policyRevision}, ${input.idempotencyKey}, ${input.expiresAt}
      )
    `.execute(tx);
  } catch (error) {
    rethrowIdentityViolation(error);
  }

  return { outcome: 'issued', intentId: input.intentId, generationId: input.generationId, blobId: input.blobId };
}

// ---------------------------------------------------------------------------
// complete: bind exact ETag/size/metadata; DB clock decides intent expiry
// ---------------------------------------------------------------------------

interface CompleteRow {
  generation_state: string;
  blob_id: string;
  logical_state: string;
  current_generation_id: string | null;
  observed_etag: string | null;
  observed_size: string | null;
  intent_expired: boolean;
}

async function completeGeneration(
  tx: DatabaseTransaction,
  input: CompleteGenerationInput,
  options: AttachmentsPortOptions = {},
): Promise<CompleteGenerationResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('complete_before');

  // Validate the fixed metadata allowlist before any SQL is issued; the DB
  // CHECK remains the durable backstop.
  const metadata = canonicalizeObservedMetadata(input.observedMetadata);
  assertObservedMetadataAllowlist(metadata);

  const rows = await sql<CompleteRow>`
    select bg.generation_state, bg.blob_id, bg.observed_etag, bg.observed_size::text,
           br.logical_state, br.current_generation_id,
           (ui.expires_at <= now()) as intent_expired
    from blob_generations bg
    join blob_records br on br.blob_id = bg.blob_id
    join upload_intents ui on ui.generation_id = bg.generation_id
    where bg.generation_id = ${input.generationId}
    for update of bg
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  if (row.blob_id !== input.blobId) return { outcome: 'identity_mismatch' };

  const observedSizeMatches = row.observed_size === null
    ? false
    : Number(row.observed_size) === input.observedSize;
  const bindingMatches = row.observed_etag === input.observedEtag && observedSizeMatches;

  if (row.intent_expired) {
    if (row.generation_state === 'allocated' || row.generation_state === 'observed') {
      await sql`
        update blob_generations set generation_state = 'orphaned', retire_reason = 'expired', orphaned_at = now()
        where generation_id = ${input.generationId} and generation_state = ${row.generation_state}
      `.execute(tx);
      if (row.logical_state === 'issued') {
        await sql`
          update blob_records set logical_state = 'expired', updated_at = now()
          where blob_id = ${input.blobId} and logical_state = 'issued'
        `.execute(tx);
      }
    }
    return { outcome: 'late_rejected', reason: 'expired' };
  }

  const metadataKeys = Object.keys(metadata);
  const metadataValues = metadataKeys.map((key) => metadata[key]!);

  switch (row.generation_state) {
    case 'allocated': {
      if (row.current_generation_id === null) {
        await sql`
          update blob_generations
          set generation_state = 'active', observed_etag = ${input.observedEtag},
              observed_size = ${input.observedSize}, observed_content_type = ${input.observedContentType},
              observed_metadata_keys = ${metadataKeys}, observed_metadata_values = ${metadataValues}
          where generation_id = ${input.generationId}
        `.execute(tx);
        await sql`
          update blob_records set current_generation_id = ${input.generationId}, logical_state = 'uploaded', updated_at = now()
          where blob_id = ${input.blobId}
        `.execute(tx);
        return { outcome: 'verified_active' };
      }
      await sql`
        update blob_generations
        set generation_state = 'observed', observed_etag = ${input.observedEtag},
            observed_size = ${input.observedSize}, observed_content_type = ${input.observedContentType},
            observed_metadata_keys = ${metadataKeys}, observed_metadata_values = ${metadataValues}
        where generation_id = ${input.generationId}
      `.execute(tx);
      return { outcome: 'verified_observed' };
    }
    case 'observed':
      return bindingMatches ? { outcome: 'idempotent' } : { outcome: 'identity_mismatch' };
    case 'active':
      if (row.current_generation_id === input.generationId) {
        return bindingMatches ? { outcome: 'idempotent' } : { outcome: 'identity_mismatch' };
      }
      return { outcome: 'late_rejected', reason: 'not_current' };
    case 'retired':
      return { outcome: 'late_rejected', reason: 'replaced' };
    case 'orphaned':
      return { outcome: 'late_rejected', reason: 'orphaned' };
    case 'deletion_pending':
      return { outcome: 'late_rejected', reason: 'not_completable' };
    case 'deleted':
      return { outcome: 'late_rejected', reason: 'deleted' };
    case 'contract_corrupt':
      return { outcome: 'late_rejected', reason: 'contract_corrupt' };
    case 'quarantined':
      return { outcome: 'late_rejected', reason: 'quarantined' };
    default:
      return { outcome: 'late_rejected', reason: 'not_completable' };
  }
}

// ---------------------------------------------------------------------------
// activateReplacement: one-transaction active/retired CAS
// ---------------------------------------------------------------------------

async function activateReplacement(
  tx: DatabaseTransaction,
  input: ActivateReplacementInput,
  options: AttachmentsPortOptions = {},
): Promise<ActivateReplacementResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('replacement_cas');

  const blobRows = await sql<{ current_generation_id: string | null; logical_state: string }>`
    select current_generation_id, logical_state from blob_records where blob_id = ${input.blobId} for update
  `.execute(tx);
  if (blobRows.rows.length === 0) return { outcome: 'blob_not_found' };
  // P4A-I13: a committed future Attachment binding (`attached_private`) is
  // terminal — the current generation pointer can never move again, so
  // replacement cannot break the binding.
  if (blobRows.rows[0]!.logical_state === 'attached_private') return { outcome: 'attached_not_replaced' };
  const current = blobRows.rows[0]!.current_generation_id;

  const newRows = await sql<{ generation_state: string; blob_id: string }>`
    select generation_state, blob_id from blob_generations
    where generation_id = ${input.newGenerationId} for update
  `.execute(tx);
  if (newRows.rows.length === 0) return { outcome: 'new_not_found' };
  const next = newRows.rows[0]!;
  if (next.blob_id !== input.blobId) return { outcome: 'new_not_found' };

  // A commit-unknown replay of an already-applied CAS converges idempotently
  // when the new generation is already the current active generation.
  if (next.generation_state === 'active' && current === input.newGenerationId) return { outcome: 'idempotent' };
  if (current !== input.expectedActiveGenerationId) return { outcome: 'stale_cas' };
  if (next.generation_state !== 'observed') return { outcome: 'new_not_verified' };

  // The one-active-per-blob partial unique index is immediate, so the expected
  // active generation MUST be retired before the new generation is activated.
  // Both statements commit atomically with the pointer move in this CAS.
  if (input.expectedActiveGenerationId) {
    await sql`
      update blob_generations set generation_state = 'retired', retire_reason = 'replaced', retired_at = now()
      where generation_id = ${input.expectedActiveGenerationId} and generation_state = 'active'
    `.execute(tx);
  }
  await sql`
    update blob_generations set generation_state = 'active'
    where generation_id = ${input.newGenerationId} and generation_state = 'observed'
  `.execute(tx);
  await sql`
    update blob_records set current_generation_id = ${input.newGenerationId}, updated_at = now()
    where blob_id = ${input.blobId} and current_generation_id = ${input.expectedActiveGenerationId}
  `.execute(tx);
  // P4A-P07: the pointer moved to a generation whose DIGEST has not been
  // verified yet (only the complete-attested observed facts are bound). A blob
  // that was `stored_private` under the old generation is therefore demoted
  // back to `uploaded` and its verified facts cleared, so the verification
  // worker re-verifies the NEW current generation before any status read or
  // finalize can consume it (the DTO can never show the old generation's
  // verified facts under the new pointer). `attached_private` is refused
  // above; `uploaded` blobs (fresh-first-generation seeds) are untouched.
  await sql`
    update blob_records
    set logical_state = 'uploaded',
        verified_size = null, verified_sha256 = null, media_type = null,
        verification_policy_version = null, updated_at = now()
    where blob_id = ${input.blobId} and logical_state = 'stored_private'
  `.execute(tx);
  return { outcome: 'activated' };
}

// ---------------------------------------------------------------------------
// claimCleanup: snapshot exact candidate + attempt token + DB-time deadline
// ---------------------------------------------------------------------------

interface ClaimedRow {
  generation_id: string;
  created_at: Date;
  blob_id: string;
  bucket: string;
  key: string;
  key_fingerprint: string;
  observed_etag: string | null;
  observed_size: string | null;
  cleanup_attempt_token: string;
  cleanup_lease_owner: string;
  cleanup_lease_generation: string;
  cleanup_lease_expires_at: Date;
}

function toClaim(row: ClaimedRow, currentGenerationId: string | null): CleanupClaim {
  return {
    generationId: row.generation_id,
    createdAt: row.created_at,
    blobId: row.blob_id,
    bucket: row.bucket,
    key: row.key,
    keyFingerprint: row.key_fingerprint,
    observedEtag: row.observed_etag,
    observedSize: row.observed_size === null ? null : Number(row.observed_size),
    leaseOwner: row.cleanup_lease_owner,
    attemptToken: row.cleanup_attempt_token,
    leaseGeneration: BigInt(row.cleanup_lease_generation),
    leaseExpiresAt: row.cleanup_lease_expires_at,
    currentGenerationId,
  };
}

async function classifyUnclaimed(tx: DatabaseTransaction, generationId: string, blobId: string | null): Promise<ClaimCleanupResult> {
  if (!blobId) return { outcome: 'not_claimable' };
  // The database clock is authoritative: an unexpired deletion_pending lease is
  // held by another worker; an expired lease may be taken over.
  const current = await sql<{ generation_state: string; lease_held: boolean }>`
    select bg.generation_state,
           (bg.cleanup_lease_expires_at is not null and bg.cleanup_lease_expires_at >= now()) as lease_held
    from blob_generations bg
    where bg.generation_id = ${generationId}
  `.execute(tx);
  const state = current.rows[0];
  if (!state) return { outcome: 'not_claimable' };
  if (state.generation_state === 'deletion_pending' && state.lease_held) return { outcome: 'lease_held' };
  return { outcome: 'not_claimable' };
}

async function claimByGeneration(
  tx: DatabaseTransaction,
  input: ClaimCleanupInput,
  options: AttachmentsPortOptions,
): Promise<ClaimCleanupResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('before_cleanup_claim');

  const generation = await sql<{ blob_id: string }>`
    select blob_id from blob_generations where generation_id = ${input.generationId}
  `.execute(tx);
  if (generation.rows.length === 0) return { outcome: 'not_claimable' };
  const blobId = generation.rows[0]!.blob_id;

  // FOR SHARE on the blob row serializes with a concurrent finalizeLock
  // (FOR UPDATE) and freezes the current-generation snapshot.
  const blobRows = await sql<{ current_generation_id: string | null }>`
    select current_generation_id from blob_records where blob_id = ${blobId} for share
  `.execute(tx);
  if (blobRows.rows.length === 0) return { outcome: 'not_claimable' };
  const currentGenerationId = blobRows.rows[0]!.current_generation_id;
  const retiredRetentionDays = input.retiredRetentionDays ?? null;

  const updated = await sql<ClaimedRow>`
    update blob_generations bg
    set generation_state = 'deletion_pending',
        cleanup_attempt_token = ${randomUUID()},
        cleanup_lease_owner = ${input.leaseOwner},
        cleanup_lease_generation = bg.cleanup_lease_generation + 1,
        cleanup_lease_expires_at = now() + make_interval(secs => ${input.leaseTtlSeconds})
    from blob_records br
    where bg.generation_id = ${input.generationId}
      and br.blob_id = bg.blob_id
      and bg.generation_state in ('retired', 'orphaned', 'deletion_pending')
      and (bg.cleanup_lease_expires_at is null or bg.cleanup_lease_expires_at < now())
      and br.current_generation_id is distinct from bg.generation_id
      and (${retiredRetentionDays}::int is null
          or bg.generation_state = 'deletion_pending'
          or coalesce(bg.retired_at, bg.orphaned_at) <= now() - make_interval(days => ${retiredRetentionDays}))
    returning bg.generation_id, bg.created_at, bg.blob_id, bg.bucket, bg.key, bg.key_fingerprint,
              bg.observed_etag, bg.observed_size::text, bg.cleanup_attempt_token, bg.cleanup_lease_owner,
              bg.cleanup_lease_generation::text, bg.cleanup_lease_expires_at
  `.execute(tx);
  if (updated.rows.length === 0) {
    return classifyUnclaimed(tx, input.generationId!, blobId);
  }
  await barrier.arriveAndWait('after_cleanup_claim');
  return { outcome: 'claimed', claim: toClaim(updated.rows[0]!, currentGenerationId) };
}

const CLEANUP_KEYSET_EPOCH = '1970-01-01T00:00:00.000Z';

async function claimBatch(
  tx: DatabaseTransaction,
  input: ClaimCleanupInput,
): Promise<ClaimCleanupResult> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 1)), ATTACHMENTS_CLEANUP_BATCH_LIMIT_MAX);
  const cursor = input.cursor ?? null;
  const createdAtBound = cursor?.createdAtIso ?? CLEANUP_KEYSET_EPOCH;
  const generationBound = cursor?.generationId ?? '';
  const retiredRetentionDays = input.retiredRetentionDays ?? null;

  // P4A-I14 allocated->orphan late-upload reconciliation: an allocated
  // generation whose intent already expired (DB clock) becomes an orphaned
  // candidate with a DB-clock orphaned_at. Bounded by the same keyset cursor
  // so the backfill can never scan the whole table.
  if (retiredRetentionDays !== null) {
    const reconciledIds = await sql<{ generation_id: string }>`
      select bg2.generation_id
      from blob_generations bg2
      join upload_intents ui on ui.generation_id = bg2.generation_id
      where bg2.generation_state = 'allocated'
        and ui.expires_at < now()
        and (bg2.created_at, bg2.generation_id) > (${createdAtBound}::timestamptz, ${generationBound})
      order by bg2.created_at, bg2.generation_id
      limit ${limit}
      for update of bg2 skip locked
    `.execute(tx);
    if (reconciledIds.rows.length > 0) {
      const reconciled = reconciledIds.rows.map((row) => row.generation_id);
      await sql`
        update blob_generations set generation_state = 'orphaned', retire_reason = 'expired', orphaned_at = now()
        where generation_id = any(${reconciled}::text[]) and generation_state = 'allocated'
      `.execute(tx);
    }
  }

  const candidates = await sql<{ generation_id: string }>`
    select bg2.generation_id
    from blob_generations bg2
    join blob_records br2 on br2.blob_id = bg2.blob_id
    where bg2.generation_state in ('retired', 'orphaned', 'deletion_pending')
      and (bg2.cleanup_lease_expires_at is null or bg2.cleanup_lease_expires_at < now())
      and br2.current_generation_id is distinct from bg2.generation_id
      and (${retiredRetentionDays}::int is null
          or bg2.generation_state = 'deletion_pending'
          or coalesce(bg2.retired_at, bg2.orphaned_at) <= now() - make_interval(days => ${retiredRetentionDays}))
      and (bg2.created_at, bg2.generation_id) > (${createdAtBound}::timestamptz, ${generationBound})
    order by bg2.created_at, bg2.generation_id
    limit ${limit}
    for update of bg2 skip locked
    for share of br2
  `.execute(tx);
  if (candidates.rows.length === 0) return { outcome: 'none' };

  const ids = candidates.rows.map((row) => row.generation_id);
  const updated = await sql<ClaimedRow & { current_generation_id: string | null }>`
    update blob_generations bg
    set generation_state = 'deletion_pending',
        cleanup_attempt_token = ${randomUUID()},
        cleanup_lease_owner = ${input.leaseOwner},
        cleanup_lease_generation = bg.cleanup_lease_generation + 1,
        cleanup_lease_expires_at = now() + make_interval(secs => ${input.leaseTtlSeconds})
    from blob_records br
    where bg.generation_id = any(${ids}::text[])
      and br.blob_id = bg.blob_id
      and br.current_generation_id is distinct from bg.generation_id
    returning bg.generation_id, bg.created_at, bg.blob_id, bg.bucket, bg.key, bg.key_fingerprint,
              bg.observed_etag, bg.observed_size::text, bg.cleanup_attempt_token, bg.cleanup_lease_owner,
              bg.cleanup_lease_generation::text, bg.cleanup_lease_expires_at,
              br.current_generation_id
  `.execute(tx);
  if (updated.rows.length === 0) return { outcome: 'none' };
  return {
    outcome: 'batch',
    claims: updated.rows.map((row) => toClaim(row, row.current_generation_id)),
  };
}

async function claimCleanup(
  tx: DatabaseTransaction,
  input: ClaimCleanupInput,
  options: AttachmentsPortOptions = {},
): Promise<ClaimCleanupResult> {
  if (input.generationId) {
    return claimByGeneration(tx, input, options);
  }
  return claimBatch(tx, input);
}

// ---------------------------------------------------------------------------
// completeCleanup: CAS commit under the exact claim fence
// ---------------------------------------------------------------------------

async function completeCleanup(
  tx: DatabaseTransaction,
  input: CompleteCleanupInput,
  options: AttachmentsPortOptions = {},
): Promise<CompleteCleanupResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('before_cleanup_complete');

  const current = await sql<{ generation_state: string }>`
    select generation_state from blob_generations where generation_id = ${input.claim.generationId}
  `.execute(tx);
  if (current.rows.length === 0) return { outcome: 'not_claimable' };
  if (current.rows[0]!.generation_state === 'deleted') return { outcome: 'already_deleted' };
  if (current.rows[0]!.generation_state === 'quarantined') return { outcome: 'already_quarantined' };

  const verdict = input.verdict;
  const terminal = verdict === 'confirmed_absent' || verdict === 'deleted';
  const updated = await sql<{ generation_state: string }>`
    update blob_generations
    set generation_state = case
          when ${terminal} then 'deleted'
          when ${verdict} = 'candidate_mismatch' then 'contract_corrupt'
          else generation_state
        end,
        cleanup_attempt_token = null,
        cleanup_lease_owner = null,
        cleanup_lease_expires_at = null,
        confirmed_absent_at = case when ${terminal} then now() else confirmed_absent_at end,
        deleted_at = case when ${terminal} then now() else deleted_at end,
        contract_corrupt_at = case when ${verdict} = 'candidate_mismatch' then now() else contract_corrupt_at end,
        quarantined_reason = case when ${verdict} = 'candidate_mismatch'
          then ${input.mismatchReason ?? 'candidate_mismatch'} else quarantined_reason end
    where generation_id = ${input.claim.generationId}
      and cleanup_attempt_token = ${input.claim.attemptToken}
      and cleanup_lease_owner = ${input.claim.leaseOwner}
      and cleanup_lease_generation = ${input.claim.leaseGeneration.toString()}
      and generation_state = 'deletion_pending'
    returning generation_state
  `.execute(tx);
  if (updated.rows.length === 0) return { outcome: 'lease_lost' };

  if (verdict === 'candidate_mismatch') {
    await sql`
      update blob_generations
      set generation_state = 'quarantined', quarantined_at = now()
      where generation_id = ${input.claim.generationId} and generation_state = 'contract_corrupt'
    `.execute(tx);
    return { outcome: 'quarantined' };
  }
  if (verdict === 'unknown_retryable') return { outcome: 'released' };
  return { outcome: 'completed', state: 'deleted' };
}

// ---------------------------------------------------------------------------
// readCleanupState: re-read a claimed generation row after commit-unknown
// ---------------------------------------------------------------------------

async function readCleanupState(
  tx: DatabaseTransaction,
  input: ReadCleanupStateInput,
  options: AttachmentsPortOptions = {},
): Promise<ReadCleanupStateResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('read_cleanup_state');
  const rows = await sql<{ generation_state: string; cleanup_attempt_token: string | null;
    cleanup_lease_owner: string | null; cleanup_lease_generation: string }>`
    select generation_state, cleanup_attempt_token, cleanup_lease_owner, cleanup_lease_generation::text
    from blob_generations where generation_id = ${input.generationId}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    row: {
      generationState: row.generation_state as GenerationState,
      cleanupAttemptToken: row.cleanup_attempt_token,
      cleanupLeaseOwner: row.cleanup_lease_owner,
      cleanupLeaseGeneration: row.cleanup_lease_generation,
    },
  };
}

// ---------------------------------------------------------------------------
// finalizeLock: FOR UPDATE on stored_private blob + current generation
// ---------------------------------------------------------------------------

async function finalizeLock(
  tx: DatabaseTransaction,
  input: FinalizeLockInput,
  options: AttachmentsPortOptions = {},
): Promise<FinalizeLockResult> {
  const barrier = barrierOf(options);
  const blobRows = await sql<{ logical_state: string; current_generation_id: string | null }>`
    select logical_state, current_generation_id from blob_records where blob_id = ${input.blobId} for update
  `.execute(tx);
  if (blobRows.rows.length === 0) return { outcome: 'not_found' };
  const blob = blobRows.rows[0]!;
  await barrier.arriveAndWait('after_finalize_lock');
  if (blob.logical_state !== 'stored_private') {
    return { outcome: 'not_finalizable', logicalState: blob.logical_state };
  }
  if (blob.current_generation_id === null) {
    return { outcome: 'not_finalizable', logicalState: blob.logical_state };
  }
  if (input.expectedGenerationId != null && blob.current_generation_id !== input.expectedGenerationId) {
    return {
      outcome: 'generation_mismatch',
      expectedGenerationId: input.expectedGenerationId,
      currentGenerationId: blob.current_generation_id,
    };
  }
  await sql`
    select generation_id from blob_generations
    where generation_id = ${blob.current_generation_id} for update
  `.execute(tx);
  const updated = await sql<{ finalize_lease_owner: string; finalize_lease_expires_at: Date }>`
    update blob_records
    set finalize_lease_owner = ${input.leaseOwner},
        finalize_lease_expires_at = now() + make_interval(secs => ${input.leaseTtlSeconds}),
        updated_at = now()
    where blob_id = ${input.blobId}
    returning finalize_lease_owner, finalize_lease_expires_at
  `.execute(tx);
  return {
    outcome: 'locked',
    blobId: input.blobId,
    logicalState: 'stored_private',
    currentGenerationId: blob.current_generation_id,
    finalizeLeaseOwner: updated.rows[0]!.finalize_lease_owner,
    finalizeLeaseExpiresAt: updated.rows[0]!.finalize_lease_expires_at,
  };
}

// ---------------------------------------------------------------------------
// finalizeHandoff: transaction-bound stored_private -> attached_private
//
// P4A-I13. The port REQUIRES the caller's transaction, never opens a new one,
// and performs NO R2 / network call. It locks the blob row and the CURRENT
// generation row FOR UPDATE (the cleanup claim takes FOR SHARE on the blob
// row, so the two prove mutual exclusion), verifies logical state, current
// generation, owner binding, generation ETag, verified size/digest/media,
// expiry (retention deadline vs the DB clock) and policy revision through the
// pure evaluator, and then atomically writes the unique future Attachment
// binding facts + `stored_private -> attached_private` in the SAME
// transaction. It never creates a production Attachment/Operation/Audit/
// Outbox row (those belong to the future Canonical Mutation caller).
// ---------------------------------------------------------------------------

interface FinalizeHandoffBlobRow {
  logical_state: string;
  owner_subject_id: string;
  current_generation_id: string | null;
  verified_size: string | null;
  verified_sha256: string | null;
  media_type: string | null;
  verification_policy_version: string | null;
  retention_deadline: Date | null;
  attachment_binding_id: string | null;
  attached_at: Date | null;
  attachment_binding_generation_id: string | null;
  attachment_binding_etag: string | null;
  attachment_binding_policy_version: string | null;
}

interface FinalizeHandoffGenerationRow {
  generation_state: string;
  observed_etag: string | null;
}

async function readFinalizeHandoffFacts(
  tx: DatabaseTransaction,
  input: FinalizeHandoffInput,
): Promise<{
  blob: FinalizeHandoffBlobRow;
  generation: FinalizeHandoffGenerationRow | null;
  now: Date;
} | 'not_found'> {
  const nowRows = await sql<{ now: Date }>`select now() as now`.execute(tx);
  const now = nowRows.rows[0]!.now;
  const blobRows = await sql<FinalizeHandoffBlobRow>`
    select logical_state, owner_subject_id, current_generation_id, verified_size::text,
           verified_sha256, media_type, verification_policy_version, retention_deadline,
           attachment_binding_id, attached_at, attachment_binding_generation_id,
           attachment_binding_etag, attachment_binding_policy_version
    from blob_records
    where blob_id = ${input.blobId}
    for update
  `.execute(tx);
  if (blobRows.rows.length === 0) return 'not_found';
  const blob = blobRows.rows[0]!;
  let generation: FinalizeHandoffGenerationRow | null = null;
  if (blob.current_generation_id !== null) {
    const generationRows = await sql<FinalizeHandoffGenerationRow>`
      select generation_state, observed_etag from blob_generations
      where generation_id = ${blob.current_generation_id} and blob_id = ${input.blobId}
      for update
    `.execute(tx);
    if (generationRows.rows.length > 0) generation = generationRows.rows[0]!;
  }
  return { blob, generation, now };
}

function toFinalizeRowFacts(
  input: FinalizeHandoffInput,
  blob: FinalizeHandoffBlobRow,
  generation: FinalizeHandoffGenerationRow | null,
  now: Date,
): FinalizeHandoffRowFacts {
  return {
    blobId: input.blobId,
    logicalState: blob.logical_state as BlobLogicalState,
    ownerSubjectId: blob.owner_subject_id,
    currentGenerationId: blob.current_generation_id,
    verifiedSize: blob.verified_size === null ? null : Number(blob.verified_size),
    verifiedSha256: blob.verified_sha256,
    mediaType: blob.media_type,
    verificationPolicyVersion: blob.verification_policy_version,
    retentionDeadline: blob.retention_deadline,
    now,
    generationState: generation ? (generation.generation_state as GenerationState) : null,
    observedEtag: generation?.observed_etag ?? null,
    attachmentBindingId: blob.attachment_binding_id,
    attachedAt: blob.attached_at,
    attachmentBindingGenerationId: blob.attachment_binding_generation_id,
    attachmentBindingEtag: blob.attachment_binding_etag,
    attachmentBindingPolicyVersion: blob.attachment_binding_policy_version,
  };
}

async function finalizeHandoff(
  tx: DatabaseTransaction,
  input: FinalizeHandoffInput,
  options: AttachmentsPortOptions = {},
): Promise<FinalizeHandoffResult> {
  // Hard runtime guard: this port is transaction-bound by contract. A missing
  // transaction is a programming error, never a reason to open a new one.
  if (!tx) throw new Error('finalize_handoff_requires_transaction');

  const barrier = barrierOf(options);
  const facts = await readFinalizeHandoffFacts(tx, input);
  if (facts === 'not_found') return { outcome: 'not_found' };
  await barrier.arriveAndWait('after_finalize_handoff_lock');

  const evaluation = evaluateFinalizeHandoff(toFinalizeRowFacts(input, facts.blob, facts.generation, facts.now), input);
  if (evaluation.verdict === 'attach') {
    const updated = await sql<{
      attachment_binding_id: string;
      attached_at: Date;
      attachment_binding_generation_id: string;
      attachment_binding_etag: string;
      attachment_binding_policy_version: string;
    }>`
      update blob_records
      set logical_state = 'attached_private',
          attachment_binding_id = ${input.attachmentBindingId},
          attached_at = now(),
          attachment_binding_generation_id = ${facts.blob.current_generation_id},
          attachment_binding_etag = ${facts.generation?.observed_etag ?? null},
          attachment_binding_policy_version = ${input.policyRevision},
          finalize_lease_owner = null,
          finalize_lease_expires_at = null,
          updated_at = now()
      where blob_id = ${input.blobId}
        and logical_state = 'stored_private'
        and current_generation_id = ${input.expectedGenerationId}
      returning attachment_binding_id, attached_at, attachment_binding_generation_id,
                attachment_binding_etag, attachment_binding_policy_version
    `.execute(tx);
    if (updated.rows.length === 0) {
      // Defensive: under the FOR UPDATE lock this cannot happen. Re-read the
      // row (the lock is still held) and classify like a fresh call so the
      // caller never observes a half state.
      const reRead = await readFinalizeHandoffFacts(tx, input);
      if (reRead === 'not_found') return { outcome: 'not_found' };
      return classifyFinalizeHandoff(input, reRead.blob, reRead.generation, reRead.now);
    }
    const row = updated.rows[0]!;
    const binding: FinalizeBindingFacts = {
      blobId: input.blobId,
      attachmentBindingId: row.attachment_binding_id,
      generationId: facts.blob.current_generation_id!,
      etag: row.attachment_binding_etag,
      policyVersion: row.attachment_binding_policy_version,
      attachedAt: row.attached_at,
    };
    return { outcome: 'attached', binding };
  }
  return classifyFinalizeHandoff(input, facts.blob, facts.generation, facts.now, evaluation);
}

function classifyFinalizeHandoff(
  input: FinalizeHandoffInput,
  blob: FinalizeHandoffBlobRow,
  generation: FinalizeHandoffGenerationRow | null,
  now: Date,
  evaluation = evaluateFinalizeHandoff(toFinalizeRowFacts(input, blob, generation, now), input),
): FinalizeHandoffResult {
  if (evaluation.verdict === 'idempotent') return { outcome: 'idempotent', binding: evaluation.binding };
  if (evaluation.verdict === 'binding_conflict') {
    return {
      outcome: 'binding_conflict',
      existingBindingId: evaluation.binding.attachmentBindingId,
      binding: evaluation.binding,
    };
  }
  if (evaluation.verdict === 'attach') {
    // The main path applies the CAS for `attach`; reaching the classifier with
    // an attach verdict means the row still needs the write (only reachable in
    // the defensive update-miss path, which the FOR UPDATE lock makes
    // unreachable). Fail loudly rather than half-classify.
    throw new Error('finalize_handoff_attach_must_be_applied_by_caller');
  }
  const rejection = evaluation.rejection;
  switch (rejection.code) {
    case 'not_finalizable':
      return { outcome: 'not_finalizable', logicalState: rejection.logicalState };
    case 'generation_mismatch':
      return {
        outcome: 'generation_mismatch',
        expectedGenerationId: rejection.expectedGenerationId,
        currentGenerationId: rejection.currentGenerationId,
      };
    case 'owner_mismatch':
      return { outcome: 'owner_mismatch' };
    case 'etag_mismatch':
      return { outcome: 'etag_mismatch' };
    case 'verified_facts_mismatch':
      return { outcome: 'verified_facts_mismatch', code: rejection.verifiedFacts[0]! };
    case 'policy_mismatch':
      return { outcome: 'policy_mismatch' };
    case 'expired':
      return { outcome: 'expired' };
    case 'binding_corrupt':
      // Defensive: the terminal-facts CHECK makes this unreachable; treat a
      // corrupt attached row as non-finalizable rather than silently rebinding.
      return { outcome: 'not_finalizable', logicalState: 'attached_private' };
    default: {
      const exhaustive: never = rejection;
      throw new Error(`finalize_handoff_unhandled_rejection:${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// quarantineGeneration: explicit contract-corruption quarantine
// ---------------------------------------------------------------------------

async function quarantineGeneration(
  tx: DatabaseTransaction,
  input: QuarantineGenerationInput,
  options: AttachmentsPortOptions = {},
): Promise<QuarantineGenerationResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('before_quarantine');
  const rows = await sql<{ generation_state: string }>`
    select generation_state from blob_generations where generation_id = ${input.generationId}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const state = rows.rows[0]!.generation_state;
  if (state === 'quarantined') return { outcome: 'already_quarantined' };
  if (state === 'deleted') return { outcome: 'already_deleted' };

  await sql`
    update blob_generations
    set generation_state = 'contract_corrupt', contract_corrupt_at = now(),
        quarantined_reason = ${input.reason}
    where generation_id = ${input.generationId} and generation_state <> 'deleted'
  `.execute(tx);
  const quarantined = await sql<{ generation_state: string }>`
    update blob_generations
    set generation_state = 'quarantined', quarantined_at = now()
    where generation_id = ${input.generationId} and generation_state = 'contract_corrupt'
    returning generation_state
  `.execute(tx);
  if (quarantined.rows.length === 0) return { outcome: 'not_claimable' };
  return { outcome: 'quarantined' };
}


// ---------------------------------------------------------------------------
// P4A-I10 findBlobForDelivery: current active generation + owner + policy
// facts from the opaque logical blob identity. Consistent read with FOR SHARE
// on the blob row and the current generation row: it serializes with a
// concurrent replacement/finalize CAS (FOR UPDATE) and freezes the current-
// generation snapshot for the admission transaction. The physical key is never
// selected or returned (no key leakage; the isolated origin resolves the exact
// generation itself from the capability binding).
// ---------------------------------------------------------------------------

interface DeliveryBlobRow {
  owner_subject_id: string;
  logical_state: string;
  collection_id: string | null;
  current_generation_id: string | null;
  current_generation_state: string | null;
  verified_size: string | null;
  verified_sha256: string | null;
  media_type: string | null;
  verification_policy_version: string | null;
}

async function findBlobForDelivery(
  tx: DatabaseTransaction,
  input: FindBlobForDeliveryInput,
  options: AttachmentsPortOptions = {},
): Promise<FindBlobForDeliveryResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('delivery_read_before');
  // Frozen consistent read: lock the blob row AND the current generation row
  // FOR SHARE so a concurrent replacement/finalize CAS (FOR UPDATE) blocks and
  // the current-generation snapshot cannot tear inside the admission
  // transaction. PostgreSQL forbids FOR SHARE on the nullable side of an outer
  // join, so the two row locks are taken as separate statements and the fact
  // read below runs under those held locks.
  const locked = await sql<{ current_generation_id: string | null }>`
    select current_generation_id from blob_records where blob_id = ${input.blobId} for share
  `.execute(tx);
  if (locked.rows.length === 0) return { outcome: 'not_found' };
  const lockedGenerationId = locked.rows[0]!.current_generation_id;
  if (lockedGenerationId !== null) {
    await sql`
      select 1 from blob_generations where generation_id = ${lockedGenerationId} for share
    `.execute(tx);
  }
  const rows = await sql<DeliveryBlobRow>`
    select br.owner_subject_id, br.logical_state, br.current_generation_id,
           br.verified_size::text, br.verified_sha256, br.media_type, br.verification_policy_version,
           bg.generation_state as current_generation_state,
           ui.collection_id
    from blob_records br
    left join blob_generations bg on bg.generation_id = br.current_generation_id
    left join upload_intents ui on ui.generation_id = br.current_generation_id
    where br.blob_id = ${input.blobId}
  `.execute(tx);
  await barrier.arriveAndWait('delivery_read_after');
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    facts: {
      blobId: input.blobId,
      ownerSubjectId: row.owner_subject_id,
      logicalState: row.logical_state as BlobLogicalState,
      collectionId: row.collection_id,
      currentGenerationId: row.current_generation_id,
      currentGenerationState: row.current_generation_state as GenerationState | null,
      verifiedSize: row.verified_size === null ? null : Number(row.verified_size),
      verifiedSha256: row.verified_sha256,
      mediaType: row.media_type,
      verificationPolicyVersion: row.verification_policy_version,
    },
  };
}
// ---------------------------------------------------------------------------
// P4A-P04 findBlobForStatus: current blob/generation/intent/metadata facts
// from the opaque logical blob identity in ONE indexed SELECT. The physical
// key, key fingerprint, digest, provider metadata, and lease facts are never
// selected (the DTO cannot leak what the port never loads); the attachments
// metadata join surfaces the terminal retired/deleted facts for concealment.
// ---------------------------------------------------------------------------

interface StatusBlobRow {
  owner_subject_id: string;
  logical_state: string;
  current_generation_id: string | null;
  current_generation_state: string | null;
  collection_id: string | null;
  verified_size: string | null;
  media_type: string | null;
  expected_size: string | null;
  media_hint: string | null;
  created_at: Date;
  updated_at: Date;
  attachment_logical_state: 'attached_private' | 'retired' | 'deleted' | null;
}

async function findBlobForStatus(
  tx: DatabaseTransaction,
  input: FindBlobForStatusInput,
  options: AttachmentsPortOptions = {},
): Promise<FindBlobForStatusResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('status_read_before');
  const rows = await sql<StatusBlobRow>`
    select br.owner_subject_id, br.logical_state, br.current_generation_id,
           br.verified_size::text, br.media_type, br.created_at, br.updated_at,
           bg.generation_state as current_generation_state,
           ui.collection_id, ui.expected_size::text, ui.media_hint,
           a.logical_state as attachment_logical_state
    from blob_records br
    left join blob_generations bg on bg.generation_id = br.current_generation_id
    -- The intent of the CURRENT generation carries the declared facts. An
    -- issued blob has no current pointer yet (the pointer is set on complete)
    -- and then carries exactly ONE intent, so the blob_id join with the
    -- current-generation filter resolves to at most one row in both phases;
    -- after replacement the non-current generation's intent is excluded.
    left join upload_intents ui on ui.blob_id = br.blob_id
      and (br.current_generation_id is null or ui.generation_id = br.current_generation_id)
    left join attachments a on a.blob_id = br.blob_id
    where br.blob_id = ${input.blobId}
  `.execute(tx);
  await barrier.arriveAndWait('status_read_after');
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    facts: {
      blobId: input.blobId,
      ownerSubjectId: row.owner_subject_id,
      logicalState: row.logical_state as BlobLogicalState,
      currentGenerationId: row.current_generation_id,
      currentGenerationState: row.current_generation_state as GenerationState | null,
      collectionId: row.collection_id,
      verifiedSize: row.verified_size === null ? null : Number(row.verified_size),
      mediaType: row.media_type,
      expectedSize: row.expected_size === null ? null : Number(row.expected_size),
      mediaHint: row.media_hint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      attachmentLogicalState: row.attachment_logical_state,
    },
  };
}
// ---------------------------------------------------------------------------
// P4A-P06 finalize resolution: the Product finalize use case resolves its
// canonical input from the committed ledger in the SAME transaction (owner
// binding, current generation + verified facts, collection scope, terminal
// attachment facts) and re-reads the committed idempotency receipt by the
// persisted commandId. The physical key, key fingerprint, provider metadata
// and lease facts are never selected; the verified digest is loaded ONLY to
// feed the canonical handoff fence inside the same transaction (it never
// leaves the use case or any row it writes).
// ---------------------------------------------------------------------------

interface FinalizeBlobRow {
  owner_subject_id: string;
  logical_state: string;
  current_generation_id: string | null;
  current_generation_state: string | null;
  collection_id: string | null;
  observed_etag: string | null;
  verified_size: string | null;
  verified_sha256: string | null;
  media_type: string | null;
  verification_policy_version: string | null;
  attachment_logical_state: 'attached_private' | 'retired' | 'deleted' | null;
}

async function findBlobForFinalize(
  tx: DatabaseTransaction,
  input: FindBlobForFinalizeInput,
  options: AttachmentsPortOptions = {},
): Promise<FindBlobForFinalizeResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('finalize_read_before');
  const rows = await sql<FinalizeBlobRow>`
    select br.owner_subject_id, br.logical_state, br.current_generation_id,
           br.verified_size::text, br.verified_sha256, br.media_type, br.verification_policy_version,
           bg.generation_state as current_generation_state, bg.observed_etag,
           ui.collection_id,
           a.logical_state as attachment_logical_state
    from blob_records br
    left join blob_generations bg on bg.generation_id = br.current_generation_id
    -- The intent of the CURRENT generation carries the collection scope; an
    -- issued blob has no current pointer yet and carries exactly ONE intent.
    left join upload_intents ui on ui.blob_id = br.blob_id
      and (br.current_generation_id is null or ui.generation_id = br.current_generation_id)
    left join attachments a on a.blob_id = br.blob_id
    where br.blob_id = ${input.blobId}
  `.execute(tx);
  await barrier.arriveAndWait('finalize_read_after');
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    facts: {
      blobId: input.blobId,
      ownerSubjectId: row.owner_subject_id,
      logicalState: row.logical_state as BlobLogicalState,
      currentGenerationId: row.current_generation_id,
      currentGenerationState: row.current_generation_state as GenerationState | null,
      collectionId: row.collection_id,
      observedEtag: row.observed_etag,
      verifiedSize: row.verified_size === null ? null : Number(row.verified_size),
      verifiedSha256: row.verified_sha256,
      mediaType: row.media_type,
      verificationPolicyVersion: row.verification_policy_version,
      attachmentLogicalState: row.attachment_logical_state,
    },
  };
}

async function findFinalizeByCommandId(
  tx: DatabaseTransaction,
  input: FindFinalizeByCommandIdInput,
  options: AttachmentsPortOptions = {},
): Promise<FindFinalizeByCommandIdResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('finalize_command_before');
  const row = await findLatestAttachmentOperationByCommandId(
    tx, 'attachment.finalized', input.commandId,
  );
  await barrier.arriveAndWait('finalize_command_after');
  if (!row) return { outcome: 'not_found' };
  return {
    outcome: 'found',
    facts: {
      operationId: row.operation_id,
      commitOrdinal: BigInt(row.commit_ordinal),
      collectionId: row.collection_id,
      attachmentId: row.attachment_id,
      blobId: row.blob_id,
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// P4A-I09 attachments-postgres-ports additions (spliced by .i09-rebuild-ports.cjs)
//

// ---------------------------------------------------------------------------
// P4A-I09 complete target: resolve the committed generation (key is a ledger
// fact, never a client input)
// ---------------------------------------------------------------------------

interface CompleteTargetRow {
  intent_id: string;
  blob_id: string;
  generation_id: string;
  principal_id: string;
  expected_size: string | null;
  expected_sha256: string | null;
  media_hint: string | null;
  expires_at: Date;
  bucket: string;
  key: string;
  generation_state: string;
  logical_state: string;
  current_generation_id: string | null;
  observed_etag: string | null;
  observed_size: string | null;
}

async function findCompleteTarget(
  tx: DatabaseTransaction,
  input: CompleteUploadTargetInput,
  options: AttachmentsPortOptions = {},
): Promise<CompleteUploadTargetResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('complete_target_before');
  const rows = await sql<CompleteTargetRow>`
    select ui.intent_id, ui.blob_id, ui.generation_id, ui.principal_id,
           ui.expected_size::text, ui.expected_sha256, ui.media_hint, ui.expires_at,
           bg.bucket, bg.key, bg.generation_state, br.logical_state,
           br.current_generation_id, bg.observed_etag, bg.observed_size::text
    from upload_intents ui
    join blob_generations bg on bg.generation_id = ui.generation_id
    join blob_records br on br.blob_id = ui.blob_id
    where ui.intent_id = ${input.intentId}
      and ui.generation_id = ${input.generationId}
      and ui.blob_id = ${input.blobId}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    facts: {
      intentId: row.intent_id,
      generationId: row.generation_id,
      blobId: row.blob_id,
      key: row.key,
      bucket: row.bucket,
      principalId: row.principal_id,
      expectedSize: row.expected_size === null ? null : Number(row.expected_size),
      expectedSha256: row.expected_sha256,
      mediaHint: row.media_hint,
      expiresAt: row.expires_at,
      generationState: row.generation_state as GenerationState,
      blobLogicalState: row.logical_state as BlobLogicalState,
      currentGenerationId: row.current_generation_id,
      observedEtag: row.observed_etag,
      observedSize: row.observed_size === null ? null : Number(row.observed_size),
    },
  };
}

// ---------------------------------------------------------------------------
// P4A-I09 complete CAS: issued -> uploaded + bound observed facts. The
// verification Outbox enqueue is performed by the use case in the SAME
// transaction; this port only mutates the attachments ledger.
// ---------------------------------------------------------------------------

interface CompleteCasRow {
  generation_state: string;
  blob_id: string;
  logical_state: string;
  current_generation_id: string | null;
  observed_etag: string | null;
  observed_size: string | null;
  principal_id: string;
  expected_size: string | null;
  expected_sha256: string | null;
  media_hint: string | null;
  intent_expired: boolean;
}

async function completeUploadCas(
  tx: DatabaseTransaction,
  input: CompleteUploadCasInput,
  options: AttachmentsPortOptions = {},
): Promise<CompleteUploadCasResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('complete_cas_before');
  const metadata = canonicalizeObservedMetadata(input.observedMetadata);
  assertObservedMetadataAllowlist(metadata);

  const rows = await sql<CompleteCasRow>`
    select bg.generation_state, bg.blob_id, bg.observed_etag, bg.observed_size::text,
           br.logical_state, br.current_generation_id,
           ui.principal_id, ui.expected_size::text, ui.expected_sha256, ui.media_hint,
           (ui.expires_at <= now()) as intent_expired
    from blob_generations bg
    join blob_records br on br.blob_id = bg.blob_id
    join upload_intents ui on ui.generation_id = bg.generation_id
    where bg.generation_id = ${input.generationId}
    for update of bg, br
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  if (row.blob_id !== input.blobId) return { outcome: 'identity_mismatch' };
  if (row.principal_id !== input.actorPrincipalId) return { outcome: 'principal_mismatch' };

  // A completed blob converges idempotently (retried complete after the
  // worker already stored) without enqueuing a second verification job.
  if ((row.logical_state === 'stored_private' || row.logical_state === 'attached_private')
    && row.current_generation_id === input.generationId) {
    return { outcome: 'already_verified' };
  }

  // Expiry first: the frozen late-upload policy dominates the declared facts.
  if (row.intent_expired) {
    if (row.generation_state === 'allocated' || row.generation_state === 'observed') {
      await sql`
        update blob_generations set generation_state = 'orphaned', retire_reason = 'expired', orphaned_at = now()
        where generation_id = ${input.generationId} and generation_state = ${row.generation_state}
      `.execute(tx);
      if (row.logical_state === 'issued') {
        await sql`
          update blob_records set logical_state = 'expired', updated_at = now()
          where blob_id = ${input.blobId} and logical_state = 'issued'
        `.execute(tx);
      }
    }
    return { outcome: 'late_rejected', reason: 'expired' };
  }

  if (row.expected_size !== null && Number(row.expected_size) !== input.declaredSize) {
    return { outcome: 'declared_facts_mismatch', code: 'size' };
  }
  if (row.expected_sha256 !== null && row.expected_sha256 !== input.declaredSha256) {
    return { outcome: 'declared_facts_mismatch', code: 'digest' };
  }
  if (row.media_hint !== null && row.media_hint !== input.declaredMediaType) {
    return { outcome: 'declared_facts_mismatch', code: 'media' };
  }

  const metadataKeys = Object.keys(metadata);
  const metadataValues = metadataKeys.map((key) => metadata[key]!);
  const bindingMatches = row.observed_etag === input.observedEtag
    && (row.observed_size === null ? false : Number(row.observed_size) === input.observedSize);

  switch (row.generation_state) {
    case 'allocated': {
      if (row.current_generation_id === null) {
        await sql`
          update blob_generations
          set generation_state = 'active', observed_etag = ${input.observedEtag},
              observed_size = ${input.observedSize}, observed_content_type = ${input.observedContentType},
              observed_metadata_keys = ${metadataKeys}, observed_metadata_values = ${metadataValues}
          where generation_id = ${input.generationId}
        `.execute(tx);
        await sql`
          update blob_records set current_generation_id = ${input.generationId}, logical_state = 'uploaded', updated_at = now()
          where blob_id = ${input.blobId}
        `.execute(tx);
        return { outcome: 'uploaded' };
      }
      if (row.current_generation_id === input.generationId) return { outcome: 'idempotent' };
      // P4A-P07 replacement path: the blob already carries a DIFFERENT
      // current generation (the first generation activated at its own
      // complete). The complete attestation binds the observed facts and the
      // generation reaches `observed` — the pointer is NOT moved here. The
      // use case then runs the frozen `activateReplacement` CAS in the SAME
      // transaction (old -> retired, new -> active, pointer move, verified
      // facts cleared), so the pointer never moves before the exact-key
      // complete attestation.
      await sql`
        update blob_generations
        set generation_state = 'observed', observed_etag = ${input.observedEtag},
            observed_size = ${input.observedSize}, observed_content_type = ${input.observedContentType},
            observed_metadata_keys = ${metadataKeys}, observed_metadata_values = ${metadataValues}
        where generation_id = ${input.generationId}
      `.execute(tx);
      return { outcome: 'uploaded' };
    }
    case 'observed':
      return bindingMatches ? { outcome: 'idempotent' } : { outcome: 'identity_mismatch' };
    case 'active':
      if (row.current_generation_id === input.generationId) {
        return bindingMatches ? { outcome: 'idempotent' } : { outcome: 'identity_mismatch' };
      }
      return { outcome: 'late_rejected', reason: 'not_current' };
    case 'retired':
      return { outcome: 'late_rejected', reason: 'replaced' };
    case 'orphaned':
      return { outcome: 'late_rejected', reason: 'orphaned' };
    case 'deletion_pending':
      return { outcome: 'late_rejected', reason: 'not_completable' };
    case 'deleted':
      return { outcome: 'late_rejected', reason: 'deleted' };
    case 'contract_corrupt':
      return { outcome: 'late_rejected', reason: 'contract_corrupt' };
    case 'quarantined':
      return { outcome: 'late_rejected', reason: 'quarantined' };
    default:
      return { outcome: 'late_rejected', reason: 'not_completable' };
  }
}

// ---------------------------------------------------------------------------
// P4A-I09 verification lease + CAS (uploaded -> verifying -> stored_private)
// ---------------------------------------------------------------------------

interface VerificationFactsRow {
  bucket: string;
  key: string;
  observed_etag: string | null;
  observed_size: string | null;
  generation_state: string;
  expected_size: string | null;
  expected_sha256: string | null;
  media_hint: string | null;
}

async function readVerificationFacts(
  tx: DatabaseTransaction,
  generationId: string,
): Promise<VerificationFactsRow | undefined> {
  const rows = await sql<VerificationFactsRow>`
    select bg.bucket, bg.key, bg.observed_etag, bg.observed_size::text, bg.generation_state,
           ui.expected_size::text, ui.expected_sha256, ui.media_hint
    from blob_generations bg
    join upload_intents ui on ui.generation_id = bg.generation_id
    where bg.generation_id = ${generationId}
  `.execute(tx);
  return rows.rows[0];
}

interface ClaimVerificationRow {
  logical_state: string;
  current_generation_id: string | null;
  verification_lease_expires_at: Date | null;
}

async function claimVerification(
  tx: DatabaseTransaction,
  input: ClaimVerificationInput,
  options: AttachmentsPortOptions = {},
): Promise<ClaimVerificationResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('claim_verification_before');

  // The outbox fence: this attempt must still own the outbox row. Losing the
  // lease aborts immediately (plan §6 I09).
  const fence = await sql<{ owned: boolean }>`
    select (state = 'leased' and lease_generation = ${input.attempt.leaseGeneration}
      and locked_until > current_timestamp) as owned
    from outbox_events where outbox_id = ${input.attempt.outboxId}
  `.execute(tx);
  if (fence.rows.length === 0 || fence.rows[0]!.owned !== true) return { outcome: 'lease_lost' };

  const rows = await sql<ClaimVerificationRow>`
    select logical_state, current_generation_id, verification_lease_expires_at
    from blob_records where blob_id = ${input.blobId} for update
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  if (row.logical_state === 'stored_private' || row.logical_state === 'attached_private') {
    return { outcome: 'already_stored' };
  }
  if (row.logical_state === 'expired') return { outcome: 'already_expired' };
  if (row.current_generation_id !== input.generationId) {
    // FIX-L-045: the current pointer moved away. Distinguish a genuine
    // outbox/lease problem (retry) from an AUTHORITATIVE replacement: only a
    // terminal state of the event's own generation — `retired` (the
    // replacement CAS retires the old generation atomically with the pointer
    // move) or `deleted` (cleanup already converged) — proves the event can
    // never verify again, so it completes terminal WITHOUT touching the new
    // generation. Everything else (observed candidate not yet activated,
    // orphaned, deletion_pending, corrupt, …) stays lease_lost (retry) so a
    // real verification is never dropped. The classification runs in the
    // SAME transaction that holds the blob row FOR UPDATE, so a concurrent
    // replacement CAS is serialized against it.
    const oldGen = await sql<{ generation_state: string; blob_id: string }>`
      select generation_state, blob_id from blob_generations
      where generation_id = ${input.generationId}
    `.execute(tx);
    if (oldGen.rows.length > 0
      && oldGen.rows[0]!.blob_id === input.blobId
      && (oldGen.rows[0]!.generation_state === 'retired' || oldGen.rows[0]!.generation_state === 'deleted')) {
      return { outcome: 'already_replaced' };
    }
    return { outcome: 'lease_lost' };
  }

  const updated = await sql<{ verification_lease_expires_at: Date }>`
    update blob_records
    set logical_state = 'verifying',
        verification_lease_owner = ${input.attempt.outboxId},
        verification_lease_generation = ${input.attempt.leaseGeneration},
        verification_lease_expires_at = current_timestamp + make_interval(secs => ${input.leaseTtlSeconds}),
        updated_at = now()
    where blob_id = ${input.blobId}
      and current_generation_id = ${input.generationId}
      and (
        logical_state = 'uploaded'
        or (
          logical_state = 'verifying'
          and (verification_lease_generation = ${input.attempt.leaseGeneration}
               or verification_lease_expires_at < current_timestamp)
        )
      )
    returning verification_lease_expires_at
  `.execute(tx);
  if (updated.rows.length === 0) return { outcome: 'lease_lost' };

  const factsRow = await readVerificationFacts(tx, input.generationId);
  if (!factsRow) return { outcome: 'not_found' };
  return {
    outcome: 'claimed',
    facts: {
      bucket: factsRow.bucket,
      key: factsRow.key,
      observedEtag: factsRow.observed_etag,
      observedSize: factsRow.observed_size === null ? null : Number(factsRow.observed_size),
      expectedSize: factsRow.expected_size === null ? null : Number(factsRow.expected_size),
      expectedSha256: factsRow.expected_sha256,
      mediaHint: factsRow.media_hint,
      generationState: factsRow.generation_state as GenerationState,
      blobLogicalState: 'verifying',
    },
    leaseOwner: input.attempt.outboxId,
    leaseGeneration: input.attempt.leaseGeneration,
    leaseExpiresAt: updated.rows[0]!.verification_lease_expires_at,
  };
}

async function completeVerification(
  tx: DatabaseTransaction,
  input: CompleteVerificationInput,
  options: AttachmentsPortOptions = {},
): Promise<CompleteVerificationResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('complete_verification_before');
  const updated = await sql<{ logical_state: string }>`
    update blob_records
    set logical_state = 'stored_private',
        verified_size = ${input.verifiedSize},
        verified_sha256 = ${input.verifiedSha256},
        media_type = ${input.mediaType},
        verification_policy_version = ${input.policyVersion},
        verification_lease_owner = null,
        verification_lease_generation = 0,
        verification_lease_expires_at = null,
        updated_at = now()
    where blob_id = ${input.blobId}
      and logical_state = 'verifying'
      and current_generation_id = ${input.generationId}
      and verification_lease_generation = ${input.attempt.leaseGeneration}
    returning logical_state
  `.execute(tx);
  if (updated.rows.length > 0) return { outcome: 'stored_private' };
  const exists = await sql`select 1 from blob_records where blob_id = ${input.blobId}`.execute(tx);
  if (exists.rows.length === 0) return { outcome: 'not_found' };
  // The lease fence is gone (expired/stolen or already stored by a newer
  // owner); the late result must never commit.
  return { outcome: 'lease_lost' };
}

async function quarantineVerification(
  tx: DatabaseTransaction,
  input: QuarantineVerificationInput,
  options: AttachmentsPortOptions = {},
): Promise<QuarantineVerificationResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('quarantine_verification_before');
  // Fence the blob expiry with the lease token; only then quarantine the
  // generation in the SAME transaction.
  const expired = await sql<{ logical_state: string }>`
    update blob_records
    set logical_state = 'expired',
        verification_lease_owner = null,
        verification_lease_generation = 0,
        verification_lease_expires_at = null,
        updated_at = now()
    where blob_id = ${input.blobId}
      and logical_state = 'verifying'
      and current_generation_id = ${input.generationId}
      and verification_lease_generation = ${input.attempt.leaseGeneration}
    returning logical_state
  `.execute(tx);
  if (expired.rows.length === 0) {
    const exists = await sql`select 1 from blob_records where blob_id = ${input.blobId}`.execute(tx);
    if (exists.rows.length === 0) return { outcome: 'not_found' };
    return { outcome: 'lease_lost' };
  }
  const quarantine = await quarantineGeneration(tx, {
    generationId: input.generationId,
    reason: input.reason,
  });
  if (quarantine.outcome === 'quarantined' || quarantine.outcome === 'already_quarantined') {
    return { outcome: 'quarantined' };
  }
  // The generation was not claimable (already deleted or otherwise terminal);
  // the blob expiry still stands and the outbox row completes without
  // contradiction (the generation's fate is owned by cleanup).
  return { outcome: 'quarantined' };
}

// ---------------------------------------------------------------------------
// P4A-P07 findReplacementIntentByBinding: recover the committed replacement
// intent/generation for a (blob_id, idempotency_key) binding — the same
// idempotency surface the production unique constraint
// `upload_intents (blob_id, idempotency_key)` enforces under concurrency.
// ---------------------------------------------------------------------------

async function findReplacementIntentByBinding(
  tx: DatabaseTransaction,
  input: FindReplacementIntentByBindingInput,
  options: AttachmentsPortOptions = {},
): Promise<FindReplacementIntentByBindingResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('find_replacement_intent_before');
  const rows = await sql<FindIntentRow>`
    select ui.intent_id, ui.blob_id, ui.generation_id, ui.principal_id, ui.collection_id,
           ui.subject_identity, ui.expected_size::text, ui.expected_sha256, ui.media_hint,
           ui.policy_revision, ui.idempotency_key, ui.expires_at, bg.key
    from upload_intents ui
    join blob_generations bg on bg.generation_id = ui.generation_id
    where ui.blob_id = ${input.blobId}
      and ui.idempotency_key = ${input.idempotencyKey}
  `.execute(tx);
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    intent: {
      intentId: row.intent_id,
      generationId: row.generation_id,
      blobId: row.blob_id,
      key: row.key,
      principalId: row.principal_id,
      collectionId: row.collection_id,
      subjectIdentity: row.subject_identity,
      expectedSize: row.expected_size === null ? null : Number(row.expected_size),
      expectedSha256: row.expected_sha256,
      mediaHint: row.media_hint,
      policyRevision: row.policy_revision,
      idempotencyKey: row.idempotency_key,
      expiresAt: row.expires_at,
    },
  };
}

// ---------------------------------------------------------------------------
// P4A-P07 findBlobForRetire: current blob/generation + committed Attachment
// metadata identity/state for the retire command. The physical key, key
// fingerprint, digest, provider metadata and lease facts are never selected;
// the attachments join surfaces the terminal retired/deleted facts for
// concealment and the committed attachment id the canonical retirement needs.
// ---------------------------------------------------------------------------

interface RetireBlobRow {
  owner_subject_id: string;
  logical_state: string;
  current_generation_id: string | null;
  current_generation_state: string | null;
  collection_id: string | null;
  attachment_id: string | null;
  attachment_logical_state: 'attached_private' | 'retired' | 'deleted' | null;
}

async function findBlobForRetire(
  tx: DatabaseTransaction,
  input: FindBlobForRetireInput,
  options: AttachmentsPortOptions = {},
): Promise<FindBlobForRetireResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('retire_read_before');
  const rows = await sql<RetireBlobRow>`
    select br.owner_subject_id, br.logical_state, br.current_generation_id,
           bg.generation_state as current_generation_state,
           ui.collection_id,
           a.attachment_id, a.logical_state as attachment_logical_state
    from blob_records br
    left join blob_generations bg on bg.generation_id = br.current_generation_id
    left join upload_intents ui on ui.blob_id = br.blob_id
      and (br.current_generation_id is null or ui.generation_id = br.current_generation_id)
    left join attachments a on a.blob_id = br.blob_id
    where br.blob_id = ${input.blobId}
  `.execute(tx);
  await barrier.arriveAndWait('retire_read_after');
  if (rows.rows.length === 0) return { outcome: 'not_found' };
  const row = rows.rows[0]!;
  return {
    outcome: 'found',
    facts: {
      blobId: input.blobId,
      ownerSubjectId: row.owner_subject_id,
      logicalState: row.logical_state as BlobLogicalState,
      currentGenerationId: row.current_generation_id,
      currentGenerationState: row.current_generation_state as GenerationState | null,
      collectionId: row.collection_id,
      attachment: row.attachment_id === null || row.attachment_logical_state === null
        ? null
        : { attachmentId: row.attachment_id, logicalState: row.attachment_logical_state },
    },
  };
}

// ---------------------------------------------------------------------------
// P4A-P07 findRetireByCommandId: the committed retire receipt keyed by the
// persisted Known-Command-Id (identity facts only).
// ---------------------------------------------------------------------------

async function findRetireByCommandId(
  tx: DatabaseTransaction,
  input: FindRetireByCommandIdInput,
  options: AttachmentsPortOptions = {},
): Promise<FindRetireByCommandIdResult> {
  const barrier = barrierOf(options);
  await barrier.arriveAndWait('retire_command_read_before');
  const row = await findLatestAttachmentOperationByCommandId(
    tx, 'attachment.retired', input.commandId,
  );
  if (!row) return { outcome: 'not_found' };
  return {
    outcome: 'found',
    facts: {
      operationId: row.operation_id,
      commitOrdinal: BigInt(row.commit_ordinal),
      collectionId: row.collection_id,
      attachmentId: row.attachment_id,
      blobId: row.blob_id,
    },
  };
}

export function createPostgresAttachmentsPorts(): AttachmentsLedgerPort<DatabaseTransaction> {
  return {
    findIntentByBinding,
    allocate: allocateGeneration,
    complete: completeGeneration,
    activateReplacement,
    claimCleanup,
    completeCleanup,
    readCleanupState,
    finalizeLock,
    finalizeHandoff,
    quarantineGeneration,
    findCompleteTarget,
    completeUploadCas,
    claimVerification,
    completeVerification,
    quarantineVerification,
    findBlobForDelivery,
    findBlobForStatus,
    findBlobForFinalize,
    findFinalizeByCommandId,
    findReplacementIntentByBinding,
    findBlobForRetire,
    findRetireByCommandId,
  };
}
