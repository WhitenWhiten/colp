/**
 * P4A-P04 owner-private status/metadata read use case.
 *
 * Reads the logical state, verification progress, verified size/media, DB-clock
 * created/updated facts, and allowed actions for ONE blob through the
 * production PostgreSQL ledger. Contract (frozen OpenAPI `getAttachmentStatus`,
 * plan §2.4 invariants 1/3/4/6/7 and §6 P4A-P04):
 *
 *  - The opaque blobId is the ONLY input; the repository resolves the current
 *    generation/intent/metadata facts. The DTO NEVER contains a digest value,
 *    physical key, key fingerprint, bucket, URL, credential, filename,
 *    generation id, intent id, provider metadata, lease, or internal denial
 *    reason.
 *  - Every read authorizes from PostgreSQL in the SAME snapshot: the owner
 *    subject binding AND the CURRENT collection membership (read_editor). A
 *    revoked owner, a member non-owner, an outsider, and a cross-Collection
 *    subject are all concealed as the identical `not_found` — no 403 is ever
 *    hard-bound to an internal reason, and the external Problem has zero body
 *    variation (route concern).
 *  - Anonymous requests are concealed identically and perform ZERO database
 *    work (uniform 404 for every identity: no existence side channel).
 *  - The workload for a foreign real blobId equals the workload for a
 *    nonexistent blobId: exactly one indexed SELECT before the concealed 404
 *    (anti-false-negative: no timing/query-count side channel).
 *  - verificationStatus covers size/digest verification ONLY and never
 *    implies malware-safety; the DTO vocabulary is
 *    pending/verifying/verified/failed and never clean/safe/scanned.
 *  - The read path records NO metrics and NO logs: there is no per-ID metric
 *    label or log class surface at all (plan §13.2 low-cardinality rule).
 *    Publication CacheStore is NEVER consulted — the read is PostgreSQL-only.
 *  - `retired`/`deleted` terminal attachment metadata is concealed as
 *    `not_found` (frozen contract: "retired/tombstoned identities are
 *    concealed"). The `retired` DTO enum value stays reserved for the P07
 *    retirement lifecycle; P04 never serves it.
 */
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
  type PolicyDecision,
} from '../access-policy/index.js';
import type {
  AttachmentsLedgerPort,
  StatusBlobFacts,
} from './attachments-repository-port.js';
import type { IntentUnitOfWork } from './issue-upload-intent.js';

// ---------------------------------------------------------------------------
// Frozen DTO vocabulary (openapi/product-v1.yaml AttachmentStatusDto)
// ---------------------------------------------------------------------------

export type AttachmentStatusLogicalState =
  | 'issued'
  | 'uploaded'
  | 'verifying'
  | 'stored_private'
  | 'attached_private'
  | 'quarantined'
  | 'expired'
  | 'retired';

export type AttachmentVerificationStatus = 'pending' | 'verifying' | 'verified' | 'failed';

export type AttachmentAvailability = 'unavailable' | 'available';

export type AttachmentAllowedAction = 'complete' | 'finalize' | 'download' | 'replace' | 'retire';

/** Owner-private status view; JSON-ready (ISO-8601 UTC time facts). */
export interface AttachmentStatusView {
  readonly blobId: string;
  readonly logicalState: AttachmentStatusLogicalState;
  readonly verificationStatus: AttachmentVerificationStatus;
  readonly availability: AttachmentAvailability;
  readonly size: number;
  readonly mediaType: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly allowedActions: readonly AttachmentAllowedAction[];
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface ReadAttachmentStatusInput {
  /** Trusted actor; `null` is an anonymous request (concealed 404, no DB work). */
  readonly actor: ActorPrincipal | null;
  /** Opaque logical blob identity; the key/generation are NEVER inputs. */
  readonly blobId: string;
}

export type ReadAttachmentStatusResult =
  | { outcome: 'found'; view: AttachmentStatusView }
  | { outcome: 'not_found' };

export interface ReadAttachmentStatusDeps<Transaction> {
  /** Transaction-bound ledger: the current blob/generation/intent/metadata facts. */
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** Binds the access-policy facts port to the caller-provided transaction. */
  readonly accessPolicyFor: (transaction: Transaction) => AccessPolicyFactsPort;
  readonly uow: IntentUnitOfWork<Transaction>;
}

// ---------------------------------------------------------------------------
// Validation (pure, synchronous, existence-hidden)
// ---------------------------------------------------------------------------

const MAX_BLOB_ID_LENGTH = 512;

function validateBlobId(raw: string): string | undefined {
  const blobId = raw.trim();
  if (blobId.length === 0 || blobId.length > MAX_BLOB_ID_LENGTH) return undefined;
  // Printable ASCII only: opaque identity, no whitespace/control characters.
  if (/[^\x21-\x7e]/u.test(blobId)) return undefined;
  return blobId;
}

// ---------------------------------------------------------------------------
// Authorization: the status policy is a CURRENT membership gate layered on
// the immutable owner binding. `read_editor` is the same capability the
// upload-intent and delivery policies use; for the owner it resolves to allow
// as long as the collection is live — exactly the "every read authorizes from
// PostgreSQL" invariant (plan §2.4 invariant 6: no cached authorization).
// ---------------------------------------------------------------------------

const ATTACHMENT_STATUS_CAPABILITY = 'read_editor' as const;

// ---------------------------------------------------------------------------
// Pure DTO mapping (unit-pinned in phase4a-p04-status-mapping.test.ts)
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

/**
 * Derives the frozen DTO from the ledger facts. The mapping rules:
 *  - a quarantined current generation dominates the blob logical state
 *    (`quarantined`, `failed`, unavailable, no actions);
 *  - `verified` only ever means size/digest verification completed — never a
 *    safety verdict;
 *  - `available` requires stored/attached private AND an active current
 *    generation (the delivery gate mirror);
 *  - `complete` stays available through verifying (an idempotent replay
 *    converges); `finalize`/`replace` require a stored_private active
 *    generation; `retire` requires attached_private (P07 owns the mutation).
 */
export function composeAttachmentStatusView(
  facts: StatusBlobFacts,
  blobId: string,
): AttachmentStatusView {
  const blobState = facts.logicalState;
  const generationState = facts.currentGenerationState;
  const quarantined = generationState === 'quarantined';

  const logicalState: AttachmentStatusLogicalState = quarantined ? 'quarantined' : blobState;

  const verificationStatus: AttachmentVerificationStatus = quarantined
    ? 'failed'
    : blobState === 'stored_private' || blobState === 'attached_private'
      ? 'verified'
      : blobState === 'verifying'
        ? 'verifying'
        : 'pending';

  const deliverable = (blobState === 'stored_private' || blobState === 'attached_private')
    && generationState === 'active';
  const availability: AttachmentAvailability = deliverable ? 'available' : 'unavailable';

  const allowedActions: AttachmentAllowedAction[] = [];
  // A quarantined generation dominates the ENTIRE view: zero actions, even
  // when the blob row still carries a pre-quarantine logical state (the
  // defensive/unreachable combo the unit matrix pins).
  if (!quarantined && (blobState === 'issued' || blobState === 'uploaded' || blobState === 'verifying')) {
    allowedActions.push('complete');
  }
  if (blobState === 'stored_private' && generationState === 'active') {
    allowedActions.push('finalize');
  }
  if (deliverable) allowedActions.push('download');
  if (blobState === 'stored_private' && generationState === 'active') {
    allowedActions.push('replace');
  }
  if (blobState === 'attached_private' && generationState === 'active') {
    allowedActions.push('retire');
  }

  return {
    blobId,
    logicalState,
    verificationStatus,
    availability,
    // The verified size/media are the ONLY authoritative facts once present;
    // before verification the declared intent facts are shown; the defensive
    // null fallback never invents a digest or a fake verified fact.
    size: facts.verifiedSize ?? facts.expectedSize ?? 0,
    mediaType: facts.mediaType ?? facts.mediaHint ?? null,
    createdAt: toIso(facts.createdAt),
    updatedAt: toIso(facts.updatedAt),
    allowedActions: Object.freeze(allowedActions),
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function readAttachmentStatus<Transaction>(
  deps: ReadAttachmentStatusDeps<Transaction>,
  input: ReadAttachmentStatusInput,
): Promise<ReadAttachmentStatusResult> {
  const blobId = validateBlobId(input.blobId);
  if (blobId === undefined) return { outcome: 'not_found' };
  if (input.actor === null) return { outcome: 'not_found' };
  const actor = input.actor;

  const admitted = await deps.uow.execute(async ({ transaction }) => {
    const found = await deps.ledger.findBlobForStatus(transaction, { blobId });
    if (found.outcome === 'not_found') return { outcome: 'not_found' as const };
    const facts = found.facts;
    // Terminal attachment metadata (retired/tombstoned) is existence-hidden
    // exactly like a missing blob (frozen contract concealment).
    if (facts.attachmentLogicalState === 'retired' || facts.attachmentLogicalState === 'deleted') {
      return { outcome: 'not_found' as const };
    }
    // The owner binding is immutable; the collection membership is CURRENT
    // (re-read every time — no cached authorization).
    if (facts.ownerSubjectId !== actor.subjectId) return { outcome: 'not_found' as const };
    if (facts.collectionId === null) return { outcome: 'not_found' as const };
    const decision: PolicyDecision = await authorizeCapability(deps.accessPolicyFor(transaction), {
      collectionId: facts.collectionId,
      actor,
      capability: ATTACHMENT_STATUS_CAPABILITY,
    });
    if (decision.outcome !== 'allow') return { outcome: 'not_found' as const };
    return { outcome: 'found' as const, view: composeAttachmentStatusView(facts, blobId) };
  });
  return admitted;
}
