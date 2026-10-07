/**
 * P4A-I10 bounded per-principal delivery admission rate limiter.
 *
 * A small deterministic fixed-window limiter: the window is derived from the
 * injected monotonic/test clock (never `Date.now()` inside the limiter), and
 * memory is bounded by `maxTrackedPrincipals`. Old windows are pruned on each
 * admission and, when the cap is still reached, the oldest inserted bucket is
 * evicted first (Map insertion order), so state can never grow without bound.
 * The limiter is process-local and documented as such; it gates admission
 * attempts BEFORE any database work (an anonymous request has no principal and
 * is denied without consulting the limiter).
 */
export const DELIVERY_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DELIVERY_RATE_LIMIT_MAX_PER_WINDOW = 30;
export const DELIVERY_RATE_LIMIT_MAX_TRACKED_PRINCIPALS = 4_096;

export interface DeliveryRateLimitPolicy {
  readonly windowSeconds: number;
  readonly maxPerWindow: number;
  readonly maxTrackedPrincipals: number;
}

export const DEFAULT_DELIVERY_RATE_LIMIT_POLICY: DeliveryRateLimitPolicy = Object.freeze({
  windowSeconds: DELIVERY_RATE_LIMIT_WINDOW_SECONDS,
  maxPerWindow: DELIVERY_RATE_LIMIT_MAX_PER_WINDOW,
  maxTrackedPrincipals: DELIVERY_RATE_LIMIT_MAX_TRACKED_PRINCIPALS,
});

export interface DeliveryRateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the current window rolls over; 0 when allowed. */
  readonly retryAfterSeconds: number;
  /** Start of the current fixed window (epoch ms) for deterministic tests. */
  readonly windowStartEpochMs: number;
}

export interface DeliveryRateLimiter {
  check(principalId: string, now: Date): DeliveryRateLimitDecision;
  /** Number of tracked buckets (bounded by `maxTrackedPrincipals`). */
  trackedCount(): number;
}

interface DeliveryRateBucket {
  readonly windowStartMs: number;
  count: number;
}

function validatePolicy(policy: DeliveryRateLimitPolicy): void {
  if (!Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
    throw new RangeError('delivery_rate_limit_window_invalid');
  }
  if (!Number.isSafeInteger(policy.maxPerWindow) || policy.maxPerWindow < 1) {
    throw new RangeError('delivery_rate_limit_budget_invalid');
  }
  if (!Number.isSafeInteger(policy.maxTrackedPrincipals) || policy.maxTrackedPrincipals < 1) {
    throw new RangeError('delivery_rate_limit_capacity_invalid');
  }
}

export function createDeliveryRateLimiter(policy: DeliveryRateLimitPolicy = DEFAULT_DELIVERY_RATE_LIMIT_POLICY): DeliveryRateLimiter {
  validatePolicy(policy);
  // The window start lives in the bucket value: prune must never re-parse the
  // composite key, because a principal id may itself contain colons.
  const counts = new Map<string, DeliveryRateBucket>();
  const windowMs = policy.windowSeconds * 1_000;

  function pruneExpired(currentWindowStartMs: number): void {
    const oldestKeptWindowMs = currentWindowStartMs - windowMs;
    for (const [key, bucket] of [...counts.entries()]) {
      if (bucket.windowStartMs < oldestKeptWindowMs) counts.delete(key);
    }
  }

  return {
    check(principalId, now) {
      const nowMs = now.getTime();
      const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
      const key = `${principalId}:${windowStartMs}`;
      const current = counts.get(key);
      if (current !== undefined && current.count >= policy.maxPerWindow) {
        const windowEndMs = windowStartMs + windowMs;
        const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1_000));
        return { allowed: false, retryAfterSeconds, windowStartEpochMs: windowStartMs };
      }
      if (current === undefined) {
        pruneExpired(windowStartMs);
        if (counts.size >= policy.maxTrackedPrincipals) {
          // Evict the oldest inserted bucket first (Map iteration order).
          const oldest = counts.keys().next().value as string | undefined;
          if (oldest !== undefined) counts.delete(oldest);
        }
      }
      counts.set(key, { windowStartMs, count: (current?.count ?? 0) + 1 });
      return { allowed: true, retryAfterSeconds: 0, windowStartEpochMs: windowStartMs };
    },
    trackedCount() {
      return counts.size;
    },
  };
}

/**
 * P4A-RL04 permissive local limiter for the download use case.
 *
 * When the RL04 route facade is composed it owns the bounded local reference
 * decision for the download route (off/shadow modes consume exactly one I10
 * attempt BEFORE any database work) and Redis decides in enforce mode, so
 * the use case must never consume a second attempt: the composition passes
 * this always-allowed limiter into `authorizeOwnerDownload`. Compositions
 * WITHOUT the facade (P08 legacy/evidence) keep the real I10 limiter inside
 * the use case unchanged.
 */
export function createPermissiveDeliveryRateLimiter(): DeliveryRateLimiter {
  return Object.freeze({
    check: () => Object.freeze({ allowed: true, retryAfterSeconds: 0, windowStartEpochMs: 0 }),
    trackedCount: () => 0,
  });
}
