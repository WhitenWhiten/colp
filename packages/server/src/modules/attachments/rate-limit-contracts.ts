/**
 * P4A-RL02 distributed rate-limit contract layer (plan §2.2.5, §8 RL02).
 *
 * This module freezes the PORTS and SEALED TYPES of the Attachment admission
 * limiter WITHOUT any Redis implementation:
 *
 *  - `RateLimitStore` is the independent storage port (separate client, ACL,
 *    key namespace, command budget, readiness and fail strategy from the
 *    Publication `CacheStore`); only the RL03 infrastructure adapter touches
 *    the Redis SDK, so NO ioredis type can ever appear here;
 *  - `AttachmentAdmissionRateLimiter` is the higher-level facade the routes
 *    will call (RL04), carrying the mode (`off|shadow|enforce`) inside every
 *    outcome so decision/fallback metrics stay fixed-label;
 *  - the sealed unions (route classes, modes, failure classes) and the
 *    `AttachmentRateLimitDecision` shape (`allowed`, `remaining`,
 *    `retryAfterSeconds`, `windowStartEpochMs`) are the domain contract;
 *  - `exhausted` is a quota DECISION (429), while `unavailable`/`timeout`/
 *    `malformed`/`acl`/`internal` are infrastructure FAILURE classes (503 or
 *    the bounded complete emergency fallback) — the two can never be
 *    conflated (plan §4.1.10);
 *  - readiness is a pure function of mode + required + store status; only
 *    `enforce + required` with a degraded store blocks the attachments
 *    capability, everything else degrades without blocking (plan §13.1).
 */
import type { AttachmentMetricRateLimitDecision } from './attachments-metrics.js';

// ---------------------------------------------------------------------------
// Sealed unions
// ---------------------------------------------------------------------------

/** The Attachment admission route classes (plan §2.2.1; `status` added by FIX-L-051, KA-P4-AM-16). */
export const ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES = Object.freeze([
  'issue', 'complete', 'download', 'status',
] as const);
export type AttachmentRateLimitRouteClass = (typeof ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES)[number];

/** Deployment modes of the distributed limiter (plan §2.2.4, §13.1). */
export const ATTACHMENT_RATE_LIMIT_MODES = Object.freeze([
  'off', 'shadow', 'enforce',
] as const);
export type AttachmentRateLimitMode = (typeof ATTACHMENT_RATE_LIMIT_MODES)[number];

/**
 * Stable infrastructure failure classes. `exhausted` is deliberately NOT
 * here: quota exhaustion is a denied DECISION (429), never a failure class
 * (plan §4.1.10 mutation "Redis outage 被映射为 429").
 */
export const RATE_LIMIT_FAILURE_CLASSES = Object.freeze([
  'unavailable', 'timeout', 'malformed', 'acl', 'internal',
] as const);
export type RateLimitFailureClass = (typeof RATE_LIMIT_FAILURE_CLASSES)[number];

// ---------------------------------------------------------------------------
// Decision / failure / subject shapes
// ---------------------------------------------------------------------------

/**
 * The fixed-window admission decision returned by the store (plan §2.3):
 * `allowed`, `remaining`, `retryAfterSeconds` (ceil to window rollover, 0 at
 * rollover) and `windowStartEpochMs` (fixed floor rounding). All numbers are
 * non-negative safe integers; `assertAttachmentRateLimitDecision` enforces
 * the shape fail-closed.
 */
export interface AttachmentRateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly windowStartEpochMs: number;
}

export function assertAttachmentRateLimitDecision(decision: AttachmentRateLimitDecision): void {
  if (typeof decision.allowed !== 'boolean') throw new RangeError('rate_limit_decision_allowed_invalid');
  if (!Number.isSafeInteger(decision.remaining) || decision.remaining < 0) {
    throw new RangeError('rate_limit_decision_remaining_invalid');
  }
  if (!Number.isSafeInteger(decision.retryAfterSeconds) || decision.retryAfterSeconds < 0) {
    throw new RangeError('rate_limit_decision_retry_after_invalid');
  }
  if (!Number.isSafeInteger(decision.windowStartEpochMs) || decision.windowStartEpochMs < 0) {
    throw new RangeError('rate_limit_decision_window_start_invalid');
  }
}

/** Stable machine failure; `code` is a fixed token, never provider/SDK text. */
export interface RateLimitFailure {
  readonly class: RateLimitFailureClass;
  readonly code: string;
}

/**
 * Rate-limit subject: the authenticated principal plus its tenant/collection
 * scope. Anonymous requests are rejected by the authorization layer BEFORE
 * they can reach the store (plan §2.3: no high-cardinality keys for
 * unauthenticated input); the raw values never appear in keys, logs or
 * metrics (they only enter the HMAC codec).
 */
export interface RateLimitSubject {
  readonly principalId: string;
  readonly scope: string;
}

export interface RateLimitCheckInput {
  readonly routeClass: AttachmentRateLimitRouteClass;
  readonly subject: RateLimitSubject;
  /**
   * Epoch ms of the decision window. The RL03 adapter must use Redis server
   * time (never host time) so replicas share one window; the field exists so
   * pure application code and tests stay deterministic.
   */
  readonly nowEpochMs?: number;
}

export type RateLimitStoreOutcome =
  | { readonly kind: 'allowed'; readonly decision: AttachmentRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: AttachmentRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: RateLimitFailure };

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type RateLimitStoreReadinessStatus = 'healthy' | 'degraded';
export type RateLimitStoreReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

/** Store-level readiness fact; the evaluator below turns it into policy. */
export interface RateLimitStoreReadiness {
  readonly status: RateLimitStoreReadinessStatus;
  readonly reason: RateLimitStoreReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

/** Fail-closed shape guard: unknown status/reason/timestamp are rejected. */
export function assertRateLimitStoreReadinessShape(readiness: RateLimitStoreReadiness): void {
  if (readiness.status !== 'healthy' && readiness.status !== 'degraded') {
    throw new RangeError('rate_limit_store_readiness_status_invalid');
  }
  const reasons: readonly RateLimitStoreReadinessReason[] = [
    'none', 'connecting', 'last_command_failed', 'closed',
  ];
  if (!reasons.includes(readiness.reason)) {
    throw new RangeError('rate_limit_store_readiness_reason_invalid');
  }
  if (!Number.isSafeInteger(readiness.lastCheckedAtEpochMs) || readiness.lastCheckedAtEpochMs < 0) {
    throw new RangeError('rate_limit_store_readiness_last_checked_invalid');
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The independent distributed rate-limit storage port (plan §2.2.5). It is
 * completely orthogonal to the Publication `CacheStore`: separate client,
 * ACL, key namespace, command budget, readiness and fail strategy, and the
 * Publication cache mode (`off|shadow|serve`) must never disable Attachment
 * rate limiting. The domain layer only ever sees this structural interface
 * — no ioredis types.
 */
export interface RateLimitStore {
  check(input: RateLimitCheckInput): Promise<RateLimitStoreOutcome>;
  readiness(): RateLimitStoreReadiness;
  close(): Promise<void>;
}

/**
 * The route-facing admission facade (composed in RL04). The mode is part of
 * every outcome so `off|shadow|enforce` semantics stay observable and
 * metrics/logs stay fixed-label (plan §13.2).
 */
export type AttachmentAdmissionOutcome =
  | {
    readonly kind: 'allowed';
    readonly mode: AttachmentRateLimitMode;
    readonly decision: AttachmentRateLimitDecision;
  }
  | {
    readonly kind: 'denied';
    readonly mode: AttachmentRateLimitMode;
    readonly decision: AttachmentRateLimitDecision;
  }
  | {
    readonly kind: 'unavailable';
    readonly mode: AttachmentRateLimitMode;
    readonly failure: RateLimitFailure;
  }
  | {
    readonly kind: 'fallback';
    readonly mode: AttachmentRateLimitMode;
    readonly decision: AttachmentRateLimitDecision;
    readonly failure: RateLimitFailure;
  };

export interface AttachmentAdmissionRateLimiter {
  readonly mode: AttachmentRateLimitMode;
  checkAdmission(input: RateLimitCheckInput): Promise<AttachmentAdmissionOutcome>;
  readiness(): RateLimitStoreReadiness;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Readiness evaluation (pure)
// ---------------------------------------------------------------------------

export type AttachmentRateLimitReadinessStatus = 'healthy' | 'degraded';
export type AttachmentRateLimitReadinessReason = 'none' | 'redis_unavailable';

export interface AttachmentRateLimitReadinessVerdict {
  readonly status: AttachmentRateLimitReadinessStatus;
  /**
   * True only for `enforce + required` with a degraded store: the attachments
   * capability must be not-ready (plan §13.1 step 3/4). Shadow and optional
   * enforce degrade without blocking.
   */
  readonly blocksAttachments: boolean;
  readonly reason: AttachmentRateLimitReadinessReason;
}

export interface AttachmentRateLimitReadinessInput {
  readonly mode: AttachmentRateLimitMode;
  readonly required: boolean;
  readonly storeStatus: RateLimitStoreReadinessStatus;
}

export function evaluateAttachmentRateLimitReadiness(
  input: AttachmentRateLimitReadinessInput,
): AttachmentRateLimitReadinessVerdict {
  if (input.mode === 'off') {
    return Object.freeze({ status: 'healthy', blocksAttachments: false, reason: 'none' });
  }
  if (input.storeStatus === 'healthy') {
    return Object.freeze({ status: 'healthy', blocksAttachments: false, reason: 'none' });
  }
  const blocksAttachments = input.mode === 'enforce' && input.required === true;
  return Object.freeze({ status: 'degraded', blocksAttachments, reason: 'redis_unavailable' });
}

// ---------------------------------------------------------------------------
// Fixed-label metric mapping (RL01 sealed dimension)
// ---------------------------------------------------------------------------

/**
 * Maps an admission outcome onto the RL01-sealed `rateLimitDecision` metric
 * dimension (`none|allowed|denied|unavailable|fallback`). Only the fixed
 * four kinds can ever be recorded; no principal/route/mode value enters the
 * counter space.
 */
export function admissionOutcomeMetricDecision(outcome: {
  readonly kind: AttachmentAdmissionOutcome['kind'];
}): AttachmentMetricRateLimitDecision {
  switch (outcome.kind) {
    case 'allowed': return 'allowed';
    case 'denied': return 'denied';
    case 'unavailable': return 'unavailable';
    case 'fallback': return 'fallback';
  }
}
