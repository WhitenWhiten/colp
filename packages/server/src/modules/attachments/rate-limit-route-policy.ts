/**
 * P4A-RL02 route policy and fixed-window math (plan §2.2.2-§2.2.4, §8 RL02).
 *
 * Pure functions only — no I/O, no framework types, no infrastructure
 * imports. They pin:
 *
 *  - the per-route budgets: issue 30/60000, complete 60/60000, download
 *    30/60000 and status 60/60000 (the FIX-L-051 owner-private read budget,
 *    KA-P4-AM-16), resolved from the config and re-validated
 *    fail-closed against the compile-time ceilings;
 *  - the BOUNDED complete emergency budget (15/60000, ceiling 1000): a Redis
 *    outage can never turn `complete` into an unbounded admission, and the
 *    emergency policy must stay inside its ceiling;
 *  - the fixed window rounding rule (`floor(now / windowMs) * windowMs`) and
 *    the retry-after computation (ceil of seconds to window rollover, 0 at
 *    rollover) that the RL03 Lua adapter and the RL04 composition reuse, so
 *    replicas cannot split windows on host time;
 *  - the exhausted-vs-unavailable outcome classifier: a denied decision is
 *    a quota fact (429), a failed outcome is an infrastructure fact (503 or
 *    the complete emergency fallback) — capturing an arbitrary error and
 *    answering 429 would hide an infrastructure failure (plan §4.1.10).
 */
import type { AttachmentRateLimitConfig } from './rate-limit-config.js';
import {
  ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS,
} from './rate-limit-config.js';
import {
  ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES,
  type AttachmentAdmissionOutcome,
  type AttachmentRateLimitRouteClass,
  type RateLimitStoreOutcome,
} from './rate-limit-contracts.js';

/** One route class resolved to its fixed budget and window. */
export interface AttachmentRouteRatePolicy {
  readonly routeClass: AttachmentRateLimitRouteClass;
  readonly rateMax: number;
  readonly rateWindowMs: number;
}

/**
 * Resolves the fixed policy of one route class. Unknown classes and any
 * budget outside the compile-time ceilings fail closed (a tampered config
 * can never admit an unbounded policy).
 */
export function resolveRouteRatePolicy(
  config: AttachmentRateLimitConfig,
  routeClass: AttachmentRateLimitRouteClass,
): AttachmentRouteRatePolicy {
  if (!ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES.includes(routeClass)) {
    throw new RangeError(`unknown rate-limit route class: ${String(routeClass)}`);
  }
  const route = config.routes[routeClass];
  assertRateLimitPolicyBounded(route.rateMax, route.rateWindowMs, routeClass);
  return Object.freeze({ routeClass, rateMax: route.rateMax, rateWindowMs: route.rateWindowMs });
}

/**
 * The bounded in-process emergency policy for `complete` (plan §2.2.3):
 * when Redis is unavailable the recovery entry keeps serving through a
 * bounded process-local limiter instead of stranding uploaded objects in
 * `issued`/`uploaded`, and it must never exceed its own ceiling.
 */
export function emergencyFallbackPolicy(config: AttachmentRateLimitConfig): AttachmentRouteRatePolicy {
  const emergency = config.completeEmergency;
  if (!Number.isSafeInteger(emergency.rateMax)
    || emergency.rateMax < 1
    || emergency.rateMax > ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING) {
    throw new RangeError(
      `complete emergency rateMax must be a safe integer in 1..${ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING}`,
    );
  }
  if (!Number.isSafeInteger(emergency.rateWindowMs)
    || emergency.rateWindowMs < 1
    || emergency.rateWindowMs > ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS) {
    throw new RangeError(
      `complete emergency rateWindowMs must be a safe integer in 1..${ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS}`,
    );
  }
  return Object.freeze({
    routeClass: 'complete',
    rateMax: emergency.rateMax,
    rateWindowMs: emergency.rateWindowMs,
  });
}

/** Fail-closed boundedness guard for any route/emergency budget. */
export function assertRateLimitPolicyBounded(
  rateMax: number,
  rateWindowMs: number,
  routeClass: string,
): void {
  if (!Number.isSafeInteger(rateMax) || rateMax < 1 || rateMax > ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING) {
    throw new RangeError(
      `rate-limit policy ${routeClass} rateMax must be a safe integer between 1 and ${ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING}`,
    );
  }
  if (!Number.isSafeInteger(rateWindowMs) || rateWindowMs < 1 || rateWindowMs > ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS) {
    throw new RangeError(
      `rate-limit policy ${routeClass} rateWindowMs must be a safe integer between 1 and ${ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS}`,
    );
  }
}

/**
 * Fixed window rounding rule: the window identity is
 * `floor(nowEpochMs / windowMs) * windowMs`. Every replica computes the same
 * window for the same epoch ms (RL03 takes epoch ms from Redis server time).
 */
export function windowStartFor(nowEpochMs: number, windowMs: number): number {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    throw new RangeError('nowEpochMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('windowMs must be a positive safe integer');
  }
  return Math.floor(nowEpochMs / windowMs) * windowMs;
}

/**
 * Seconds until the current window rolls over, rounded UP to whole seconds;
 * 0 once the window has ended (a new window starts). This is the
 * `retryAfterSeconds` contract the decision carries and the 429 header
 * emits.
 */
export function retryAfterSecondsFor(
  windowStartEpochMs: number,
  windowMs: number,
  nowEpochMs: number,
): number {
  if (!Number.isSafeInteger(windowStartEpochMs) || windowStartEpochMs < 0) {
    throw new RangeError('windowStartEpochMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('windowMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    throw new RangeError('nowEpochMs must be a non-negative safe integer');
  }
  const windowEndEpochMs = windowStartEpochMs + windowMs;
  if (nowEpochMs >= windowEndEpochMs) return 0;
  return Math.max(1, Math.ceil((windowEndEpochMs - nowEpochMs) / 1_000));
}

/**
 * Outcome classification for HTTP semantics (plan §4.1.10): a denied
 * decision is `exhausted` (quota fact -> 429); a failed outcome is
 * `unavailable` (infrastructure fact -> 503, or the complete emergency
 * fallback); allowed and the complete emergency fallback proceed.
 */
export function rateLimitOutcomeClass(
  outcome: RateLimitStoreOutcome | AttachmentAdmissionOutcome,
): 'allowed' | 'exhausted' | 'unavailable' {
  if (outcome.kind === 'allowed' || outcome.kind === 'fallback') return 'allowed';
  if (outcome.kind === 'denied') return 'exhausted';
  return 'unavailable';
}
