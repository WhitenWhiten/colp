/**
 * T05 cache telemetry (plan §6.4 T05 / §4.4): maps every cache read outcome
 * onto the existing Metrics backend (increment/observe/gauge) with fixed,
 * low-cardinality names plus a fixed domain label.
 *
 * Safety contract:
 * - Metric names never contain collection IDs, query hashes, Redis keys or raw
 *   error text. The only dynamic segment is the domain, which is a validated
 *   fixed label from CacheReadPolicy.
 * - Each outcome increments exactly once via `recordCacheReadOutcome`.
 * - Latency and entry bytes use `observe`; circuit state uses a gauge.
 */
import type { Metrics } from '../telemetry/index.js';
import type { CacheCircuitState } from './cache-circuit-breaker.js';
import type { ReadThroughResult } from './read-through-cache.js';

/** Normalized, low-cardinality cache read outcomes (T05 metric/log vocabulary). */
export type CacheReadOutcome =
  | 'hit'
  | 'miss'
  | 'stale'
  | 'fallback'
  | 'bad_value'
  | 'redis_error'
  | 'lock_wait';

/** Outcome counter base names; the domain label is appended at record time. */
export const cacheReadOutcomeMetricNames: Record<CacheReadOutcome, string> = {
  hit: 'cache.read.hit',
  miss: 'cache.read.miss',
  stale: 'cache.read.stale',
  fallback: 'cache.read.fallback',
  bad_value: 'cache.read.bad_value',
  redis_error: 'cache.read.redis_error',
  lock_wait: 'cache.read.lock_wait',
};

/** observe-based distributions (domain label appended at record time). */
export const cacheObservedMetricNames = {
  entryBytes: 'cache.entry.size_bytes',
  latencyMs: 'cache.read.latency_ms',
} as const;

/** Process-level circuit metrics (no domain segment: the breaker is per store). */
export const cacheCircuitMetricNames = {
  state: 'cache.circuit.state',
  open: 'cache.circuit.open',
  probe: 'cache.circuit.probe',
} as const;

/** Counter for corrupt cache epoch values read from the store (domain label appended at record time). */
export const cacheCorruptionMetricNames = {
  epoch: 'cache.epoch.corrupt',
} as const;

/** Gauge encoding of the breaker state for cache.circuit.state. */
export const cacheCircuitStateGauge: Record<CacheCircuitState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

/**
 * The result surface the T05 mapper understands: the T04 ReadThroughResult plus
 * the T05 circuit-open bypass variants (`path: 'circuit_open'`). `bypass`-load
 * results are structurally a subset of this union, so readThroughWithFailurePolicy
 * can hand them directly to the recorder.
 */
export type CacheMetricsResult<T> =
  | ReadThroughResult<T>
  | {
      readonly kind: 'origin';
      readonly value: T;
      readonly path: 'circuit_open';
      readonly redisFailure?: 'operation_unavailable';
    }
  | {
      readonly kind: 'not_found';
      readonly path: 'circuit_open';
      readonly redisFailure?: 'operation_unavailable';
    }
  | {
      readonly kind: 'loader_error';
      readonly path: 'circuit_open';
      readonly error: unknown;
      readonly redisFailure?: 'operation_unavailable';
    }
  | {
      readonly kind: 'fallback_rejected';
      readonly reason: 'bulkhead_full';
      readonly redisFailure?: 'operation_unavailable';
    };

export class CacheMetricNameError extends Error {
  readonly reason = 'invalid_metric_name';

  constructor(message = 'cache metric names must be low-cardinality fixed labels ([A-Za-z0-9_.-]{1,64})') {
    super(message);
    this.name = 'CacheMetricNameError';
  }
}

const SAFE_LABEL = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Builds `<base>.<domain>` after validating both segments are fixed safe labels. */
export function cacheMetricName(domain: string, base: string): string {
  if (!SAFE_LABEL.test(domain) || !SAFE_LABEL.test(base)) {
    throw new CacheMetricNameError();
  }
  return `${base}.${domain}`;
}

export function cacheOutcomeMetricName(domain: string, outcome: CacheReadOutcome): string {
  return cacheMetricName(domain, cacheReadOutcomeMetricNames[outcome]);
}

/**
 * Classifies a cache read result into the outcomes it represents, primary
 * first. `recordCacheReadOutcome` increments each exactly once; the failure
 * policy uses the primary outcome as its log label.
 */
export function classifyCacheReadOutcome(
  result: CacheMetricsResult<unknown>,
): readonly [CacheReadOutcome, ...CacheReadOutcome[]] {
  const base = classifyCacheReadOutcomeBase(result);
  if ('redisFailure' in result && result.redisFailure !== undefined && !base.includes('redis_error')) {
    return ['redis_error', ...base];
  }
  return base;
}

function classifyCacheReadOutcomeBase(
  result: CacheMetricsResult<unknown>,
): readonly [CacheReadOutcome, ...CacheReadOutcome[]] {
  switch (result.kind) {
    case 'cache_hit':
      return ['hit'];
    case 'stale_hit':
      return ['stale'];
    case 'origin':
      switch (result.path) {
        case 'miss':
        case 'soft_expired':
          return ['miss'];
        case 'decode_error':
          return ['bad_value'];
        case 'cache_unavailable':
        case 'lock_unavailable':
          return ['redis_error', 'fallback'];
        case 'lock_wait_exceeded':
          return ['lock_wait', 'fallback'];
        case 'circuit_open':
          return ['fallback'];
      }
      break;
    case 'not_found':
      return ['miss'];
    case 'loader_error':
      return ['fallback'];
    case 'fallback_rejected':
      return ['fallback'];
  }
  const exhaustive: never = result;
  throw new CacheMetricNameError(`cannot classify cache read result ${String(exhaustive)}`);
}

/** Returns the measured encoded envelope size carried by a hit or successful write. */
export function cacheResultEntryBytes(result: CacheMetricsResult<unknown>): number | undefined {
  if (result.kind !== 'cache_hit' && result.kind !== 'stale_hit' && result.kind !== 'origin') return undefined;
  return 'entryBytes' in result && typeof result.entryBytes === 'number' ? result.entryBytes : undefined;
}

/** Increments a single outcome counter exactly once. */
export function recordCacheOutcome(metrics: Metrics, domain: string, outcome: CacheReadOutcome): void {
  metrics.increment(cacheOutcomeMetricName(domain, outcome), 1);
}

/** Fixed low-cardinality name of the epoch-corruption counter for a domain. */
export function cacheEpochCorruptMetricName(domain: string): string {
  return cacheMetricName(domain, cacheCorruptionMetricNames.epoch);
}

/** Counts a corrupt epoch value (FIX-L-024: a non-canonical epoch string counts as 0). */
export function recordCacheEpochCorrupt(metrics: Metrics, domain: string): void {
  metrics.increment(cacheEpochCorruptMetricName(domain), 1);
}

/** Maps a T04 (or circuit-open bypass) result to counters, each outcome exactly once. */
export function recordCacheReadOutcome(metrics: Metrics, domain: string, result: CacheMetricsResult<unknown>): void {
  for (const outcome of classifyCacheReadOutcome(result)) {
    recordCacheOutcome(metrics, domain, outcome);
  }
}

/** Records the encoded entry size distribution for one write (observe). */
export function recordCacheEntryBytes(metrics: Metrics, domain: string, bytes: number): void {
  metrics.observe(cacheMetricName(domain, cacheObservedMetricNames.entryBytes), bytes);
}

/** Records one read duration (observe). */
export function recordCacheReadLatency(metrics: Metrics, domain: string, durationMs: number): void {
  metrics.observe(cacheMetricName(domain, cacheObservedMetricNames.latencyMs), durationMs);
}

/** Reflects the current breaker state as a gauge (closed=0, half_open=1, open=2). */
export function recordCacheCircuitState(metrics: Metrics, state: CacheCircuitState): void {
  metrics.gauge(cacheCircuitMetricNames.state, cacheCircuitStateGauge[state]);
}

/** Counts requests shed while the breaker is open. */
export function recordCacheBreakerOpen(metrics: Metrics): void {
  metrics.increment(cacheCircuitMetricNames.open, 1);
}

/** Counts half-open probes admitted. */
export function recordCacheBreakerProbe(metrics: Metrics): void {
  metrics.increment(cacheCircuitMetricNames.probe, 1);
}
