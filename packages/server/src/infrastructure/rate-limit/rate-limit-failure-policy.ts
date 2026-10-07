/**
 * P4A-RL03 route-specific failure policy (plan §2.2.2-§2.2.3, §4.1.10, §8
 * RL03: "该策略作为纯函数/纯模块实现，不依赖 Redis 客户端").
 *
 * A PURE module (no Redis client, no timers, no I/O) that decides what an
 * infrastructure FAILURE means per route class — `exhausted` is a quota
 * DECISION (429) and is deliberately never routed through this policy:
 *
 *  - `issue` / `download` fail closed -> `unavailable` (503) and no
 *    fabricated quota facts (plan §2.2.2);
 *  - `complete` is the recovery entry for already-uploaded objects: it keeps
 *    serving through the BOUNDED in-process emergency limiter whose budget is
 *    the RL02 `completeEmergency` policy (default 15/60000, hard ceiling
 *    1000), reports `fallback` while the budget lasts, and `fallback_denied`
 *    (a real local quota fact) once the emergency budget is exhausted (plan
 *    §2.2.3, §4.2.7); the emergency limiter never admits unbounded subjects —
 *    its map is bounded and at capacity it fails closed.
 *
 * Every decision is REPLAYABLE with an injected clock, which is exactly how
 * the RL03 unit suite pins budget exhaustion, window rollover and the
 * issue/download vs complete split.
 */
import type {
  AttachmentAdmissionOutcome,
  AttachmentRateLimitConfig,
  AttachmentRateLimitDecision,
  AttachmentRateLimitMode,
  AttachmentRateLimitRouteClass,
  RateLimitFailure,
} from '../../modules/attachments/index.js';
import {
  RATE_LIMIT_FAILURE_CLASSES,
  assertAttachmentRateLimitDecision,
} from '../../modules/attachments/index.js';
import {
  emergencyFallbackPolicy,
  retryAfterSecondsFor,
  windowStartFor,
  type AttachmentRouteRatePolicy,
} from '../../modules/attachments/index.js';

/** Bounded emergency map size: a long-running process cannot grow memory without bound. */
export const RATE_LIMIT_EMERGENCY_MAX_SUBJECTS = 4_096;
/** Emergency subject key length bound (the codec-built key prefix is far below this). */
const EMERGENCY_SUBJECT_KEY_MAX_LENGTH = 512;

export type EmergencyRateLimitReason = 'within_budget' | 'exhausted' | 'at_capacity';

export interface EmergencyRateLimitResult {
  readonly allowed: boolean;
  readonly reason: EmergencyRateLimitReason;
  readonly decision: AttachmentRateLimitDecision;
}

/**
 * Bounded in-process fixed-window emergency limiter for `complete` (plan
 * §2.2.3). Per-subject counters in a bounded map; stale windows are replaced
 * or pruned at capacity, and a full map admits no new subject (fail closed).
 */
export class EmergencyRateLimiter {
  private readonly policy: AttachmentRouteRatePolicy;
  private readonly maxSubjects: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, { readonly windowStartEpochMs: number; count: number }>();

  constructor(
    config: AttachmentRateLimitConfig,
    options: { readonly maxSubjects?: number; readonly clock?: () => number } = {},
  ) {
    this.policy = emergencyFallbackPolicy(config);
    this.maxSubjects = options.maxSubjects ?? RATE_LIMIT_EMERGENCY_MAX_SUBJECTS;
    if (!Number.isSafeInteger(this.maxSubjects) || this.maxSubjects < 1) {
      throw new RangeError('emergency limiter maxSubjects must be a positive safe integer');
    }
    this.clock = options.clock ?? (() => Date.now());
  }

  /** The bounded emergency budget (RL02 `completeEmergency` policy). */
  get budget(): AttachmentRouteRatePolicy {
    return this.policy;
  }

  /**
   * Records one attempt for the subject in the current fixed window and
   * returns the emergency decision. `nowEpochMs` is injectable for
   * deterministic replay; the map is bounded (`at_capacity` fails closed).
   */
  check(subjectKey: string, nowEpochMs?: number): EmergencyRateLimitResult {
    if (typeof subjectKey !== 'string' || subjectKey.length === 0 || subjectKey.length > EMERGENCY_SUBJECT_KEY_MAX_LENGTH) {
      throw new RangeError(`emergency limiter subjectKey must be 1-${EMERGENCY_SUBJECT_KEY_MAX_LENGTH} characters`);
    }
    const nowMs = nowEpochMs ?? this.clock();
    const windowStart = windowStartFor(nowMs, this.policy.rateWindowMs);
    const retryAfter = retryAfterSecondsFor(windowStart, this.policy.rateWindowMs, nowMs);

    const entry = this.entries.get(subjectKey);
    if (entry !== undefined) {
      if (entry.windowStartEpochMs === windowStart) {
        entry.count += 1;
        return this.result(entry.count, windowStart, retryAfter);
      }
      // Stale window: replace in place (no map growth).
      this.entries.set(subjectKey, { windowStartEpochMs: windowStart, count: 1 });
      return this.result(1, windowStart, retryAfter);
    }

    if (this.entries.size >= this.maxSubjects) {
      this.pruneExpired(windowStart);
      if (this.entries.size >= this.maxSubjects) {
        return {
          allowed: false,
          reason: 'at_capacity',
          decision: this.deniedDecision(windowStart, retryAfter),
        };
      }
    }
    this.entries.set(subjectKey, { windowStartEpochMs: windowStart, count: 1 });
    return this.result(1, windowStart, retryAfter);
  }

  /** Drops entries whose window has already rolled over (bounded sweep at capacity). */
  private pruneExpired(currentWindowStart: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.windowStartEpochMs < currentWindowStart) this.entries.delete(key);
    }
  }

  private result(count: number, windowStartEpochMs: number, retryAfterSeconds: number): EmergencyRateLimitResult {
    const allowed = count <= this.policy.rateMax;
    return {
      allowed,
      reason: allowed ? 'within_budget' : 'exhausted',
      decision: this.decision(allowed, Math.max(0, this.policy.rateMax - count), retryAfterSeconds, windowStartEpochMs),
    };
  }

  private deniedDecision(windowStartEpochMs: number, retryAfterSeconds: number): AttachmentRateLimitDecision {
    return this.decision(false, 0, retryAfterSeconds, windowStartEpochMs);
  }

  private decision(
    allowed: boolean,
    remaining: number,
    retryAfterSeconds: number,
    windowStartEpochMs: number,
  ): AttachmentRateLimitDecision {
    const decision = Object.freeze({ allowed, remaining, retryAfterSeconds, windowStartEpochMs });
    assertAttachmentRateLimitDecision(decision);
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Route failure policy (pure, replayable)
// ---------------------------------------------------------------------------

/**
 * Verdict of the route-specific failure policy:
 *  - `fail_closed`       -> issue/download (503), or complete at emergency
 *                          capacity (never unbounded admission);
 *  - `fallback_allowed`  -> complete continues through the bounded emergency
 *                          budget (decision = emergency quota fact);
 *  - `fallback_denied`   -> the emergency budget is exhausted: a real local
 *                          quota fact (429) that still carries the Redis
 *                          failure for observability.
 */
export type RouteFailureVerdict =
  | { readonly kind: 'fail_closed'; readonly failure: RateLimitFailure }
  | { readonly kind: 'fallback_allowed'; readonly decision: AttachmentRateLimitDecision; readonly failure: RateLimitFailure }
  | { readonly kind: 'fallback_denied'; readonly decision: AttachmentRateLimitDecision; readonly failure: RateLimitFailure };

export interface RouteFailurePolicyInput {
  readonly routeClass: AttachmentRateLimitRouteClass;
  /** The stable infrastructure failure (never an `exhausted` quota fact). */
  readonly failure: RateLimitFailure;
  /** The bounded in-process emergency limiter for `complete`. */
  readonly emergency: EmergencyRateLimiter;
  /** Subject identity for the emergency budget (codec-built key prefix). */
  readonly subjectKey: string;
  /** Injectable decision time for deterministic replay. */
  readonly nowEpochMs?: number;
}

/**
 * Decides the admission outcome for an infrastructure failure. `issue`,
 * `download` and `status` always fail closed; `complete` falls back through
 * the bounded emergency limiter and reports `fallback`/`fallback_denied`.
 * An unknown route class fails closed at runtime (the sealed union is
 * compile-time).
 */
export function applyRouteFailurePolicy(input: RouteFailurePolicyInput): RouteFailureVerdict {
  if (!RATE_LIMIT_FAILURE_CLASSES.includes(input.failure.class)) {
    throw new RangeError(`unknown rate-limit failure class: ${String(input.failure.class)}`);
  }
  if (input.routeClass !== 'complete') {
    return Object.freeze({ kind: 'fail_closed', failure: input.failure });
  }
  const result = input.emergency.check(input.subjectKey, input.nowEpochMs);
  if (result.allowed) {
    return Object.freeze({ kind: 'fallback_allowed', decision: result.decision, failure: input.failure });
  }
  if (result.reason === 'at_capacity') {
    return Object.freeze({ kind: 'fail_closed', failure: input.failure });
  }
  return Object.freeze({ kind: 'fallback_denied', decision: result.decision, failure: input.failure });
}

/**
 * Maps a failure-policy verdict onto the sealed RL02
 * `AttachmentAdmissionOutcome` kinds (RL04 composition input):
 * `fail_closed` -> `unavailable`, `fallback_allowed` -> `fallback`,
 * `fallback_denied` -> `denied` (the emergency exhaustion is a real local
 * quota fact).
 */
export function routeFailureVerdictToAdmissionOutcome(
  verdict: RouteFailureVerdict,
  mode: AttachmentRateLimitMode,
): AttachmentAdmissionOutcome {
  switch (verdict.kind) {
    case 'fail_closed':
      return Object.freeze({ kind: 'unavailable', mode, failure: verdict.failure });
    case 'fallback_allowed':
      return Object.freeze({ kind: 'fallback', mode, decision: verdict.decision, failure: verdict.failure });
    case 'fallback_denied':
      return Object.freeze({ kind: 'denied', mode, decision: verdict.decision });
  }
}
