/**
 * P4A-P07 owner-private replacement intent use case (`issueAttachmentReplacement`).
 *
 * Issues a NEW immutable generation intent for an EXISTING owner-private blob
 * (plan §6 P4A-P07): the new generation always allocates a NEW physical key on
 * the SAME blob (same-key overwrite is impossible — the permanent
 * generation_keys unique constraints tombstone every issued key), and the old
 * generation only ever enters `retired`; its external deletion converges
 * asynchronously through the cleanup coordinator after the retention window.
 *
 * Contract (frozen OpenAPI `issueAttachmentReplacement`, plan §2.4 invariants
 * 1/2/6):
 *  - input is ONLY `{ actor, blobId, Known-Command-Id, declared facts }`; the
 *    physical key/generation are never inputs;
 *  - the blob must be owner-matched, current-member-authorized, and in
 *    `stored_private` with an ACTIVE current generation (the frozen `replace`
 *    allowed action). Every foreign / absent / revoked / terminal identity is
 *    concealed as `not_found` (identical concealment); every admissible-state
 *    violation is the stable 409 `attachment_state_conflict`;
 *  - idempotency: the binding is (blobId, Known-Command-Id), enforced by the
 *    production unique `upload_intents (blob_id, idempotency_key)`. A replay
 *    with the same facts recovers the SAME committed intent/generation and
 *    re-signs a fresh grant (identity never changes); different facts are the
 *    permanent `idempotency_conflict`;
 *  - ledger-before-grant: the generation ledger rows commit BEFORE the
 *    create-only grant is signed; a signing failure never deletes the
 *    generation or reuses the key;
 *  - every unknown outcome (commit-success-response-lost, before-commit
 *    failure, CSPRNG collision, idempotency race) re-reads the DATABASE on a
 *    bounded second attempt instead of guessing from the caught exception;
 *  - the CAS activation of the completed replacement generation (current
 *    pointer switch + old generation retirement) is composed into the
 *    `completeUpload` use case in the SAME canonical transaction (see
 *    complete-upload.ts); this use case only issues the intent.
 *
 * Logging records only fixed result classes — never the grant URL, physical
 * key, fingerprint, credential, or digest.
 */
import { createHash } from 'node:crypto';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
  type PolicyDecision,
} from '../access-policy/index.js';
import { ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES, type AttachmentsFeatureConfig } from './attachments-config.js';
import type { AttachmentsLedgerPort, StoredIntentFacts } from './attachments-repository-port.js';
import {
  UploadIntentExpiredError,
  UploadIntentIdentityError,
  UploadIntentInputError,
  UploadIntentSigningError,
  type IntentUnitOfWork,
  type UploadGrant,
  type UploadGrantIssuerPort,
} from './issue-upload-intent.js';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface IssueReplacementIntentInput {
  /** Trusted actor; the replacement is bound to the actor's subject + principal. */
  readonly actor: ActorPrincipal;
  /** Opaque logical blob identity (the key/generation are NEVER inputs). */
  readonly blobId: string;
  /** Known-Command-Id: the idempotency binding of the replacement intent. */
  readonly idempotencyKey: string;
  /** Declared single-PUT byte count of the NEW generation (size-bounded grant). */
  readonly declaredSize: number;
  /** Declared SHA-256 (lowercase 64-hex) or null when unknown. */
  readonly declaredSha256?: string | null;
  /** Declared media hint; must be inside the configured allowed-media set. */
  readonly mediaHint?: string | null;
  /** Optional expected policy revision for the TOCTOU fence. */
  readonly expectedPolicyRevision?: string | null;
}

export interface ReplacementReceipt {
  readonly intentId: string;
  readonly generationId: string;
}

export interface IssueReplacementIntentResult {
  /** Opaque, idempotently recoverable receipt. */
  readonly receipt: ReplacementReceipt;
  /** The SAME logical blob the replacement belongs to. */
  readonly blobId: string;
  /** True when an existing committed replacement intent was recovered. */
  readonly recovered: boolean;
  /** Memory-only grant; never persisted or logged. */
  readonly grant: UploadGrant;
}

export type ProductReplacementResult =
  | { outcome: 'issued'; kind: 'issued'; result: IssueReplacementIntentResult }
  | { outcome: 'recovered'; kind: 'recovered'; result: IssueReplacementIntentResult }
  /** Foreign/absent/revoked/terminal identity — identical concealment. */
  | { outcome: 'not_found' }
  /** Stable 409 attachment_state_conflict source (never leaked verbatim). */
  | { outcome: 'state_conflict'; reason: string }
  /** Same Known-Command-Id reused with different replacement facts. */
  | { outcome: 'idempotency_conflict' }
  /** Retryable database outcome (deadlock/serialization/lock_timeout/…). */
  | { outcome: 'retryable'; reason: string }
  /** Integrity state that must never be auto-recreated (500). */
  | { outcome: 'inconsistent'; reason: string };

// ---------------------------------------------------------------------------
// Validation (pure, synchronous, fast-fail before any database work)
// ---------------------------------------------------------------------------

export interface ValidatedReplacementIntentInput {
  readonly actor: ActorPrincipal;
  readonly blobId: string;
  readonly idempotencyKey: string;
  readonly declaredSize: number;
  readonly declaredSha256: string | null;
  readonly mediaHint: string | null;
  readonly expectedPolicyRevision: string | null;
}

const MAX_BLOB_ID_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_POLICY_REVISION_LENGTH = 512;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Pure validation. An invalid blobId is existence-hidden exactly like a
 * missing blob (identical concealment -> the route emits the stable 404); the
 * declared-facts and idempotency-key rules reuse the frozen issue vocabulary.
 */
export function validateReplacementIntentInput(
  input: IssueReplacementIntentInput,
  config: AttachmentsFeatureConfig,
): ValidatedReplacementIntentInput | null {
  const blobId = input.blobId.trim();
  if (blobId.length === 0 || blobId.length > MAX_BLOB_ID_LENGTH) return null;
  // Printable ASCII only: opaque identity, no whitespace/control characters.
  if (/[^\x21-\x7e]/u.test(blobId)) return null;

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) throw new UploadIntentInputError('idempotency_key_required');
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new UploadIntentInputError('idempotency_key_too_long');

  if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0) {
    throw new UploadIntentInputError('size_required', 'declaredSize must be a non-negative safe integer');
  }
  if (input.declaredSize > config.singlePutMaxBytes) {
    throw new UploadIntentInputError('size_out_of_range', `declaredSize must be <= singlePutMaxBytes (${config.singlePutMaxBytes})`);
  }
  if (input.declaredSize > ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES) {
    throw new UploadIntentInputError('size_out_of_range', `declaredSize must be <= the compile ceiling (${ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES})`);
  }

  let declaredSha256: string | null = null;
  if (input.declaredSha256 != null && input.declaredSha256.trim() !== '') {
    const normalized = input.declaredSha256.trim().toLowerCase();
    if (!DIGEST_PATTERN.test(normalized)) throw new UploadIntentInputError('digest_invalid');
    declaredSha256 = normalized;
  }

  let mediaHint: string | null = null;
  if (input.mediaHint != null && input.mediaHint.trim() !== '') {
    const normalized = input.mediaHint.trim().toLowerCase();
    if (!config.allowedMedia.includes(normalized)) throw new UploadIntentInputError('media_not_allowed');
    mediaHint = normalized;
  }

  let expectedPolicyRevision: string | null = null;
  if (input.expectedPolicyRevision != null && input.expectedPolicyRevision.trim() !== '') {
    const normalized = input.expectedPolicyRevision.trim();
    if (normalized.length > MAX_POLICY_REVISION_LENGTH) throw new UploadIntentInputError('policy_revision_invalid');
    expectedPolicyRevision = normalized;
  }

  return {
    actor: input.actor,
    blobId,
    idempotencyKey,
    declaredSize: input.declaredSize,
    declaredSha256,
    mediaHint,
    expectedPolicyRevision,
  };
}

// ---------------------------------------------------------------------------
// Use case deps
// ---------------------------------------------------------------------------

export interface IssueReplacementIntentDeps<Transaction> {
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** Binds the access-policy facts port to the caller-provided transaction. */
  readonly accessPolicyFor: (transaction: Transaction) => AccessPolicyFactsPort;
  readonly blobStore: UploadGrantIssuerPort;
  readonly uow: IntentUnitOfWork<Transaction>;
  readonly crypto: IssueReplacementCrypto;
  readonly config: AttachmentsFeatureConfig;
  /** Injectable clock (intent expiry); defaults to the wall clock. */
  readonly now?: () => Date;
  readonly log?: ReplacementIntentLogger;
}

/** CSPRNG seam (same contract as the upload-intent crypto). */
export interface IssueReplacementCrypto {
  /** Fresh cryptographically-random hex string of `bytes` bytes. */
  randomHex(bytes: number): string;
}

// ---------------------------------------------------------------------------
// Fixed log result classes (never URLs/keys/credentials/digests)
// ---------------------------------------------------------------------------

export type ReplacementIntentLogClass =
  | 'replacement_issued'
  | 'replacement_recovered'
  | 'replacement_denied'
  | 'replacement_not_found'
  | 'replacement_state_conflict'
  | 'replacement_expired'
  | 'replacement_grant_signed'
  | 'replacement_grant_signing_failed'
  | 'replacement_retry';

export interface ReplacementIntentLogEntry {
  readonly class: ReplacementIntentLogClass;
  readonly blobId?: string;
  readonly generationId?: string;
  readonly reason?: string;
}

export type ReplacementIntentLogger = (entry: ReplacementIntentLogEntry) => void;

// ---------------------------------------------------------------------------
// Authorization: current membership gate layered on the immutable owner
// binding (same vocabulary as the status read and the finalize policy).
// Denial is concealed as the identical `not_found` (no existence side
// channel); the issue-style 403 belongs to the collection-scoped issue route.
// ---------------------------------------------------------------------------

const REPLACEMENT_CAPABILITY = 'read_editor' as const;

// ---------------------------------------------------------------------------
// In-transaction core: authorize -> resolve blob -> idempotency lookup ->
// allocate a NEW generation on the SAME blob (new key) or recover. There is
// NO network and NO signing inside the transaction; only identity is
// generated and persisted.
// ---------------------------------------------------------------------------

type InTransactionOutcome =
  | { outcome: 'issued'; intentId: string; generationId: string; key: string }
  | { outcome: 'recovered'; intent: StoredIntentFacts }
  | { outcome: 'not_found' }
  | { outcome: 'state_conflict'; reason: string };

function declaredFactsEqual(intent: StoredIntentFacts, validated: ValidatedReplacementIntentInput): boolean {
  return intent.expectedSize === validated.declaredSize
    && intent.expectedSha256 === validated.declaredSha256
    && intent.mediaHint === validated.mediaHint;
}

async function issueReplacementInTransaction<Transaction>(
  tx: Transaction,
  deps: IssueReplacementIntentDeps<Transaction>,
  validated: ValidatedReplacementIntentInput,
  now: Date,
): Promise<InTransactionOutcome> {
  // 1. Resolve the current blob/generation/attachment facts (one indexed
  //    read; the physical key is never selected).
  const factsResult = await deps.ledger.findBlobForStatus(tx, { blobId: validated.blobId });
  if (factsResult.outcome === 'not_found') {
    deps.log?.({ class: 'replacement_not_found', blobId: validated.blobId });
    return { outcome: 'not_found' };
  }
  const facts = factsResult.facts;
  if (facts.ownerSubjectId !== validated.actor.subjectId) {
    deps.log?.({ class: 'replacement_not_found', blobId: validated.blobId, reason: 'owner' });
    return { outcome: 'not_found' };
  }
  if (facts.attachmentLogicalState === 'retired' || facts.attachmentLogicalState === 'deleted') {
    deps.log?.({ class: 'replacement_not_found', blobId: validated.blobId, reason: 'terminal' });
    return { outcome: 'not_found' };
  }
  if (facts.collectionId === null) {
    deps.log?.({ class: 'replacement_not_found', blobId: validated.blobId, reason: 'collection' });
    return { outcome: 'not_found' };
  }
  const authz: PolicyDecision = await authorizeCapability(deps.accessPolicyFor(tx), {
    collectionId: facts.collectionId,
    actor: validated.actor,
    capability: REPLACEMENT_CAPABILITY,
    expectedPolicyRevision: validated.expectedPolicyRevision ?? undefined,
  });
  if (authz.outcome !== 'allow') {
    deps.log?.({ class: 'replacement_denied', blobId: validated.blobId, reason: authz.reasonCategory });
    return { outcome: 'not_found' };
  }

  // 2. Idempotency receipt: (blobId, Known-Command-Id). A committed intent on
  //    the SAME blob with the SAME facts is recovered BEFORE the state gate —
  //    a replay is a committed command, so it must converge to the SAME
  //    generation even while the blob is demoted to `uploaded` (between the
  //    replacement complete and the re-verification of the new current
  //    generation) or re-verifying; different facts are the permanent
  //    idempotency conflict (the production unique constraint
  //    `(blob_id, idempotency_key)` is the durable backstop).
  const binding = { blobId: validated.blobId, idempotencyKey: validated.idempotencyKey };
  const found = await deps.ledger.findReplacementIntentByBinding(tx, binding);
  if (found.outcome === 'found') {
    if (!declaredFactsEqual(found.intent, validated)) {
      deps.log?.({ class: 'replacement_state_conflict', blobId: validated.blobId, reason: 'request_facts_mismatch' });
      throw new UploadIntentIdentityError('request_facts_mismatch');
    }
    if (found.intent.expiresAt.getTime() <= now.getTime()) {
      deps.log?.({ class: 'replacement_expired', blobId: validated.blobId, generationId: found.intent.generationId });
      throw new UploadIntentExpiredError();
    }
    deps.log?.({ class: 'replacement_recovered', blobId: validated.blobId, generationId: found.intent.generationId });
    return { outcome: 'recovered', intent: found.intent };
  }

  // 3. The frozen `replace` action gate: stored_private + ACTIVE current
  //    generation. Every other admissible state is the stable 409.
  if (facts.logicalState !== 'stored_private') {
    deps.log?.({ class: 'replacement_state_conflict', blobId: validated.blobId, reason: `logical_state_${facts.logicalState}` });
    return { outcome: 'state_conflict', reason: `logical_state_${facts.logicalState}` };
  }
  if (facts.currentGenerationId === null || facts.currentGenerationState !== 'active') {
    deps.log?.({ class: 'replacement_state_conflict', blobId: validated.blobId, reason: 'generation_not_active' });
    return { outcome: 'state_conflict', reason: 'generation_not_active' };
  }

  // 4. Allocate a fresh generation on the SAME blob with a NEW physical key
  //    (the old key is never re-signed; the permanent key-uniqueness
  //    tombstones reject any same-key reissue).
  const intentId = deps.crypto.randomHex(16);
  const generationId = deps.crypto.randomHex(16);
  const key = `${deps.config.r2.livePrefix}${deps.crypto.randomHex(16)}`;
  const keyFingerprint = createHash('sha256').update(key, 'utf8').digest('hex');
  const expiresAt = new Date(now.getTime() + deps.config.retention.intentRetentionHours * 3_600_000);

  const allocated = await deps.ledger.allocate(tx, {
    blobId: validated.blobId,
    intentId,
    generationId,
    principalId: validated.actor.principalId,
    collectionId: facts.collectionId,
    subjectIdentity: validated.actor.subjectId,
    bucket: deps.config.r2.bucket,
    key,
    keyFingerprint,
    expectedSize: validated.declaredSize,
    expectedSha256: validated.declaredSha256,
    mediaHint: validated.mediaHint,
    policyRevision: authz.policyRevision ?? 'unknown',
    idempotencyKey: validated.idempotencyKey,
    expiresAt,
  });

  if (allocated.outcome === 'already_issued') {
    // A deterministic-crypto replay (or a defensive race) hit the same
    // identity; re-read the committed facts and recover instead of guessing.
    const reRead = await deps.ledger.findReplacementIntentByBinding(tx, binding);
    if (reRead.outcome !== 'found') {
      throw new UploadIntentIdentityError('intent_generation_mismatch');
    }
    if (!declaredFactsEqual(reRead.intent, validated)) {
      throw new UploadIntentIdentityError('request_facts_mismatch');
    }
    deps.log?.({ class: 'replacement_recovered', blobId: validated.blobId, generationId: reRead.intent.generationId });
    return { outcome: 'recovered', intent: reRead.intent };
  }

  deps.log?.({ class: 'replacement_issued', blobId: validated.blobId, generationId });
  return { outcome: 'issued', intentId, generationId, key };
}

// ---------------------------------------------------------------------------
// Grant signing happens ONLY after the transaction committed.
// ---------------------------------------------------------------------------

async function signReplacementGrant<Transaction>(
  deps: IssueReplacementIntentDeps<Transaction>,
  generationId: string,
  key: string,
  declaredSize: number,
  mediaHint: string | null,
): Promise<UploadGrant> {
  try {
    const grant = await deps.blobStore.issueCreateOnlyGrant(
      { generationId, key },
      {
        ttlSeconds: deps.config.grantTtlSeconds,
        contentType: mediaHint ?? 'application/octet-stream',
        contentLength: declaredSize,
      },
    );
    deps.log?.({ class: 'replacement_grant_signed', generationId });
    return grant;
  } catch (error) {
    deps.log?.({ class: 'replacement_grant_signing_failed', generationId });
    throw new UploadIntentSigningError(error);
  }
}

// ---------------------------------------------------------------------------
// Public entry: bounded two-attempt loop (mirrors issueUploadIntent). Attempt
// 0 may fail for ANY reason (before-commit crash, commit-success-response-
// lost, CSPRNG collision, idempotency race); attempt 1 re-reads the DATABASE
// and either recovers the committed identity or allocates a fresh one —
// recovery is never inferred from the caught exception.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

export async function issueReplacementIntent<Transaction>(
  deps: IssueReplacementIntentDeps<Transaction>,
  input: IssueReplacementIntentInput,
): Promise<ProductReplacementResult> {
  let validated: ValidatedReplacementIntentInput;
  try {
    const candidate = validateReplacementIntentInput(input, deps.config);
    if (candidate === null) return { outcome: 'not_found' };
    validated = candidate;
  } catch (error) {
    if (error instanceof UploadIntentInputError) {
      deps.log?.({ class: 'replacement_state_conflict', reason: error.code });
    }
    throw error;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) deps.log?.({ class: 'replacement_retry' });
    try {
      const now = deps.now?.() ?? new Date();
      const inTransaction = await deps.uow.execute(({ transaction: tx }) =>
        issueReplacementInTransaction(tx, deps, validated, now));
      if (inTransaction.outcome === 'not_found') return { outcome: 'not_found' };
      if (inTransaction.outcome === 'state_conflict') {
        return { outcome: 'state_conflict', reason: inTransaction.reason };
      }
      if (inTransaction.outcome === 'recovered') {
        const grant = await signReplacementGrant(deps, inTransaction.intent.generationId, inTransaction.intent.key,
          validated.declaredSize, validated.mediaHint);
        return {
          outcome: 'recovered',
          kind: 'recovered',
          result: {
            receipt: { intentId: inTransaction.intent.intentId, generationId: inTransaction.intent.generationId },
            blobId: validated.blobId,
            recovered: true,
            grant,
          },
        };
      }
      const grant = await signReplacementGrant(deps, inTransaction.generationId, inTransaction.key,
        validated.declaredSize, validated.mediaHint);
      return {
        outcome: 'issued',
        kind: 'issued',
        result: {
          receipt: { intentId: inTransaction.intentId, generationId: inTransaction.generationId },
          blobId: validated.blobId,
          recovered: false,
          grant,
        },
      };
    } catch (error) {
      lastError = error;
      if (error instanceof UploadIntentSigningError
        || error instanceof UploadIntentInputError
        || error instanceof UploadIntentExpiredError
        || error instanceof UploadIntentIdentityError) {
        // Deterministic outcomes (signing after commit, validation, expiry,
        // committed-facts mismatch) surface immediately; they cannot change
        // by re-reading the database.
        throw error;
      }
      if (attempt === MAX_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('replacement_issue_failed');
}
