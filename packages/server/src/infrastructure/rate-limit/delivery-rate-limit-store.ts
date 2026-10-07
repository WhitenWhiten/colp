/**
 * FIX-L-049 delivery request-limit adapters for the FIX-L-049
 * `DeliveryRequestLimiter` port (audit KA-P4-AM-14).
 *
 * Two implementations of ONE port:
 *
 *  - `createMemoryDeliveryRequestLimiter` — the bounded in-process
 *    fixed-window adapter (single-instance deployments and tests; the
 *    default every delivery host composition falls back to). Buckets are
 *    capped (`maxBuckets`); at capacity a NEW subject is denied instead of
 *    evicting a live bucket; expired windows are swept on a bounded
 *    interval. Bucket keys are plain SHA-256 digests of the canonical
 *    subject, so the RAW capability token (a bearer secret) is never
 *    retained even transiently in limiter state; the map is process-local,
 *    never logged and never serialized. Per-process budgets mean
 *    multi-replica deployments MUST inject the shared Redis adapter (or
 *    WAF/CDN edge control).
 *  - `createRedisDeliveryRequestLimiter` — the shared multi-replica
 *    adapter. It reuses the RL03 fixed-window Lua script (Redis SERVER-time
 *    windows + atomic INCR + first-write-only PEXPIRE, NOSCRIPT
 *    reload/retry), the independent bounded ioredis wrapper, the
 *    consecutive-failure circuit breaker and the stable failure
 *    classification — but keys are built through the DELIVERY codec
 *    (`{dlv:<factsHmac>}` hash tag, sealed `ip`/`token` policies) and never
 *    share a key prefix/namespace with the auth, Search, MCP or Attachment
 *    limiters.
 *
 * Fail-closed contract (same as RL03/MCP):
 *  - quota exhaustion is a DENIED decision (fixed 429 with Retry-After) —
 *    never a failure class;
 *  - every Redis failure (unavailable/timeout/malformed/acl/internal) is a
 *    FAILED outcome that the delivery route maps to an explicit 503 — a
 *    limiter outage must never silently admit unlimited traffic;
 *  - `denied` and `failed` can never be conflated;
 *  - the raw client IP and the raw capability token (a bearer secret) never
 *    reach a Redis key, log, metric or error; the in-memory adapter retains
 *    only a plain digest of the subject.
 */
import { createHash } from 'node:crypto';
import type {
  DeliveryRequestLimitBudget,
  DeliveryRequestLimiter,
  DeliveryRequestRateLimitDecision,
  DeliveryRequestRateLimitOutcome,
  DeliveryRequestRateLimitPolicy,
  DeliveryRequestRateLimitReadiness,
  DeliveryRequestRateLimitSubject,
} from '../../modules/attachments/index.js';
import {
  DELIVERY_REQUEST_LIMIT_IP_MAX_DEFAULT,
  DELIVERY_REQUEST_LIMIT_IP_WINDOW_MS_DEFAULT,
  DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT,
  DELIVERY_REQUEST_LIMIT_TOKEN_WINDOW_MS_DEFAULT,
  assertDeliveryRequestLimitBudget,
} from '../../modules/attachments/index.js';
import {
  buildDeliveryRateLimitKey,
  assertDeliveryRateLimitSubject,
} from './delivery-rate-limit-key-codec.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

// ---------------------------------------------------------------------------
// In-memory adapter (single-instance default)
// ---------------------------------------------------------------------------

export interface MemoryDeliveryRequestLimiterOptions {
  /**
   * Trusted-IP flood budget; defaults to `DELIVERY_REQUEST_LIMIT_IP_MAX_DEFAULT`
   * when NO options are given at all. If any option is configured, a policy
   * left unset fails closed (never an implicit allow-all).
   */
  readonly ip?: DeliveryRequestLimitBudget;
  /**
   * Per-token replay budget; defaults to `DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT`
   * when NO options are given at all. If any option is configured, a policy
   * left unset fails closed (never an implicit allow-all).
   */
  readonly token?: DeliveryRequestLimitBudget;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Hard cap on tracked buckets per policy (default 100_000). At capacity a
   * request for a NEW subject is denied; live buckets are never evicted and
   * existing subjects keep their budgets (same overload policy as
   * FIX-M-018).
   */
  readonly maxBuckets?: number;
  /** Minimum interval between TTL sweeps (default 60s). */
  readonly sweepIntervalMs?: number;
}

export interface MemoryDeliveryRequestLimiter extends DeliveryRequestLimiter {
  /** Test helper: clear all policy buckets and reset counters. */
  reset(): void;
  /** Test helper: total tracked buckets across policies (approximate). */
  size(): number;
}

const DEFAULT_MEMORY_MAX_BUCKETS = 100_000;
const DEFAULT_MEMORY_SWEEP_INTERVAL_MS = 60_000;

/**
 * Canonical in-memory bucket key: a plain SHA-256 digest of the sealed
 * policy + the validated subject facts. The RAW capability token (a bearer
 * secret) is therefore never retained in limiter state — only its digest
 * (not reversible for a high-entropy I10 capability); the digest is
 * deterministic so one subject maps to one bucket. No secret is needed: the
 * in-memory map is process-local and never serialized, so a keyed HMAC
 * would add nothing.
 */
function memoryBucketKey(policy: DeliveryRequestRateLimitPolicy, facts: string): string {
  return createHash('sha256')
    .update(policy)
    .update('\u0000')
    .update(facts, 'utf8')
    .digest('hex');
}

interface CounterBucket {
  count: number;
  resetAt: number;
}

/** Bounded fixed-window counter core (same semantics as the FIX-M-018 limiter). */
class MemoryCounterBuckets {
  private readonly buckets = new Map<string, CounterBucket>();
  private lastSweepAt: number;

  constructor(
    private readonly maxBuckets: number,
    private readonly sweepIntervalMs: number,
    private readonly now: () => number,
  ) {
    this.lastSweepAt = now();
  }

  consume(facts: string, maxRequests: number, windowMs: number, nowMs: number): DeliveryRequestRateLimitDecision {
    if (nowMs - this.lastSweepAt >= this.sweepIntervalMs) {
      this.lastSweepAt = nowMs;
      for (const [key, bucket] of this.buckets) {
        if (nowMs >= bucket.resetAt) this.buckets.delete(key);
      }
    }
    let bucket = this.buckets.get(facts);
    if (bucket === undefined || nowMs >= bucket.resetAt) {
      if (bucket === undefined && this.buckets.size >= this.maxBuckets) {
        // Overload policy: refuse the new subject instead of evicting a live
        // bucket. The map is non-empty here (size >= maxBuckets >= 1).
        let earliestResetAt = Number.POSITIVE_INFINITY;
        for (const existing of this.buckets.values()) {
          if (existing.resetAt < earliestResetAt) earliestResetAt = existing.resetAt;
        }
        return deniedDecision(Math.max(1, Math.ceil((earliestResetAt - nowMs) / 1000)));
      }
      bucket = { count: 0, resetAt: nowMs + windowMs };
      this.buckets.set(facts, bucket);
    }
    if (bucket.count >= maxRequests) {
      return deniedDecision(Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)));
    }
    bucket.count += 1;
    return allowedDecision();
  }

  reset(): void {
    this.buckets.clear();
    this.lastSweepAt = this.now();
  }

  size(): number {
    return this.buckets.size;
  }
}

/**
 * Factory (no global singleton): each delivery host composition owns and
 * closes its own in-memory adapter. With NO options the module default
 * budgets apply (the always-on single-instance default used by host
 * compositions: 600 IP requests/min + 120 token requests/min). Once ANY
 * option is given, a policy that is not configured fails closed (internal
 * failure) — never an implicit allow-all.
 */
export function createMemoryDeliveryRequestLimiter(
  options: MemoryDeliveryRequestLimiterOptions = {},
): MemoryDeliveryRequestLimiter {
  if (options.ip !== undefined) assertDeliveryRequestLimitBudget('ip', options.ip);
  if (options.token !== undefined) assertDeliveryRequestLimitBudget('token', options.token);
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('delivery memory rate limiter now must be a function when provided');
  }
  const now = options.now ?? Date.now;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MEMORY_MAX_BUCKETS;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new Error('delivery memory rate limiter maxBuckets must be a positive safe integer');
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_MEMORY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new Error('delivery memory rate limiter sweepIntervalMs must be a positive safe integer');
  }
  // No options at all -> the module default budgets (the production default
  // composition relies on this). Partial configuration keeps every unset
  // policy fail-closed, so a forgotten policy can never become allow-all.
  const bothUnset = options.ip === undefined && options.token === undefined;
  const ipBudget = bothUnset
    ? Object.freeze({
        maxRequests: DELIVERY_REQUEST_LIMIT_IP_MAX_DEFAULT,
        windowMs: DELIVERY_REQUEST_LIMIT_IP_WINDOW_MS_DEFAULT,
      })
    : options.ip;
  const tokenBudget = bothUnset
    ? Object.freeze({
        maxRequests: DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT,
        windowMs: DELIVERY_REQUEST_LIMIT_TOKEN_WINDOW_MS_DEFAULT,
      })
    : options.token;
  const ipBuckets = new MemoryCounterBuckets(maxBuckets, sweepIntervalMs, now);
  const tokenBuckets = new MemoryCounterBuckets(maxBuckets, sweepIntervalMs, now);

  return Object.freeze({
    async consume(subject: DeliveryRequestRateLimitSubject): Promise<DeliveryRequestRateLimitOutcome> {
      try {
        assertDeliveryRateLimitSubject(subject.policy, subject.facts);
      } catch {
        return failedOutcome('internal', 'rate_limit_invalid_input');
      }
      const nowMs = now();
      if (subject.policy === 'ip') {
        if (ipBudget === undefined) return failedOutcome('internal', 'rate_limit_policy_unconfigured');
        return decisionOutcome(ipBuckets.consume(
          memoryBucketKey(subject.policy, subject.facts),
          ipBudget.maxRequests,
          ipBudget.windowMs,
          nowMs,
        ));
      }
      if (tokenBudget === undefined) return failedOutcome('internal', 'rate_limit_policy_unconfigured');
      return decisionOutcome(tokenBuckets.consume(
        memoryBucketKey(subject.policy, subject.facts),
        tokenBudget.maxRequests,
        tokenBudget.windowMs,
        nowMs,
      ));
    },
    readiness(): DeliveryRequestRateLimitReadiness {
      return Object.freeze({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: now() });
    },
    async close(): Promise<void> {
      // The in-memory adapter owns no external resources.
    },
    reset() {
      ipBuckets.reset();
      tokenBuckets.reset();
    },
    size() {
      return ipBuckets.size() + tokenBuckets.size();
    },
  });
}

// ---------------------------------------------------------------------------
// Redis adapter (shared multi-replica)
// ---------------------------------------------------------------------------

export interface RedisDeliveryRequestLimiterOptions {
  /** redis:// or rediss:// endpoint (validated by config, fail-closed). */
  readonly redisUrl: string;
  /** Key codec environment token (nodeEnv); 1-64 chars, no colon. */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never serialized). */
  readonly keySecret: Buffer;
  /** Redis key namespace prefix (delivery codec); default 'known'. */
  readonly keyPrefix?: string;
  /** Trusted-IP flood budget (per direct peer IP). */
  readonly ip: DeliveryRequestLimitBudget;
  /** Per-token replay budget (GET/HEAD share it; Range never opens another). */
  readonly token: DeliveryRequestLimitBudget;
  /** Per-command timeout (ms); bounded. */
  readonly commandTimeoutMs: number;
  /** Connect timeout (ms); bounded. */
  readonly connectTimeoutMs: number;
  /** Bounded retries per request. */
  readonly maxRetriesPerRequest: number;
  /** Test seam: replace the real ioredis client with a scripted fake. */
  readonly createClient?: RateLimitRedisClientFactory;
  /**
   * Injectable host clock; used ONLY as the codec window seed and readiness
   * timestamps — the authoritative window identity comes from Redis server
   * time inside the Lua script.
   */
  readonly now?: () => number;
  /** Circuit breaker: consecutive failures that open it (default 3). */
  readonly failureThreshold?: number;
  /** Circuit breaker: cooldown before a half-open probe (default 1000ms). */
  readonly cooldownMs?: number;
  /** Graceful-close budget (default RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS). */
  readonly closeTimeoutMs?: number;
}

/**
 * Factory (no global singleton): each delivery composition owns and closes
 * its own store. Fail-closed construction: a missing URL / empty secret /
 * empty environment token / invalid budgets are programmer errors.
 */
export function createRedisDeliveryRequestLimiter(
  options: RedisDeliveryRequestLimiterOptions,
): DeliveryRequestLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisDeliveryRequestLimiter requires a Redis URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisDeliveryRequestLimiter requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisDeliveryRequestLimiter requires a non-empty environment token');
  }
  assertDeliveryRequestLimitBudget('ip', options.ip);
  assertDeliveryRequestLimitBudget('token', options.token);
  if (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 1) {
    throw new Error('createRedisDeliveryRequestLimiter commandTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1) {
    throw new Error('createRedisDeliveryRequestLimiter connectTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisDeliveryRequestLimiter maxRetriesPerRequest must be a non-negative safe integer');
  }

  const inner = createRedisFixedWindowStore<DeliveryRequestRateLimitSubject>({
    redisUrl: options.redisUrl,
    commandTimeoutMs: options.commandTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    createClient: options.createClient,
    now: options.now,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
    closeTimeoutMs: options.closeTimeoutMs,
    resolveAdmission: (subject, nowMs) => {
      assertDeliveryRateLimitSubject(subject.policy, subject.facts);
      const budget = subject.policy === 'ip' ? options.ip : options.token;
      return {
        key: buildDeliveryRateLimitKey({
          keyPrefix: options.keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          policy: subject.policy,
          facts: subject.facts,
          windowStartEpochMs: Math.floor(nowMs / budget.windowMs) * budget.windowMs,
        }),
        rateMax: budget.maxRequests,
        windowMs: budget.windowMs,
      };
    },
  });

  return {
    consume: async (subject) => mapFrozenQuotaOutcome(await inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds })),
    readiness: () => inner.readiness(),
    close: () => inner.close(),
  };
}

function allowedDecision(): DeliveryRequestRateLimitDecision {
  return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
}

function deniedDecision(retryAfterSeconds: number): DeliveryRequestRateLimitDecision {
  return Object.freeze({ allowed: false, retryAfterSeconds });
}

function decisionOutcome(decision: DeliveryRequestRateLimitDecision): DeliveryRequestRateLimitOutcome {
  return decision.allowed
    ? Object.freeze({ kind: 'allowed', decision })
    : Object.freeze({ kind: 'denied', decision });
}

function failedOutcome(
  failureClass: 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal',
  code: string,
): DeliveryRequestRateLimitOutcome {
  return Object.freeze({ kind: 'failed', failure: Object.freeze({ class: failureClass, code }) });
}
