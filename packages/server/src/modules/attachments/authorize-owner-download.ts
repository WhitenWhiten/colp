/**
 * P4A-I10 internal application use case: authorize owner-private downloads
 * (`phase4a: authorize owner-private downloads`).
 *
 * Admission input is a TRUSTED actor + an OPAQUE logical blob identity. The
 * caller can never submit the physical key or a generation id as the
 * authorization basis: the repository resolves the CURRENT active generation
 * from the logical identity under a consistent read (FOR SHARE on the blob +
 * current generation rows, DB clock), and the capability is bound to that
 * generation at admission time.
 *
 * Delivery contract (plan §6 I10, §3.4, ADR-0020):
 *  - only `stored_private|attached_private` blobs whose current generation is
 *    `active` are deliverable;
 *  - the actor must BE the uploading owner (`blob_records.owner_subject_id`),
 *    AND must still satisfy CURRENT collection authorization at request time
 *    (no caching of the intent-creation authorization) — a same-Collection
 *    member/editor/owner who is not the uploader is DENIED;
 *  - every denial is existence-hidden (404) — never internal reason text;
 *    only rate limiting is 429;
 *  - the capability is a short-lived, single-object, single-purpose stateless
 *    signed token: audience = isolated delivery origin (from config), bound to
 *    blob/generation, method GET, bounded expiry (1..120s), random nonce; it
 *    is unusable for R2 write/list or any other service;
 *  - revocation window: the capability remains valid until its TTL expiry;
 *    replacement/revocation invalidates by GENERATION BINDING at admission —
 *    an old capability can never serve the new generation's bytes, and a new
 *    admission always resolves the current generation (frozen consistency,
 *    documented max exposure window = TTL).
 *
 * Audit: fixed-class structured log entries only (`download_admitted`,
 * `download_denied`, `download_rate_limited`, `download_invalid`) — never the
 * URL, key, credential, origin, or digest. Rate limiting is a bounded
 * per-principal fixed window (see `delivery-rate-limiter.ts`).
 */
import {
  authorizeCapability,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
  type PolicyDecision,
} from '../access-policy/index.js';
import type { AttachmentsFeatureConfig } from './attachments-config.js';
import { NOOP_BARRIER, type PhaseBarrier } from './attachments-ledger-contract.js';
import type { AttachmentsLedgerPort, BlobForDeliveryFacts } from './attachments-repository-port.js';
import type { DeliveryRateLimiter } from './delivery-rate-limiter.js';
import type { IntentUnitOfWork } from './issue-upload-intent.js';
import type { OwnerDeliveryCapability, OwnerDeliveryCapabilitySigner } from './owner-delivery-capability.js';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface AuthorizeOwnerDownloadInput {
  /**
   * Trusted actor resolved by the caller (principal + subject). `null`
   * represents an anonymous request: denied 404 without any database or
   * rate-limit work.
   */
  readonly actor: ActorPrincipal | null;
  /** Opaque logical blob identity; the key/generation are NEVER inputs. */
  readonly blobId: string;
}

export type OwnerDownloadDenialCode =
  | 'unauthenticated'
  | 'blob_not_found'
  | 'not_deliverable'
  | 'not_owner'
  | 'authorization_denied';

export type AuthorizeOwnerDownloadResult =
  | {
      outcome: 'granted';
      capability: OwnerDeliveryCapability;
      blobId: string;
      generationId: string;
      issuedAtEpochMs: number;
      expiresAtEpochMs: number;
    }
  | { outcome: 'denied'; statusCode: 404; code: OwnerDownloadDenialCode }
  | { outcome: 'rate_limited'; retryAfterSeconds: number };

// ---------------------------------------------------------------------------
// Fixed audit result classes (never URLs/keys/credentials/origins/digests)
// ---------------------------------------------------------------------------

export type OwnerDownloadLogClass =
  | 'download_admitted'
  | 'download_denied'
  | 'download_rate_limited'
  | 'download_invalid';

export interface OwnerDownloadLogEntry {
  readonly class: OwnerDownloadLogClass;
  readonly blobId?: string;
  readonly generationId?: string;
  readonly principalId?: string;
  readonly statusCode?: number;
  readonly code?: OwnerDownloadDenialCode;
  readonly retryAfterSeconds?: number;
}

export type OwnerDownloadLogger = (entry: OwnerDownloadLogEntry) => void;

// ---------------------------------------------------------------------------
// Use case deps
// ---------------------------------------------------------------------------

export interface AuthorizeOwnerDownloadDeps<Transaction> {
  readonly ledger: AttachmentsLedgerPort<Transaction>;
  /** Binds the access-policy facts port to the caller-provided transaction. */
  readonly accessPolicyFor: (transaction: Transaction) => AccessPolicyFactsPort;
  readonly uow: IntentUnitOfWork<Transaction>;
  readonly capabilitySigner: OwnerDeliveryCapabilitySigner;
  /** Bounded per-principal fixed-window limiter (process-local, documented). */
  readonly rateLimiter: DeliveryRateLimiter;
  readonly config: AttachmentsFeatureConfig;
  /** Deterministic test seam; defaults to a no-op barrier. */
  readonly barrier?: PhaseBarrier;
  readonly now?: () => Date;
  readonly log?: OwnerDownloadLogger;
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
// Authorization: the attachment delivery policy is a CURRENT membership gate.
// The owner binding (`owner_subject_id == actor.subjectId`) is checked
// separately and strictly — same-Collection members who are not the uploader
// are denied regardless of their role. `read_editor` is the same capability
// the I08 upload-intent policy uses; for the owner it resolves to allow as
// long as the collection is live, which is exactly the "current
// authorization" the plan requires (no cached intent-time authorization).
// ---------------------------------------------------------------------------

const ATTACHMENT_DELIVERY_CAPABILITY = 'read_editor' as const;

function isDeliverableBlob(facts: BlobForDeliveryFacts): boolean {
  return (facts.logicalState === 'stored_private' || facts.logicalState === 'attached_private')
    && facts.currentGenerationId !== null
    && facts.currentGenerationState === 'active'
    && facts.collectionId !== null;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function authorizeOwnerDownload<Transaction>(
  deps: AuthorizeOwnerDownloadDeps<Transaction>,
  input: AuthorizeOwnerDownloadInput,
): Promise<AuthorizeOwnerDownloadResult> {
  const blobId = validateBlobId(input.blobId);
  if (blobId === undefined) {
    deps.log?.({ class: 'download_invalid', code: 'blob_not_found' });
    return { outcome: 'denied', statusCode: 404, code: 'blob_not_found' };
  }
  if (input.actor === null) {
    deps.log?.({ class: 'download_denied', statusCode: 404, code: 'unauthenticated' });
    return { outcome: 'denied', statusCode: 404, code: 'unauthenticated' };
  }
  const actor = input.actor;

  // The capability signer must target the configured isolated delivery origin;
  // a mismatched composition is a fixed programming/config error.
  if (deps.capabilitySigner.audienceOrigin !== deps.config.isolatedDeliveryOrigin) {
    throw new Error('delivery_capability_audience_mismatch');
  }

  // Bounded per-principal rate limit BEFORE any database work.
  const now = deps.now?.() ?? new Date();
  const limit = deps.rateLimiter.check(actor.principalId, now);
  if (!limit.allowed) {
    deps.log?.({ class: 'download_rate_limited', principalId: actor.principalId, retryAfterSeconds: limit.retryAfterSeconds });
    return { outcome: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  }

  const admitted = await deps.uow.execute(async ({ transaction }) => {
    const barrier = deps.barrier ?? NOOP_BARRIER;
    // The opaque blob id is the only authorization basis; the repository resolves
    // the current active generation from the logical identity. The use-case
    // barrier below is the frozen-window hook (between authorization read and
    // capability issuance); port-level barrier points are for direct port tests.
    const found = await deps.ledger.findBlobForDelivery(transaction, { blobId });
    if (found.outcome === 'not_found') {
      return { outcome: 'denied' as const, code: 'blob_not_found' as const };
    }
    const facts = found.facts;
    if (!isDeliverableBlob(facts)) {
      return { outcome: 'denied' as const, code: 'not_deliverable' as const };
    }
    if (actor.subjectId !== facts.ownerSubjectId) {
      return { outcome: 'denied' as const, code: 'not_owner' as const };
    }
    const decision: PolicyDecision = await authorizeCapability(deps.accessPolicyFor(transaction), {
      collectionId: facts.collectionId!,
      actor,
      capability: ATTACHMENT_DELIVERY_CAPABILITY,
    });
    if (decision.outcome !== 'allow') {
      return { outcome: 'denied' as const, code: 'authorization_denied' as const };
    }
    // Barrier between the authorization read and the capability issuance: the
    // transaction is still open (holding the frozen read lock) so a concurrent
    // revocation/replacement cannot tear the snapshot.
    await barrier.arriveAndWait('delivery_after_authorization');
    return { outcome: 'admitted' as const, facts };
  });

  if (admitted.outcome === 'denied') {
    deps.log?.({
      class: 'download_denied',
      blobId,
      principalId: actor.principalId,
      statusCode: 404,
      code: admitted.code,
    });
    return { outcome: 'denied', statusCode: 404, code: admitted.code };
  }

  const generationId = admitted.facts.currentGenerationId!;
  const capability = deps.capabilitySigner.sign({
    blobId,
    generationId,
    ownerSubject: admitted.facts.ownerSubjectId,
    ttlSeconds: deps.config.deliveryCapabilityTtlSeconds,
    now,
  });
  deps.log?.({
    class: 'download_admitted',
    blobId,
    generationId,
    principalId: actor.principalId,
  });
  return {
    outcome: 'granted',
    capability,
    blobId,
    generationId,
    issuedAtEpochMs: capability.claims.issuedAtEpochMs,
    expiresAtEpochMs: capability.claims.expiresAtEpochMs,
  };
}


