/**
 * P4A-I08 internal application use case: issue durable generation upload
 * intents (`phase4a: issue durable generation upload intents`).
 *
 * The use case is deliberately network-free INSIDE the transaction: it only
 * generates and persists identity (intent/blob/generation/key binding) and
 * authorizes against the transaction-bound access-policy facts port. Only
 * AFTER the transaction commits does it issue the short-lived create-only
 * grant through the narrow `UploadGrantIssuerPort` (the I06 `BlobStorePort`
 * satisfies it structurally).
 *
 * Identity and recovery semantics (plan §6 P4A-I08, ADR-0020):
 *  - The stable idempotency binding is `(subjectIdentity, collectionId,
 *    idempotencyKey)`. The logical `blobId` is derived deterministically from
 *    that binding (SHA-256), so the production unique constraint
 *    `upload_intents (blob_id, idempotency_key)` becomes a hard
 *    one-intent-per-binding boundary even under concurrent issue — the loser
 *    of a same-binding race is rejected by the database with
 *    `idempotency_conflict` and RECOVERS the winner's identity, never a
 *    duplicate.
 *  - Same binding + same declared facts  -> recover the same intent/generation
 *    (new grant URL each time; the URL signature/expiry differs, the identity
 *    does not).
 *  - Same binding + different declared facts -> `request_facts_mismatch` (the
 *    committed binding is non-rebindable to request facts).
 *  - Different binding -> a NEW blob + NEW generation + NEW key (replacement
 *    always uses a new physical key; the old key is never re-signed).
 *  - Every unknown outcome (commit-success-response-lost, before-commit
 *    failure, CSPRNG collision, idempotency race) re-reads the DATABASE on a
 *    bounded second attempt instead of guessing from the caught exception.
 *  - A signing failure never deletes the generation or reuses the key; the
 *    same unexpired binding may be re-signed with a new URL on a later call.
 *
 * Logging records only fixed result classes (`IntentLogClass`) — never the
 * grant URL, physical key, fingerprint, credential, or digest.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
  type MembershipRole,
  type PolicyDecision,
  type PolicyOutcome,
  type PolicyReasonCategory,
} from '../access-policy/index.js';
import {
  ATTACHMENTS_SINGLE_PUT_HARD_CEILING_BYTES,
  type AttachmentsFeatureConfig,
} from './attachments-config.js';
import type {
  AttachmentsLedgerPort,
  FindIntentByBindingInput,
  StoredIntentFacts,
} from './attachments-repository-port.js';

// ---------------------------------------------------------------------------
// Narrow grant-issuing port (structural subset of the I06 BlobStorePort).
// The module must not import infrastructure types; the production
// `BlobStorePort` satisfies this interface because the shapes match.
// ---------------------------------------------------------------------------

export interface UploadGrantHandle {
  readonly generationId: string;
  readonly key: string;
}

export interface UploadGrantOptions {
  readonly ttlSeconds: number;
  readonly contentType?: string;
  readonly contentLength: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Memory-only grant; never persisted or logged by the module. */
export interface UploadGrant {
  readonly url: string;
  readonly method: 'PUT';
  readonly signedAtIso: string;
  readonly expiresAtIso: string;
  readonly ttlSeconds: number;
  readonly generationId: string;
  readonly keyFingerprint: string;
  readonly ifNoneMatch: '*';
  readonly metadataHeaders: Readonly<Record<string, string>>;
  readonly contentLength: number;
  readonly contentType: string;
}

export interface UploadGrantIssuerPort {
  issueCreateOnlyGrant(handle: UploadGrantHandle, options: UploadGrantOptions): Promise<UploadGrant>;
}

// ---------------------------------------------------------------------------
// Unit of work: the use case owns the transaction, commits, and only then signs.
// ---------------------------------------------------------------------------

/**
 * Unit of work seam matching the production UnitOfWork shape: the callback
 * receives a transaction context { transaction }. The production
 * createUnitOfWork satisfies this interface structurally.
 */
export interface IntentUnitOfWork<Transaction> {
  execute<Result>(callback: (context: { transaction: Transaction }) => Promise<Result>): Promise<Result>;
}

// ---------------------------------------------------------------------------
// CSPRNG seam (plan: controlled generator injection for collision negatives)
// ---------------------------------------------------------------------------

export interface UploadIntentCrypto {
  /** Fresh cryptographically-random hex string of `bytes` bytes. */
  randomHex(bytes: number): string;
}

/** Production CSPRNG implementation (node:crypto). */
export const nodeUploadIntentCrypto: UploadIntentCrypto = {
  randomHex: (bytes: number) => randomBytes(bytes).toString('hex'),
};

// ---------------------------------------------------------------------------
// Fixed log result classes (never URLs/keys/credentials/digests)
// ---------------------------------------------------------------------------

export type IntentLogClass =
  | 'intent_issued'
  | 'intent_recovered'
  | 'intent_denied'
  | 'intent_invalid'
  | 'intent_expired'
  | 'grant_signed'
  | 'grant_signing_failed'
  | 'intent_retry';

export interface IntentLogEntry {
  readonly class: IntentLogClass;
  readonly intentId?: string;
  readonly generationId?: string;
  readonly reason?: string;
}

export type IntentLogger = (entry: IntentLogEntry) => void;

// ---------------------------------------------------------------------------
// Errors (stable codes; never provider/SDK text)
// ---------------------------------------------------------------------------

export type UploadIntentInputErrorCode =
  | 'collection_id_required'
  | 'collection_id_too_long'
  | 'subject_identity_required'
  | 'subject_mismatch'
  | 'idempotency_key_required'
  | 'idempotency_key_too_long'
  | 'size_required'
  | 'size_out_of_range'
  | 'digest_invalid'
  | 'media_not_allowed'
  | 'policy_revision_invalid';

export class UploadIntentInputError extends Error {
  readonly code: UploadIntentInputErrorCode;
  constructor(code: UploadIntentInputErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'UploadIntentInputError';
    this.code = code;
  }
}

export class UploadIntentAuthorizationError extends Error {
  readonly outcome: PolicyOutcome;
  readonly reasonCategory: PolicyReasonCategory;
  readonly policyRevision: string | null;
  readonly effectiveRole: MembershipRole | null;

  constructor(decision: PolicyDecision) {
    super(`intent_denied:${decision.reasonCategory}`);
    this.name = 'UploadIntentAuthorizationError';
    this.outcome = decision.outcome;
    this.reasonCategory = decision.reasonCategory;
    this.policyRevision = decision.policyRevision;
    this.effectiveRole = decision.effectiveRole;
  }
}

export type UploadIntentIdentityErrorCode =
  | 'request_facts_mismatch'
  | 'intent_generation_mismatch';

/** The committed idempotency binding is non-rebindable to request facts. */
export class UploadIntentIdentityError extends Error {
  readonly code: UploadIntentIdentityErrorCode;
  constructor(code: UploadIntentIdentityErrorCode) {
    super(code);
    this.name = 'UploadIntentIdentityError';
    this.code = code;
  }
}

export class UploadIntentExpiredError extends Error {
  readonly code = 'intent_expired' as const;
  constructor() {
    super('intent_expired');
    this.name = 'UploadIntentExpiredError';
  }
}

export class UploadIntentSigningError extends Error {
  readonly code = 'grant_signing_failed' as const;
  constructor(cause: unknown) {
    super('grant_signing_failed');
    this.name = 'UploadIntentSigningError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface IssueUploadIntentInput {
  /** Trusted actor resolved by the caller (principal + subject). */
  readonly actor: ActorPrincipal;
  /** Collection the attachment is destined for (authorization scope). */
  readonly collectionId: string;
  /** Client-supplied opaque idempotency binding within the request scope. */
  readonly idempotencyKey: string;
  /** Declared single-PUT byte count; required for the size-bounded grant. */
  readonly declaredSize: number;
  /** Declared SHA-256 (lowercase 64-hex) or null when unknown. */
  readonly declaredSha256?: string | null;
  /** Declared media hint; must be inside the configured allowed-media set. */
  readonly mediaHint?: string | null;
  /** Optional expected policy revision for the TOCTOU fence (deny on mismatch). */
  readonly expectedPolicyRevision?: string | null;
  /**
   * Optional owning-subject candidate. In the private MVP this must equal the
   * trusted actor's subjectId (a subject is resolved from the actor, never
   * chosen cross-subject).
   */
  readonly subjectIdentity?: string | null;
}

export interface UploadIntentReceipt {
  readonly intentId: string;
  readonly generationId: string;
}

export interface IssueUploadIntentResult {
  /** Opaque, idempotently recoverable receipt. */
  readonly receipt: UploadIntentReceipt;
  /** Stable logical blob identity (recoverable from the same binding). */
  readonly blobId: string;
  /** True when an existing committed intent/generation was recovered. */
  readonly recovered: boolean;
  /** Memory-only grant; never persisted or logged. */
  readonly grant: UploadGrant;
}

// ---------------------------------------------------------------------------
// Use case deps
// ---------------------------------------------------------------------------

export interface IssueUploadIntentDeps<Transaction> {
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** Binds the access-policy facts port to the caller-provided transaction. */
  readonly accessPolicyFor: (transaction: Transaction) => AccessPolicyFactsPort;
  readonly blobStore: UploadGrantIssuerPort;
  readonly uow: IntentUnitOfWork<Transaction>;
  readonly crypto: UploadIntentCrypto;
  readonly config: AttachmentsFeatureConfig;
  /** Injectable clock (intent expiry); defaults to the wall clock. */
  readonly now?: () => Date;
  readonly log?: IntentLogger;
}

// ---------------------------------------------------------------------------
// Validation (pure, synchronous, fast-fail before any database work)
// ---------------------------------------------------------------------------

export interface ValidatedUploadIntentInput {
  readonly actor: ActorPrincipal;
  readonly collectionId: string;
  readonly subjectIdentity: string;
  readonly idempotencyKey: string;
  readonly declaredSize: number;
  readonly declaredSha256: string | null;
  readonly mediaHint: string | null;
  readonly expectedPolicyRevision: string | null;
}

const MAX_COLLECTION_ID_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_POLICY_REVISION_LENGTH = 512;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function validateUploadIntentInput(
  input: IssueUploadIntentInput,
  config: AttachmentsFeatureConfig,
): ValidatedUploadIntentInput {
  const collectionId = input.collectionId.trim();
  if (collectionId.length === 0) throw new UploadIntentInputError('collection_id_required');
  if (collectionId.length > MAX_COLLECTION_ID_LENGTH) throw new UploadIntentInputError('collection_id_too_long');

  const subjectIdentity = (input.subjectIdentity ?? input.actor.subjectId).trim();
  if (subjectIdentity.length === 0) throw new UploadIntentInputError('subject_identity_required');
  if (subjectIdentity !== input.actor.subjectId) {
    throw new UploadIntentInputError('subject_mismatch', 'a subject is resolved from the trusted actor and cannot be chosen cross-subject');
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) throw new UploadIntentInputError('idempotency_key_required');
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new UploadIntentInputError('idempotency_key_too_long');

  if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0) {
    throw new UploadIntentInputError('size_required', 'declaredSize must be a non-negative safe integer');
  }
  if (input.declaredSize > config.singlePutMaxBytes) {
    throw new UploadIntentInputError('size_out_of_range', `declaredSize must be <= singlePutMaxBytes (${config.singlePutMaxBytes})`);
  }
  // The config already enforces singlePutMaxBytes <= the compile ceiling; this
  // explicit check pins the hard budget even if a misconfigured config object
  // is injected directly into the use case (plan §6 I08 budget boundaries).
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
    collectionId,
    subjectIdentity,
    idempotencyKey,
    declaredSize: input.declaredSize,
    declaredSha256,
    mediaHint,
    expectedPolicyRevision,
  };
}

// ---------------------------------------------------------------------------
// Deterministic logical blob identity from the idempotency binding.
// The production unique (blob_id, idempotency_key) then enforces exactly one
// intent per binding, including under concurrent issue.
// ---------------------------------------------------------------------------

export function computeBlobIdFromBinding(
  collectionId: string,
  subjectIdentity: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`known:upload-intent:v1:${subjectIdentity}\u0000${collectionId}\u0000${idempotencyKey}`, 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Authorization (plan: owner/editor/member per the attachment policy).
// The attachment upload-intent policy is a membership gate: any collection
// member (owner, editor, viewer) may request an upload intent. Uploads are
// create-only and the blob is owned by the uploader; cross-Collection,
// deleted-subject, non-member, and stale policy-revision requests are denied.
// Later current-authorization (I10) and the finalize handoff (I13) gate
// delivery/attachment; an authorization change after issue is an expected
// risk, not an issue failure (plan §6 I08 anti-false-negative).
// ---------------------------------------------------------------------------

const ATTACHMENT_UPLOAD_INTENT_CAPABILITY = 'read_editor' as const;

async function authorizeIssue<Transaction>(
  deps: IssueUploadIntentDeps<Transaction>,
  transaction: Transaction,
  validated: ValidatedUploadIntentInput,
): Promise<PolicyDecision> {
  const decision = await authorizeCapability(deps.accessPolicyFor(transaction), {
    collectionId: validated.collectionId,
    actor: validated.actor,
    capability: ATTACHMENT_UPLOAD_INTENT_CAPABILITY,
    expectedPolicyRevision: validated.expectedPolicyRevision ?? undefined,
  });
  if (decision.outcome !== 'allow') {
    throw new UploadIntentAuthorizationError(decision);
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Grant signing happens ONLY after the transaction committed.
// ---------------------------------------------------------------------------

async function signGrant<Transaction>(
  deps: IssueUploadIntentDeps<Transaction>,
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
    deps.log?.({ class: 'grant_signed', intentId: undefined, generationId });
    return grant;
  } catch (error) {
    deps.log?.({ class: 'grant_signing_failed', generationId });
    throw new UploadIntentSigningError(error);
  }
}

// ---------------------------------------------------------------------------
// In-transaction core: authorize -> lookup binding -> allocate or recover.
// Inside the transaction there is NO network and NO signing; only identity is
// generated and persisted.
// ---------------------------------------------------------------------------

type InTransactionOutcome =
  | { outcome: 'issued'; intentId: string; generationId: string; blobId: string; key: string }
  | { outcome: 'recovered'; intent: StoredIntentFacts };

function declaredFactsEqual(intent: StoredIntentFacts, validated: ValidatedUploadIntentInput): boolean {
  return intent.expectedSize === validated.declaredSize
    && intent.expectedSha256 === validated.declaredSha256
    && intent.mediaHint === validated.mediaHint;
}

async function issueInTransaction<Transaction>(
  tx: Transaction,
  deps: IssueUploadIntentDeps<Transaction>,
  validated: ValidatedUploadIntentInput,
  decision: PolicyDecision,
  now: Date,
): Promise<InTransactionOutcome> {
  const binding: FindIntentByBindingInput = {
    collectionId: validated.collectionId,
    subjectIdentity: validated.subjectIdentity,
    idempotencyKey: validated.idempotencyKey,
  };

  const found = await deps.ledger.findIntentByBinding(tx, binding);
  if (found.outcome === 'found') {
    if (!declaredFactsEqual(found.intent, validated)) {
      throw new UploadIntentIdentityError('request_facts_mismatch');
    }
    if (found.intent.expiresAt.getTime() <= now.getTime()) {
      deps.log?.({ class: 'intent_expired', intentId: found.intent.intentId, generationId: found.intent.generationId });
      throw new UploadIntentExpiredError();
    }
    deps.log?.({ class: 'intent_recovered', intentId: found.intent.intentId, generationId: found.intent.generationId });
    return { outcome: 'recovered', intent: found.intent };
  }

  // Allocate a fresh intent/blob/generation/key binding.
  const blobId = computeBlobIdFromBinding(
    validated.collectionId,
    validated.subjectIdentity,
    validated.idempotencyKey,
  );
  const intentId = deps.crypto.randomHex(16);
  const generationId = deps.crypto.randomHex(16);
  const key = `${deps.config.r2.livePrefix}${deps.crypto.randomHex(16)}`;
  const keyFingerprint = createHash('sha256').update(key, 'utf8').digest('hex');
  const expiresAt = new Date(now.getTime() + deps.config.retention.intentRetentionHours * 3_600_000);

  const allocated = await deps.ledger.allocate(tx, {
    blobId,
    intentId,
    generationId,
    principalId: validated.actor.principalId,
    collectionId: validated.collectionId,
    subjectIdentity: validated.subjectIdentity,
    bucket: deps.config.r2.bucket,
    key,
    keyFingerprint,
    expectedSize: validated.declaredSize,
    expectedSha256: validated.declaredSha256,
    mediaHint: validated.mediaHint,
    policyRevision: decision.policyRevision ?? 'unknown',
    idempotencyKey: validated.idempotencyKey,
    expiresAt,
  });

  if (allocated.outcome === 'already_issued') {
    // A deterministic-crypto replay (or a defensive race) hit the same
    // identity; re-read the committed facts and recover instead of guessing.
    const reRead = await deps.ledger.findIntentByBinding(tx, binding);
    if (reRead.outcome !== 'found') {
      throw new UploadIntentIdentityError('intent_generation_mismatch');
    }
    deps.log?.({ class: 'intent_recovered', intentId: reRead.intent.intentId, generationId: reRead.intent.generationId });
    return { outcome: 'recovered', intent: reRead.intent };
  }

  deps.log?.({ class: 'intent_issued', intentId, generationId });
  return { outcome: 'issued', intentId, generationId, blobId, key };
}

// ---------------------------------------------------------------------------
// Public entry: bounded two-attempt loop. Attempt 0 may fail for ANY reason
// (before-commit crash, commit-success-response-lost, CSPRNG collision,
// idempotency race). Attempt 1 re-reads the DATABASE and either recovers the
// committed identity or allocates a fresh one; the plan's anti-false-negative
// rule says recovery must never be inferred from the caught exception.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

export async function issueUploadIntent<Transaction>(
  deps: IssueUploadIntentDeps<Transaction>,
  input: IssueUploadIntentInput,
): Promise<IssueUploadIntentResult> {
  let validated: ValidatedUploadIntentInput;
  try {
    validated = validateUploadIntentInput(input, deps.config);
  } catch (error) {
    if (error instanceof UploadIntentInputError) deps.log?.({ class: 'intent_invalid', reason: error.code });
    throw error;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) deps.log?.({ class: 'intent_retry' });
    try {
      const now = (deps.now?.() ?? new Date());
      const inTransaction = await deps.uow.execute(async ({ transaction: tx }) => {
        const decision = await authorizeIssue(deps, tx, validated);
        return issueInTransaction(tx, deps, validated, decision, now);
      });

      if (inTransaction.outcome === 'recovered') {
        const grant = await signGrant(deps, inTransaction.intent.generationId, inTransaction.intent.key,
          validated.declaredSize, validated.mediaHint);
        return {
          receipt: { intentId: inTransaction.intent.intentId, generationId: inTransaction.intent.generationId },
          blobId: inTransaction.intent.blobId,
          recovered: true,
          grant,
        };
      }

      const grant = await signGrant(deps, inTransaction.generationId, inTransaction.key,
        validated.declaredSize, validated.mediaHint);
      return {
        receipt: { intentId: inTransaction.intentId, generationId: inTransaction.generationId },
        blobId: inTransaction.blobId,
        recovered: false,
        grant,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof UploadIntentSigningError
        || error instanceof UploadIntentInputError
        || error instanceof UploadIntentAuthorizationError
        || error instanceof UploadIntentExpiredError
        || error instanceof UploadIntentIdentityError) {
        // Deterministic outcomes (signing after commit, validation, denial,
        // expiry, committed-facts mismatch) surface immediately; they cannot
        // change by re-reading the database. Only transaction/unknown outcomes
        // (before-commit crash, commit-success-response-lost, CSPRNG collision,
        // idempotency race) are recovered by a bounded second attempt.
        if (error instanceof UploadIntentAuthorizationError) {
          deps.log?.({ class: 'intent_denied', reason: error.reasonCategory });
        }
        throw error;
      }
      // Anything else (transaction failure, identity collision, idempotency
      // race, commit-outcome-unknown) re-reads the database once.
      if (attempt === MAX_ATTEMPTS - 1) throw error;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError instanceof Error ? lastError : new Error('intent_issue_failed');
}
