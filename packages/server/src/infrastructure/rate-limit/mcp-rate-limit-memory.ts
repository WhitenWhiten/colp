/**
 * In-process MCP rate-limit adapter (transports/tests and single-instance
 * deployments). Production multi-replica compositions inject
 * `createRedisMcpRateLimitStore` instead.
 */
import {
  assertMcpRateLimitCommitConfig,
  assertMcpRateLimitPolicyConfig,
  type McpRateLimitCommitConfig,
  type McpRateLimitDecision,
  type McpRateLimitFailureClass,
  type McpRateLimiter,
  type McpRateLimitOutcome,
  type McpRateLimitPolicyConfig,
  type McpRateLimitReadiness,
  type McpRateLimitSubject,
} from './mcp-rate-limit-store.js';
import {
  assertMcpRateLimitDistinctElement,
  assertMcpRateLimitFacts,
} from './mcp-rate-limit-key-codec.js';

export interface MemoryMcpRateLimiterOptions {
  readonly request?: McpRateLimitPolicyConfig;
  readonly approval?: McpRateLimitPolicyConfig;
  readonly commit?: McpRateLimitCommitConfig;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Hard cap on tracked buckets per policy (default 100_000). At capacity a
   * request for a NEW key is denied; live buckets are never evicted and
   * existing keys keep their budgets (same overload policy as FIX-M-002).
   */
  readonly maxBuckets?: number;
  /** Minimum interval between TTL sweeps (default 60s). */
  readonly sweepIntervalMs?: number;
}

export interface MemoryMcpRateLimiter extends McpRateLimiter {
  /** Test helper: clear all policy buckets and reset counters. */
  reset(): void;
  /** Test helper: total tracked buckets across policies (approximate). */
  size(): number;
}

const DEFAULT_MEMORY_MAX_BUCKETS = 100_000;
const DEFAULT_MEMORY_SWEEP_INTERVAL_MS = 60_000;

interface CounterBucket {
  count: number;
  resetAt: number;
}

/** Bounded fixed-window counter core (same semantics as the FIX-M-002 limiter). */
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

  consume(facts: string, maxRequests: number, windowMs: number, nowMs: number): McpRateLimitDecision {
    if (nowMs - this.lastSweepAt >= this.sweepIntervalMs) {
      this.lastSweepAt = nowMs;
      for (const [key, bucket] of this.buckets) {
        if (nowMs >= bucket.resetAt) this.buckets.delete(key);
      }
    }
    let bucket = this.buckets.get(facts);
    if (bucket === undefined || nowMs >= bucket.resetAt) {
      if (bucket === undefined && this.buckets.size >= this.maxBuckets) {
        // Overload policy: refuse the new key instead of evicting a live
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

interface DistinctPlanBucket {
  resetAt: number;
  planIds: Set<string>;
}

/** Bounded distinct-plan bucket core (identical semantics to the in-process commit port). */
class MemoryDistinctPlanBuckets {
  private readonly buckets = new Map<string, DistinctPlanBucket>();
  private lastSweepAt: number;

  constructor(
    private readonly maxBuckets: number,
    private readonly sweepIntervalMs: number,
    private readonly now: () => number,
  ) {
    this.lastSweepAt = now();
  }

  consume(facts: string, maxPlans: number, windowMs: number, planId: string, nowMs: number): McpRateLimitDecision {
    if (nowMs - this.lastSweepAt >= this.sweepIntervalMs) {
      this.lastSweepAt = nowMs;
      for (const [key, bucket] of this.buckets) {
        if (nowMs >= bucket.resetAt) this.buckets.delete(key);
      }
    }
    let bucket = this.buckets.get(facts);
    if (bucket === undefined || nowMs >= bucket.resetAt) {
      if (bucket === undefined && this.buckets.size >= this.maxBuckets) {
        let earliestResetAt = Number.POSITIVE_INFINITY;
        for (const existing of this.buckets.values()) {
          if (existing.resetAt < earliestResetAt) earliestResetAt = existing.resetAt;
        }
        return deniedDecision(Math.max(1, Math.ceil((earliestResetAt - nowMs) / 1000)));
      }
      bucket = { resetAt: nowMs + windowMs, planIds: new Set() };
      this.buckets.set(facts, bucket);
    }
    if (bucket.planIds.has(planId)) return allowedDecision();
    if (bucket.planIds.size >= maxPlans) {
      return deniedDecision(Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)));
    }
    bucket.planIds.add(planId);
    return allowedDecision();
  }

  reset(): void {
    this.buckets.clear();
    this.lastSweepAt = this.now();
  }

  size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.planIds.size;
    return total;
  }
}

/**
 * Factory (no global singleton): each composition owns and closes its own
 * in-memory adapter. A policy that is not configured fails closed (internal
 * failure) — never an implicit allow-all.
 */
export function createMemoryMcpRateLimiter(options: MemoryMcpRateLimiterOptions = {}): MemoryMcpRateLimiter {
  if (options.request !== undefined) assertMcpRateLimitPolicyConfig('request', options.request);
  if (options.approval !== undefined) assertMcpRateLimitPolicyConfig('approval', options.approval);
  if (options.commit !== undefined) assertMcpRateLimitCommitConfig(options.commit);
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('MCP memory rate limiter now must be a function when provided');
  }
  const now = options.now ?? Date.now;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MEMORY_MAX_BUCKETS;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new Error('MCP memory rate limiter maxBuckets must be a positive safe integer');
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_MEMORY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new Error('MCP memory rate limiter sweepIntervalMs must be a positive safe integer');
  }
  const requestBuckets = new MemoryCounterBuckets(maxBuckets, sweepIntervalMs, now);
  const approvalBuckets = new MemoryCounterBuckets(maxBuckets, sweepIntervalMs, now);
  const commitBuckets = new MemoryDistinctPlanBuckets(maxBuckets, sweepIntervalMs, now);

  return Object.freeze({
    async consume(subject: McpRateLimitSubject): Promise<McpRateLimitOutcome> {
      try {
        assertMcpRateLimitFacts(subject.facts);
      } catch {
        return failedOutcome('internal', 'rate_limit_invalid_input');
      }
      const nowMs = now();
      if (subject.policy === 'request') {
        const config = options.request;
        if (config === undefined) return failedOutcome('internal', 'rate_limit_policy_unconfigured');
        return decisionOutcome(requestBuckets.consume(subject.facts, config.maxRequests, config.windowMs, nowMs));
      }
      if (subject.policy === 'approval') {
        const config = options.approval;
        if (config === undefined) return failedOutcome('internal', 'rate_limit_policy_unconfigured');
        return decisionOutcome(approvalBuckets.consume(subject.facts, config.maxRequests, config.windowMs, nowMs));
      }
      if (subject.policy === 'commit-distinct-plan') {
        const config = options.commit;
        if (config === undefined) return failedOutcome('internal', 'rate_limit_policy_unconfigured');
        const distinct = subject.distinct;
        try {
          assertMcpRateLimitDistinctElement(distinct as string);
        } catch {
          return failedOutcome('internal', 'rate_limit_invalid_input');
        }
        return decisionOutcome(commitBuckets.consume(subject.facts, config.maxPlans, config.windowMs, distinct as string, nowMs));
      }
      return failedOutcome('internal', 'rate_limit_policy_unconfigured');
    },
    readiness(): McpRateLimitReadiness {
      return Object.freeze({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: now() });
    },
    async close(): Promise<void> {
      // The in-memory adapter owns no external resources.
    },
    reset() {
      requestBuckets.reset();
      approvalBuckets.reset();
      commitBuckets.reset();
    },
    size() {
      return requestBuckets.size() + approvalBuckets.size() + commitBuckets.size();
    },
  });
}

function allowedDecision(): McpRateLimitDecision {
  return Object.freeze({ allowed: true, retryAfterSeconds: 0 });
}

function deniedDecision(retryAfterSeconds: number): McpRateLimitDecision {
  return Object.freeze({ allowed: false, retryAfterSeconds });
}

function decisionOutcome(decision: McpRateLimitDecision): McpRateLimitOutcome {
  return decision.allowed
    ? Object.freeze({ kind: 'allowed', decision })
    : Object.freeze({ kind: 'denied', decision });
}

function failedOutcome(failureClass: McpRateLimitFailureClass, code: string): McpRateLimitOutcome {
  return Object.freeze({ kind: 'failed', failure: Object.freeze({ class: failureClass, code }) });
}
