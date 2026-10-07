/**
 * P4A-I15 fixed-label attachment metrics (module-owned, bounded), extended by
 * P4A-RL01 with the admission baseline surface.
 *
 * The metric schema is a FIXED allowlist of operation / state / error class /
 * size bucket / latency bucket / rate-limit decision labels ONLY. Recording
 * any other label name or any value outside the allowlist throws, so metric
 * cardinality can never grow with keys, blob ids, principal ids, filenames,
 * digests, or URLs (plan §6 I15: "no key/blob/Principal/filename/digest/URL"
 * and §8 RL01: labels never contain principal/Collection/blob/key/filename/
 * digest/URL). The counter space is bounded by the fixed label product and
 * backlog samples are kept in a bounded ring, so a long-running process
 * cannot grow metric memory without bound.
 *
 * P4A-RL01 additions (plan §13.2):
 *  - route operations for the five admission paths (`status`, `finalize`,
 *    `download`) plus `query` for DB query latency, so route query counts and
 *    query latency buckets stay fixed-label;
 *  - the `rateLimitDecision` dimension (`none|allowed|denied|unavailable|
 *    fallback`) so rate-limit decision/fallback counts never carry a
 *    principal, route identity, or dynamic value (RL04 composes the Redis
 *    mode into the same fixed dimension);
 *  - fixed PostgreSQL pool wait/saturation gauges
 *    (`pool_total/pool_idle/pool_active/pool_waiting/pool_max_waiting`).
 *
 * The module must not import infrastructure (import boundaries), so this is a
 * module-owned store; the bootstrap/worker composition may bridge it to the
 * infrastructure telemetry `Metrics` surface later.
 */
export const ATTACHMENT_METRIC_OPERATIONS = Object.freeze([
  'issue', 'complete', 'status', 'finalize', 'download', 'verify', 'cleanup', 'deliver', 'query',
] as const);
export type AttachmentMetricOperation = typeof ATTACHMENT_METRIC_OPERATIONS[number];

/**
 * P4A-RL01 fixed rate-limit decision/fallback dimension. `none` is the value
 * for routes without a rate-limit decision; `unavailable` and `fallback` are
 * reserved for the RL03/RL04 Redis failure policy (fail-closed 503 and the
 * bounded complete emergency fallback) so the allowlist is sealed NOW and no
 * dynamic mode/decision value can ever enter the counter space.
 */
export const ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS = Object.freeze([
  'none', 'allowed', 'denied', 'unavailable', 'fallback',
] as const);
export type AttachmentMetricRateLimitDecision = typeof ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS[number];

export const ATTACHMENT_METRIC_STATES = Object.freeze([
  'ok', 'failed', 'retryable', 'denied', 'unknown',
] as const);
export type AttachmentMetricState = typeof ATTACHMENT_METRIC_STATES[number];

export const ATTACHMENT_METRIC_ERROR_CLASSES = Object.freeze([
  'none',
  'provider_retryable',
  'provider_denied',
  'provider_not_found',
  'unknown_outcome',
  'contract_corruption',
  'lease_lost',
  'database',
  'internal',
] as const);
export type AttachmentMetricErrorClass = typeof ATTACHMENT_METRIC_ERROR_CLASSES[number];

export const ATTACHMENT_METRIC_SIZE_BUCKETS = Object.freeze([
  'zero', 'under_1mib', 'under_16mib', 'under_64mib', 'over_64mib',
] as const);
export type AttachmentMetricSizeBucket = typeof ATTACHMENT_METRIC_SIZE_BUCKETS[number];

export const ATTACHMENT_METRIC_LATENCY_BUCKETS = Object.freeze([
  'under_10ms', 'under_100ms', 'under_1s', 'under_10s', 'over_10s',
] as const);
export type AttachmentMetricLatencyBucket = typeof ATTACHMENT_METRIC_LATENCY_BUCKETS[number];

/** Fixed gauge names only; unknown gauges throw (no cardinality growth). */
export const ATTACHMENT_GAUGE_NAMES = Object.freeze([
  'verification_backlog', 'cleanup_backlog', 'quarantine_count', 'dead_letter_count',
  // P4A-RL01: PostgreSQL pool wait/saturation gauges (fixed names).
  'pool_total', 'pool_idle', 'pool_active', 'pool_waiting', 'pool_max_waiting',
] as const);
export type AttachmentGaugeName = typeof ATTACHMENT_GAUGE_NAMES[number];

export interface AttachmentMetricLabels {
  readonly operation: AttachmentMetricOperation;
  readonly state: AttachmentMetricState;
  readonly errorClass: AttachmentMetricErrorClass;
  readonly sizeBucket: AttachmentMetricSizeBucket;
  readonly latencyBucket: AttachmentMetricLatencyBucket;
  /** P4A-RL01 fixed rate-limit decision/fallback dimension. */
  readonly rateLimitDecision: AttachmentMetricRateLimitDecision;
}

/** A time-series backlog sample consumed by the alert evaluator. */
export interface AttachmentBacklogSample {
  readonly atIso: string;
  readonly verificationBacklog: number;
  readonly cleanupBacklog: number;
  readonly quarantineCount: number;
  readonly deadLetterCount: number;
  /**
   * P4A-P10 Redis hot-key count observed for the suite-owned limiter
   * namespace (fixed alert field; absent = 0, never a fabricated fact).
   */
  readonly redisHotKeyCount?: number;
  /** P4A-P10 PostgreSQL pool waiting count (fixed alert field; absent = 0). */
  readonly poolWaiting?: number;
}

export interface AttachmentMetricsSnapshot {
  readonly schemaVersion: 1;
  readonly counters: ReadonlyArray<{ readonly labels: AttachmentMetricLabels; readonly count: number }>;
  readonly gauges: Readonly<Record<AttachmentGaugeName, number>>;
  readonly backlogSamples: readonly AttachmentBacklogSample[];
  readonly recordedAtIso: string;
}

export interface AttachmentMetricsStoreOptions {
  /** Bounded ring size for backlog samples (default 256). */
  readonly maxBacklogSamples?: number;
  readonly now?: () => Date;
}

export interface AttachmentMetricsStore {
  /** Validate + accumulate a fixed-label counter. Throws on any non-fixed value. */
  record(input: AttachmentMetricLabels & { readonly count?: number }): void;
  /** Set a fixed-name gauge; unknown gauge names throw. */
  setGauge(name: AttachmentGaugeName, value: number): void;
  /** Push a backlog sample into the bounded ring (oldest dropped). */
  recordBacklogSample(sample: AttachmentBacklogSample): void;
  snapshot(): AttachmentMetricsSnapshot;
}

const METRIC_LABEL_FIELDS = [
  'operation', 'state', 'errorClass', 'sizeBucket', 'latencyBucket', 'rateLimitDecision',
] as const;
/** Record keys = the six fixed labels PLUS the fixed 'count' batch increment. */
const METRIC_RECORD_KEYS = [
  ...METRIC_LABEL_FIELDS, 'count',
] as const;
const DEFAULT_MAX_BACKLOG_SAMPLES = 256;

function assertFixed<Value extends string>(
  field: string,
  value: Value,
  allowlist: readonly Value[],
): void {
  if (!allowlist.includes(value)) {
    throw new Error(`attachment_metric_not_a_fixed_${field}:${String(value)}`);
  }
}

function assertKnownRecordKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!METRIC_RECORD_KEYS.includes(key as (typeof METRIC_RECORD_KEYS)[number])) {
      throw new Error(`attachment_metric_not_a_fixed_label:${key}`);
    }
  }
}

function assertBacklogSample(sample: AttachmentBacklogSample): void {
  if (Number.isNaN(Date.parse(sample.atIso))) {
    throw new Error('attachment_metric_backlog_sample_atIso_invalid');
  }
  for (const field of ['verificationBacklog', 'cleanupBacklog', 'quarantineCount', 'deadLetterCount'] as const) {
    const value = sample[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`attachment_metric_backlog_sample_${field}_invalid`);
    }
  }
  // P4A-P10 optional alert fields: validated fail-closed when present.
  if (sample.redisHotKeyCount !== undefined) {
    if (!Number.isSafeInteger(sample.redisHotKeyCount) || sample.redisHotKeyCount < 0) {
      throw new Error('attachment_metric_backlog_sample_redisHotKeyCount_invalid');
    }
  }
  if (sample.poolWaiting !== undefined) {
    if (!Number.isSafeInteger(sample.poolWaiting) || sample.poolWaiting < 0) {
      throw new Error('attachment_metric_backlog_sample_poolWaiting_invalid');
    }
  }
}

export function createAttachmentMetricsStore(
  options: AttachmentMetricsStoreOptions = {},
): AttachmentMetricsStore {
  const maxBacklogSamples = options.maxBacklogSamples ?? DEFAULT_MAX_BACKLOG_SAMPLES;
  if (!Number.isSafeInteger(maxBacklogSamples) || maxBacklogSamples < 1) {
    throw new RangeError('attachment_metric_max_backlog_samples_invalid');
  }
  const now = options.now ?? (() => new Date());
  const counters = new Map<string, AttachmentMetricLabels & { readonly count: number }>();
  const gauges = new Map<AttachmentGaugeName, number>(
    ATTACHMENT_GAUGE_NAMES.map((name) => [name, 0]),
  );
  const backlogSamples: AttachmentBacklogSample[] = [];

  return Object.freeze({
    record(input: AttachmentMetricLabels & { readonly count?: number }): void {
      const raw = input as unknown as Record<string, unknown>;
      assertKnownRecordKeys(raw);
      assertFixed('operation', input.operation, ATTACHMENT_METRIC_OPERATIONS);
      assertFixed('state', input.state, ATTACHMENT_METRIC_STATES);
      assertFixed('errorClass', input.errorClass, ATTACHMENT_METRIC_ERROR_CLASSES);
      assertFixed('sizeBucket', input.sizeBucket, ATTACHMENT_METRIC_SIZE_BUCKETS);
      assertFixed('latencyBucket', input.latencyBucket, ATTACHMENT_METRIC_LATENCY_BUCKETS);
      assertFixed('rateLimitDecision', input.rateLimitDecision, ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS);
      const increment = input.count ?? 1;
      if (!Number.isSafeInteger(increment) || increment < 1) {
        throw new Error('attachment_metric_count_invalid');
      }
      const key = JSON.stringify({
        operation: input.operation,
        state: input.state,
        errorClass: input.errorClass,
        sizeBucket: input.sizeBucket,
        latencyBucket: input.latencyBucket,
        rateLimitDecision: input.rateLimitDecision,
      });
      const existing = counters.get(key);
      if (existing) {
        counters.set(key, { ...existing, count: existing.count + increment });
      } else {
        counters.set(key, {
          operation: input.operation,
          state: input.state,
          errorClass: input.errorClass,
          sizeBucket: input.sizeBucket,
          latencyBucket: input.latencyBucket,
          rateLimitDecision: input.rateLimitDecision,
          count: increment,
        });
      }
    },
    setGauge(name: AttachmentGaugeName, value: number): void {
      assertFixed('gauge', name, ATTACHMENT_GAUGE_NAMES);
      if (!Number.isFinite(value)) throw new Error('attachment_metric_gauge_value_invalid');
      gauges.set(name, value);
    },
    recordBacklogSample(sample: AttachmentBacklogSample): void {
      assertBacklogSample(sample);
      backlogSamples.push({ ...sample });
      if (backlogSamples.length > maxBacklogSamples) backlogSamples.shift();
    },
    snapshot(): AttachmentMetricsSnapshot {
      const countersSnapshot = [...counters.values()].map((entry) => ({
        labels: {
          operation: entry.operation,
          state: entry.state,
          errorClass: entry.errorClass,
          sizeBucket: entry.sizeBucket,
          latencyBucket: entry.latencyBucket,
          rateLimitDecision: entry.rateLimitDecision,
        },
        count: entry.count,
      }));
      return Object.freeze({
        schemaVersion: 1,
        counters: Object.freeze(countersSnapshot),
        gauges: Object.freeze(Object.fromEntries(gauges) as Record<AttachmentGaugeName, number>),
        backlogSamples: Object.freeze(backlogSamples.map((sample) => ({ ...sample }))),
        recordedAtIso: now().toISOString(),
      });
    },
  });
}

/** Pure helper: validates + records a fixed-label metric through the store. */
export function recordAttachmentMetric(
  store: AttachmentMetricsStore,
  labels: AttachmentMetricLabels & { readonly count?: number },
): void {
  store.record(labels);
}

/** Pure helper: snapshots the bounded metric store. */
export function snapshotAttachmentMetrics(store: AttachmentMetricsStore): AttachmentMetricsSnapshot {
  return store.snapshot();
}