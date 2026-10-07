/**
 * T05 failure/degradation policy assembly (plan §6.4 T05 / §3.2 / §5): a
 * wrapper around the T04 read-through policy that adds the circuit breaker,
 * shares the fallback bulkhead, records metrics and emits leak-free logs.
 *
 * Behaviour:
 * - Breaker closed: delegate to `readThrough` (T04) unchanged. Redis failure
 *   results (`cache_unavailable` / `lock_unavailable`) trip the breaker; every
 *   touched-Redis non-failure resets the streak.
 * - Breaker open: skip Redis entirely (`touchedRedis=false`, zero commands) and
 *   load from origin under the shared fallback bulkhead. No write-back, no
 *   lock, no meaningless retries. The origin result is `path: 'circuit_open'`.
 * - Half-open: exactly one caller is admitted as the probe (it goes through
 *   Redis); concurrent callers bypass. A successful probe closes the breaker;
 *   a failed probe re-opens it. A probe cancelled by its client releases the
 *   probe slot without counting a failure (and never as a success), so the
 *   next caller re-probes and a real outage is still discovered.
 * - Fallback bulkhead at capacity: both the T04 path and the bypass path return
 *   a controlled `fallback_rejected` (bulkhead_full) result — never an
 *   unbounded wait and never a stale value (serveStale stays false; stale
 *   serving is reserved for an explicitly allowed future non-authority domain).
 * - Logs only carry domain, outcome, duration and an error classification;
 *   raw cache keys, envelopes, values, tokens and URL credentials never reach
 *   the sink (redactCacheLogText is provided as the free-text escape hatch).
 */
import { type Metrics, redactSensitiveText } from '../telemetry/index.js';
import { CACHE_ERROR_CATEGORY, CacheStoreError } from './cache-store.js';
import { isCacheAbortError } from './cache-abort.js';
import { CacheBulkhead, CacheBulkheadError } from './cache-bulkhead.js';
import { CacheCircuitBreaker, type CacheCircuitState } from './cache-circuit-breaker.js';
import {
  classifyCacheReadOutcome,
  cacheResultEntryBytes,
  recordCacheBreakerOpen,
  recordCacheBreakerProbe,
  recordCacheCircuitState,
  recordCacheEntryBytes,
  recordCacheReadLatency,
  recordCacheReadOutcome,
  type CacheMetricsResult,
  type CacheReadOutcome,
} from './cache-metrics.js';
import {
  readThrough,
  type CacheReadDependencies,
  type CacheReadPolicy,
  type ReadThroughResult,
} from './read-through-cache.js';

/** What actually happened for one policy read. */
export interface CachePolicyDecision {
  /** True when Redis commands were actually issued for this read. */
  readonly touchedRedis: boolean;
  /** True when this call was the single half-open probe. */
  readonly probe: boolean;
  readonly circuitState: CacheCircuitState;
}

/** Result of a cache-bypassing origin load while the breaker is open. */
export type CacheBypassResult<T> = (
  | { readonly kind: 'origin'; readonly value: T; readonly path: 'circuit_open' }
  | { readonly kind: 'not_found'; readonly path: 'circuit_open' }
  | { readonly kind: 'loader_error'; readonly path: 'circuit_open'; readonly error: unknown }
  | { readonly kind: 'fallback_rejected'; readonly reason: 'bulkhead_full' }
) & { readonly redisFailure?: 'operation_unavailable' };

export type CachePolicyReadResult<T> =
  | { readonly kind: 'read_through'; readonly result: ReadThroughResult<T>; readonly policy: CachePolicyDecision }
  | { readonly kind: 'bypass'; readonly result: CacheBypassResult<T>; readonly policy: CachePolicyDecision };

export interface CacheFailurePolicyOptions {
  readonly breaker: CacheCircuitBreaker;
  /**
   * Fallback bulkhead capping concurrent origin loads. MUST be the same
   * instance passed as `deps.bulkhead` so the T04 internal fallback and the
   * T05 bypass path share one capacity budget.
   */
  readonly bulkhead: CacheBulkhead;
  /** Injectable clock (ms) for latency; defaults to Date.now. */
  readonly clock?: () => number;
  readonly metrics?: Metrics;
  readonly log?: (entry: CachePolicyLogEntry) => void;
}

/** Assembled T05 failure policy: breaker + bulkhead + instrumented read. */
export interface CacheFailurePolicy {
  readonly breaker: CacheCircuitBreaker;
  readonly bulkhead: CacheBulkhead;
  readWithPolicy<T>(
    key: string,
    policy: CacheReadPolicy,
    deps: CacheReadDependencies,
    signal: AbortSignal,
  ): Promise<CachePolicyReadResult<T>>;
  /** Wraps a complete domain cache attempt, including any epoch read. */
  readOperationWithPolicy<T>(
    policy: CacheReadPolicy,
    deps: CacheReadDependencies,
    signal: AbortSignal,
    operation: () => Promise<ReadThroughResult<T>>,
  ): Promise<CachePolicyReadResult<T>>;
}

export function createCacheFailurePolicy(
  breaker: CacheCircuitBreaker,
  bulkhead: CacheBulkhead,
  options: Omit<CacheFailurePolicyOptions, 'breaker' | 'bulkhead'> = {},
): CacheFailurePolicy {
  const failure: CacheFailurePolicyOptions = { breaker, bulkhead, ...options };
  return {
    breaker,
    bulkhead,
    readWithPolicy: (key, policy, deps, signal) =>
      readThroughWithFailurePolicy(key, policy, deps, signal, failure),
    readOperationWithPolicy: (policy, deps, signal, operation) =>
      readCacheOperationWithFailurePolicy(policy, deps, signal, failure, operation),
  };
}

export async function readThroughWithFailurePolicy<T>(
  key: string,
  policy: CacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
  failure: CacheFailurePolicyOptions,
): Promise<CachePolicyReadResult<T>> {
  return readCacheOperationWithFailurePolicy(
    policy,
    deps,
    signal,
    failure,
    () => readThrough<T>(key, policy, deps, signal),
  );
}

export async function readCacheOperationWithFailurePolicy<T>(
  policy: CacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
  failure: CacheFailurePolicyOptions,
  operation: () => Promise<ReadThroughResult<T>>,
): Promise<CachePolicyReadResult<T>> {
  const clock = failure.clock ?? Date.now;
  const startedAtMs = clock();
  const allowed = failure.breaker.allowRequest();
  const wasProbe = allowed && failure.breaker.currentState === 'half_open';

  let metricsResult: CacheMetricsResult<T>;
  let decision: CachePolicyDecision;
  let errorCategory: CacheLogErrorCategory | undefined;

  if (allowed) {
    let readResult: ReadThroughResult<T>;
    try {
      readResult = await operation();
    } catch (error) {
      if (error instanceof CacheStoreError) {
        // A Redis-layer error surfaced by T04 (defensive): count UNAVAILABLE as
        // a breaker failure, then fall back under the bulkhead.
        const unavailable = error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
        if (unavailable) failure.breaker.recordFailure();
        else failure.breaker.recordAbort(); // a non-outage store error settles the probe slot without a failure
        const rawBypass = await runBypassLoad<T>(deps, signal, failure);
        const bypass: CacheBypassResult<T> = unavailable
          ? { ...rawBypass, redisFailure: 'operation_unavailable' }
          : rawBypass;
        const durationMs = clock() - startedAtMs;
        decision = { touchedRedis: true, probe: wasProbe, circuitState: failure.breaker.currentState };
        errorCategory = error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE ? 'cache_unavailable' : 'cache_decode_error';
        recordTelemetry(failure, policy.domain, bypass, durationMs, wasProbe, decision, errorCategory);
        return { kind: 'bypass', result: bypass, policy: decision };
      }
      // CacheAbortError (client cancellation) or any other unexpected outcome:
      // every admitted half-open probe is settled here — the probe slot is
      // released without counting a Redis failure and never as a success, so a
      // real outage is still discovered by the next probe — then the error is
      // rethrown so only the cancelled caller observes it. recordAbort is a
      // no-op when no half-open probe is in flight.
      if (wasProbe) failure.breaker.recordAbort();
      throw error;
    }
    if (isRedisFailureResult(readResult)) failure.breaker.recordFailure();
    else failure.breaker.recordSuccess();
    decision = { touchedRedis: true, probe: wasProbe, circuitState: failure.breaker.currentState };
    metricsResult = readResult;
    errorCategory = errorCategoryOfResult(readResult);
  } else {
    const bypass = await runBypassLoad<T>(deps, signal, failure);
    decision = { touchedRedis: false, probe: false, circuitState: failure.breaker.currentState };
    metricsResult = bypass;
    errorCategory = errorCategoryOfResult(bypass);
  }

  const durationMs = clock() - startedAtMs;
  recordTelemetry(failure, policy.domain, metricsResult, durationMs, decision.probe, decision, errorCategory);
  if (allowed) {
    return { kind: 'read_through', result: metricsResult as ReadThroughResult<T>, policy: decision };
  }
  return { kind: 'bypass', result: metricsResult as CacheBypassResult<T>, policy: decision };
}

function recordTelemetry(
  failure: CacheFailurePolicyOptions,
  domain: string,
  result: CacheMetricsResult<unknown>,
  durationMs: number,
  wasProbe: boolean,
  decision: CachePolicyDecision,
  errorCategory: CacheLogErrorCategory | undefined,
): void {
  const { metrics, log } = failure;
  if (metrics !== undefined) {
    recordCacheReadOutcome(metrics, domain, result);
    recordCacheReadLatency(metrics, domain, durationMs);
    const entryBytes = cacheResultEntryBytes(result);
    if (entryBytes !== undefined) recordCacheEntryBytes(metrics, domain, entryBytes);
    recordCacheCircuitState(metrics, decision.circuitState);
    if (wasProbe) recordCacheBreakerProbe(metrics);
    if (!decision.touchedRedis && decision.circuitState === 'open') recordCacheBreakerOpen(metrics);
  }
  if (log !== undefined) {
    const [outcome] = classifyCacheReadOutcome(result);
    log(serializeCacheLogEntry({ domain, outcome, durationMs, errorCategory }));
  }
}

async function runBypassLoad<T>(
  deps: CacheReadDependencies,
  signal: AbortSignal,
  failure: CacheFailurePolicyOptions,
): Promise<CacheBypassResult<T>> {
  let value: unknown;
  try {
    value = await failure.bulkhead.run(signal, (s) => deps.loader(s));
  } catch (error) {
    if (error instanceof CacheBulkheadError) {
      return { kind: 'fallback_rejected', reason: 'bulkhead_full' };
    }
    if (isCacheAbortError(error)) throw error;
    return { kind: 'loader_error', path: 'circuit_open', error };
  }
  if (value === null) return { kind: 'not_found', path: 'circuit_open' };
  return { kind: 'origin', value: value as T, path: 'circuit_open' };
}

/** True when a T04 result proves Redis itself failed (read or lock command). */
function isRedisFailureResult(result: ReadThroughResult<unknown>): boolean {
  return result.kind === 'origin'
    && (result.path === 'cache_unavailable'
      || result.path === 'lock_unavailable'
      || result.redisFailure === 'write_unavailable');
}

// ---------------------------------------------------------------------------
// Leak-free log serialization
// ---------------------------------------------------------------------------

export type CacheLogErrorCategory =
  | 'cache_unavailable'
  | 'cache_decode_error'
  | 'loader_error'
  | 'bulkhead_full'
  | 'unknown';

/** Only low-cardinality, non-sensitive fields ever leave the cache layer. */
export interface CachePolicyLogEntry {
  readonly event: 'cache.read';
  readonly domain: string;
  readonly outcome: CacheReadOutcome;
  readonly durationMs: number;
  readonly errorCategory?: CacheLogErrorCategory;
}

export interface CacheLogInput {
  readonly domain: string;
  readonly outcome: CacheReadOutcome;
  readonly durationMs: number;
  readonly error?: unknown;
  readonly errorCategory?: CacheLogErrorCategory;
}

/** Stable error classification; never the raw message, key or credentials. */
export function cacheErrorCategory(error: unknown): CacheLogErrorCategory {
  if (error instanceof CacheStoreError) {
    return error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE ? 'cache_unavailable' : 'cache_decode_error';
  }
  if (error instanceof CacheBulkheadError) return 'bulkhead_full';
  return 'unknown';
}

/** Serializes a cache read for logging: no key, value, envelope or error text. */
export function serializeCacheLogEntry(input: CacheLogInput): CachePolicyLogEntry {
  const errorCategory = input.errorCategory ?? (input.error === undefined ? undefined : cacheErrorCategory(input.error));
  return {
    event: 'cache.read',
    domain: input.domain,
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(errorCategory === undefined ? {} : { errorCategory }),
  };
}

/**
 * Free-text escape hatch for callers that must log an error message: applies
 * the telemetry redaction rules (tokens, passwords, URL credentials, ...)
 * before the text reaches any sink. Structured cache logs never need this.
 */
export function redactCacheLogText(text: string): string {
  // Redact credentials in any-scheme URLs (redis://, amqp://, ...) before the
  // telemetry rules run; the shared telemetry redactor only covers postgres URLs.
  const urlRedacted = text.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
  return redactSensitiveText(urlRedacted);
}

function errorCategoryOfResult(result: CacheMetricsResult<unknown>): CacheLogErrorCategory | undefined {
  switch (result.kind) {
    case 'loader_error':
      return 'loader_error';
    case 'fallback_rejected':
      return 'bulkhead_full';
    case 'origin':
      if ('redisFailure' in result && result.redisFailure !== undefined) return 'cache_unavailable';
      if (result.path === 'cache_unavailable' || result.path === 'lock_unavailable') return 'cache_unavailable';
      if (result.path === 'decode_error') return 'cache_decode_error';
      return undefined;
    default:
      return undefined;
  }
}
