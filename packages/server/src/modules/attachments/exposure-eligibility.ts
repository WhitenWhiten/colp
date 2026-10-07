/**
 * P4A-I12 exposure eligibility gate: deny-by-default at the Attachment /
 * application export boundary.
 *
 * Every shared/public projection — Publication rebuild/read, Sync
 * Snapshot/Pull, MCP Resource/Tool, search index/query, Profile/Manifest
 * capability and shared-link registry — MUST depend on this gate before it may
 * ever expose Attachment bytes or metadata. While NO content-safety capability
 * exists (no scanner, no `safe` verdict, no shared/public Attachment product),
 * the gate ALWAYS returns the explicit ineligible verdict:
 *
 * - the negative policy is an explicit result (`eligible: false` + a stable
 *   `reason` + `exposureMode`), NOT "the current mapper has no field";
 * - the eligibility union is CLOSED: `SharedExposureEligibility` currently has
 *   exactly one member (the ineligible verdict). There is no boolean `safe`
 *   toggle and no renaming of `stored_private`/`attached_private` may imply
 *   safety. Any future eligible state requires a NEW ADR + migration +
 *   capability that carries content-safety evidence, and is a reviewed change
 *   in this module (the attachments owner);
 * - the gate consumes only LOGICAL facts (`SharedExposureBlobFacts`) and never
 *   the physical key or body, so a projection purge/rebuild can consult it
 *   without reading Attachment bytes;
 * - the gate is a pure function, so an application restart re-evaluates every
 *   blob against the same closed policy (deny-by-default is not cached).
 *
 * For P4A-I12 no production consumer imports this gate yet (see
 * `scripts/check-import-boundaries.mjs` module edges — consumers have no edge
 * to `attachments`). This file is the single approved eligibility-port shape a
 * future consumer may be granted after a reviewed boundary edge.
 */
import type { BlobLogicalState, GenerationState } from './attachments-ledger-contract.js';

/** Closed list of shared/projection consumer kinds the gate guards. */
export const SHARED_EXPOSURE_PROJECTION_KINDS = [
  'publication',
  'sync',
  'mcp',
  'search',
  'profile',
  'shared_link',
] as const;
export type SharedExposureProjectionKind = typeof SHARED_EXPOSURE_PROJECTION_KINDS[number];

/** The only ineligibility reason while no content-safety capability exists. */
export const SHARED_EXPOSURE_INELIGIBILITY_REASONS = [
  'no_content_safety_evidence',
] as const;
export type SharedExposureIneligibilityReason = typeof SHARED_EXPOSURE_INELIGIBILITY_REASONS[number];

/** ADR-0020 fixed exposure mode for unscanned private bytes. */
export const OWNER_PRIVATE_EXPOSURE_MODE = 'owner-private-unscanned' as const;

const BLOB_LOGICAL_STATES: readonly BlobLogicalState[] = [
  'issued', 'uploaded', 'verifying', 'stored_private', 'attached_private', 'expired',
] as const;
const GENERATION_STATES: readonly GenerationState[] = [
  'allocated', 'observed', 'active', 'orphaned', 'retired', 'deletion_pending',
  'deleted', 'contract_corrupt', 'quarantined',
] as const;

/**
 * Logical facts a shared consumer may already hold. The physical generation
 * key and body are deliberately absent from this type: the gate (and any
 * consumer that depends on it) can never read or propagate them.
 */
export interface SharedExposureBlobFacts {
  readonly blobId: string;
  readonly logicalState: BlobLogicalState;
  readonly currentGenerationState: GenerationState | null;
}

export interface IneligibleSharedExposure {
  readonly eligible: false;
  readonly reason: SharedExposureIneligibilityReason;
  readonly exposureMode: typeof OWNER_PRIVATE_EXPOSURE_MODE;
  /** The assessed logical blob identity (never the physical key). */
  readonly blobId: string;
  readonly logicalState: BlobLogicalState;
  readonly currentGenerationState: GenerationState | null;
}

/**
 * Closed exposure-eligibility union. While content-safety evidence does not
 * exist, the ineligible verdict is the ONLY member; TypeScript cannot
 * construct an eligible result and a consumer must handle the ineligible case
 * explicitly. Extending this union is a reviewed attachments-module change
 * owned by a new ADR/migration/capability.
 */
export type SharedExposureEligibility = IneligibleSharedExposure;

/** Fail-fast shape guard; misuse is loud instead of silently denied. */
export function assertSharedExposureBlobFacts(value: unknown): asserts value is SharedExposureBlobFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('SharedExposureBlobFacts must be an object');
  }
  const facts = value as Partial<SharedExposureBlobFacts>;
  if (typeof facts.blobId !== 'string' || facts.blobId.length === 0) {
    throw new TypeError('SharedExposureBlobFacts.blobId must be a non-empty string');
  }
  if (!BLOB_LOGICAL_STATES.includes(facts.logicalState as BlobLogicalState)) {
    throw new TypeError('SharedExposureBlobFacts.logicalState is not a closed BlobLogicalState');
  }
  if (facts.currentGenerationState !== null
      && !GENERATION_STATES.includes(facts.currentGenerationState as GenerationState)) {
    throw new TypeError('SharedExposureBlobFacts.currentGenerationState is not a closed GenerationState');
  }
}

/**
 * Assesses shared-exposure eligibility for one logical blob.
 *
 * Deny-by-default: until a content-safety capability exists, EVERY blob —
 * whatever its logical state (`issued` ... `attached_private`, `expired`) or
 * generation state (`active`, `retired`, `expired`, `quarantined`, ...) — is
 * explicitly ineligible for every shared projection kind. The verdict does not
 * depend on feature flags, process instance, or wall clock, so an application
 * restart re-evaluates to the same closed result.
 */
export function assessSharedExposureEligibility(facts: SharedExposureBlobFacts): SharedExposureEligibility {
  assertSharedExposureBlobFacts(facts);
  return Object.freeze({
    eligible: false,
    reason: 'no_content_safety_evidence',
    exposureMode: OWNER_PRIVATE_EXPOSURE_MODE,
    blobId: facts.blobId,
    logicalState: facts.logicalState,
    currentGenerationState: facts.currentGenerationState,
  });
}

/** Convenience guard for consumer projection builders: fails fast on misuse. */
export function assertSharedExposureIneligible(verdict: SharedExposureEligibility): asserts verdict is IneligibleSharedExposure {
  if (verdict.eligible !== false) {
    throw new Error('Shared exposure eligibility must be deny-by-default until content-safety evidence exists');
  }
}
