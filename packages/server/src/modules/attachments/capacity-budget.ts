/**
 * P4A-P10 capacity budget sample contract (plan §9 P10 item 6).
 *
 * A capacity sample records a rehearsal run under FIXED inputs — object
 * size, concurrency, API instance count — together with RSS / FD / pool /
 * Redis memory / DB query facts, with cold-start and warm phases separated.
 *
 * The schema is a sealed, low-sensitivity shape: every numeric fact is a
 * finite non-negative safe integer inside a hard ceiling, phases are fixed,
 * unknown/forbidden fields (keys, URLs, credentials, high-cardinality
 * identifiers) are rejected, and EVERY valid sample must carry the fixed
 * not-SLO limitation token — local rehearsal numbers are never production
 * SLOs (plan §9 P10 测试注意事项: "不把本机结果写成生产 SLO（limitations 注明）").
 */
export const CAPACITY_SAMPLE_SCHEMA_VERSION = 1 as const;

/** Mirrors the single-PUT hard ceiling (64 MiB compile-time ceiling). */
export const CAPACITY_OBJECT_SIZE_MAX_BYTES = 64 * 1024 * 1024;
/** Fixed rehearsal concurrency ceiling (bounded; never unbounded load). */
export const CAPACITY_CONCURRENCY_MAX = 64;
/** Fixed rehearsal instance ceiling. */
export const CAPACITY_API_INSTANCES_MAX = 16;
/** The ONLY limitation token that satisfies the not-SLO contract. */
export const CAPACITY_NOT_SLO_LIMITATION =
  'local rehearsal capacity sample; not a production SLO';

export type CapacitySamplePhase = 'cold_start' | 'warm';

export interface CapacitySample {
  readonly schemaVersion: typeof CAPACITY_SAMPLE_SCHEMA_VERSION;
  readonly phase: CapacitySamplePhase;
  /** Fixed object size used for every request in this run. */
  readonly objectSizeBytes: number;
  /** Fixed concurrent request count. */
  readonly concurrency: number;
  /** Fixed API instance count. */
  readonly apiInstances: number;
  readonly process: {
    /** Process resident set size (bytes). */
    readonly rssBytes: number;
    /** File-descriptor count; null on platforms without /proc (POSIX-only). */
    readonly fdCount: number | null;
    /** Active handle count (sockets/timers; observable on all platforms). */
    readonly activeHandles: number;
  };
  readonly postgresPool: {
    readonly total: number;
    readonly idle: number;
    readonly active: number;
    readonly waiting: number;
  };
  /** Redis memory facts; null when the run does not use Redis. */
  readonly redis: { readonly usedMemoryBytes: number; readonly connectedClients: number } | null;
  /** PostgreSQL query count observed during the run. */
  readonly dbQueries: number;
  /** Object-store (R2) call count observed during the run. */
  readonly r2Calls: number;
  /** Latency is DIAGNOSTIC ONLY (never an SLO); null when not measured. */
  readonly latencyMs: { readonly p50: number; readonly p95: number } | null;
  /** Must include CAPACITY_NOT_SLO_LIMITATION. */
  readonly limitations: readonly string[];
}

const CAPACITY_SAMPLE_FIELDS = Object.freeze([
  'schemaVersion', 'phase', 'objectSizeBytes', 'concurrency', 'apiInstances',
  'process', 'postgresPool', 'redis', 'dbQueries', 'r2Calls', 'latencyMs', 'limitations',
]);

function assertSafeNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`capacity_sample_${field}_invalid`);
  }
}

/**
 * Validates a capacity sample against the sealed schema; throws
 * `capacity_sample_<field>_invalid` on any drift. Returns the sample.
 */
export function validateCapacitySample(sample: unknown): CapacitySample {
  if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
    throw new Error('capacity_sample_shape_invalid');
  }
  const record = sample as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CAPACITY_SAMPLE_FIELDS.includes(key)) {
      throw new Error(`capacity_sample_field_forbidden:${key}`);
    }
  }
  if (record.schemaVersion !== CAPACITY_SAMPLE_SCHEMA_VERSION) {
    throw new Error('capacity_sample_schema_version_invalid');
  }
  const phase = record.phase;
  if (phase !== 'cold_start' && phase !== 'warm') {
    throw new Error('capacity_sample_phase_invalid');
  }
  const objectSizeBytes = record.objectSizeBytes;
  assertSafeNonNegative(objectSizeBytes, 'object_size');
  if (objectSizeBytes < 1 || objectSizeBytes > CAPACITY_OBJECT_SIZE_MAX_BYTES) {
    throw new Error('capacity_sample_object_size_invalid');
  }
  const concurrency = record.concurrency;
  assertSafeNonNegative(concurrency, 'concurrency');
  if (concurrency < 1 || concurrency > CAPACITY_CONCURRENCY_MAX) {
    throw new Error('capacity_sample_concurrency_invalid');
  }
  const apiInstances = record.apiInstances;
  assertSafeNonNegative(apiInstances, 'api_instances');
  if (apiInstances < 1 || apiInstances > CAPACITY_API_INSTANCES_MAX) {
    throw new Error('capacity_sample_api_instances_invalid');
  }

  const process = record.process as Record<string, unknown> | undefined;
  if (typeof process !== 'object' || process === null) {
    throw new Error('capacity_sample_process_invalid');
  }
  for (const key of Object.keys(process)) {
    if (key !== 'rssBytes' && key !== 'fdCount' && key !== 'activeHandles') {
      throw new Error(`capacity_sample_field_forbidden:process.${key}`);
    }
  }
  assertSafeNonNegative(process.rssBytes, 'process_rss');
  if (process.fdCount !== null) assertSafeNonNegative(process.fdCount, 'process_fd');
  assertSafeNonNegative(process.activeHandles, 'process_active_handles');

  const pool = record.postgresPool as Record<string, unknown> | undefined;
  if (typeof pool !== 'object' || pool === null) {
    throw new Error('capacity_sample_pool_invalid');
  }
  for (const key of Object.keys(pool)) {
    if (key !== 'total' && key !== 'idle' && key !== 'active' && key !== 'waiting') {
      throw new Error(`capacity_sample_field_forbidden:postgresPool.${key}`);
    }
  }
  assertSafeNonNegative(pool.total, 'pool_total');
  assertSafeNonNegative(pool.idle, 'pool_idle');
  assertSafeNonNegative(pool.active, 'pool_active');
  assertSafeNonNegative(pool.waiting, 'pool_waiting');
  if (pool.idle + pool.active > pool.total) {
    throw new Error('capacity_sample_pool_invalid:idle_plus_active_exceeds_total');
  }

  if (record.redis !== null) {
    const redis = record.redis as Record<string, unknown> | undefined;
    if (typeof redis !== 'object' || redis === null) {
      throw new Error('capacity_sample_redis_invalid');
    }
    for (const key of Object.keys(redis)) {
      if (key !== 'usedMemoryBytes' && key !== 'connectedClients') {
        throw new Error(`capacity_sample_field_forbidden:redis.${key}`);
      }
    }
    assertSafeNonNegative(redis.usedMemoryBytes, 'redis_memory');
    assertSafeNonNegative(redis.connectedClients, 'redis_clients');
  }

  assertSafeNonNegative(record.dbQueries, 'db_queries');
  assertSafeNonNegative(record.r2Calls, 'r2_calls');

  if (record.latencyMs !== null) {
    const latency = record.latencyMs as Record<string, unknown> | undefined;
    if (typeof latency !== 'object' || latency === null) {
      throw new Error('capacity_sample_latency_invalid');
    }
    for (const key of Object.keys(latency)) {
      if (key !== 'p50' && key !== 'p95') {
        throw new Error(`capacity_sample_field_forbidden:latencyMs.${key}`);
      }
    }
    assertSafeNonNegative(latency.p50, 'latency_p50');
    assertSafeNonNegative(latency.p95, 'latency_p95');
  }

  const limitations = record.limitations;
  if (!Array.isArray(limitations) || !limitations.includes(CAPACITY_NOT_SLO_LIMITATION)) {
    throw new Error('capacity_sample_limitation_missing_not_slo');
  }
  return sample as CapacitySample;
}
