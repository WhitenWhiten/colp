export type SearchTelemetryOutcome = 'success' | 'invalid' | 'timeout' | 'abort' | 'error';
export type SearchTelemetryResultClass = 'zero' | 'partial' | 'full' | 'failure';

type SearchResourceType = 'collection' | 'node' | 'profile' | 'annotation';
type CountBucket = '000' | '001_010' | '011_050' | '051_100' | '101_200' | '201_400';
type RoundBucket = '0' | '1' | '2' | '3' | '4';
type LatencyBucket = 'le_10' | 'le_50' | 'le_100' | 'le_250' | 'le_500' | 'le_1000' | 'le_2500' | 'gt_2500';

export interface SearchTelemetryMetrics {
  increment(name: string, value?: number): void;
  observe(name: string, value: number): void;
}

export interface SearchTelemetryLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface SearchTelemetryRecord {
  readonly outcome: SearchTelemetryOutcome;
  readonly resourceTypes: readonly string[];
  readonly candidateCount: number;
  readonly authorizedCount: number;
  readonly resultCount: number;
  readonly requestedCount: number;
  readonly roundCount: number;
  readonly latencyMs: number;
}

export interface SearchTelemetryPort {
  record(input: SearchTelemetryRecord): void;
}

const RESOURCE_TYPES = Object.freeze(['collection', 'node', 'profile', 'annotation'] as const);
const OUTCOMES = Object.freeze(['success', 'invalid', 'timeout', 'abort', 'error'] as const);
const METRIC_PREFIX = 'search.query';

export function createSearchTelemetry(input: {
  readonly metrics: SearchTelemetryMetrics;
  readonly logger: SearchTelemetryLogger;
  readonly metricPrefix?: typeof METRIC_PREFIX;
}): SearchTelemetryPort {
  if (input.metricPrefix !== undefined && input.metricPrefix !== METRIC_PREFIX) {
    throw new TypeError('Search telemetry metric prefix must use the fixed production namespace.');
  }
  return Object.freeze({
    record(record: SearchTelemetryRecord): void {
      const outcome = closedOutcome(record.outcome);
      const resourceTypes = closedResourceTypes(record.resourceTypes);
      assertConsistentCounts(record);
      const candidateBucket = countBucket(record.candidateCount);
      const authorizedBucket = countBucket(record.authorizedCount);
      const resultBucket = countBucket(record.resultCount);
      const roundBucket = roundsBucket(record.roundCount);
      const latencyMs = finiteNonNegative(record.latencyMs);
      const latencyBucket = latencyMsBucket(latencyMs);
      const resultClass = classifyResult(record, outcome);

      input.metrics.increment(metric('total', 'outcome', outcome));
      input.metrics.observe(metric('latency_ms', 'outcome', outcome), latencyMs);
      input.metrics.increment(metric('latency', 'bucket', latencyBucket));
      input.metrics.increment(metric('candidates', 'bucket', candidateBucket));
      input.metrics.increment(metric('authorized', 'bucket', authorizedBucket));
      input.metrics.increment(metric('results', 'bucket', resultBucket));
      input.metrics.increment(metric('rounds', 'bucket', roundBucket));
      input.metrics.increment(metric('result_class', resultClass));
      for (const resourceType of resourceTypes) {
        input.metrics.increment(metric('resource_type', resourceType));
      }
      if (outcome === 'timeout') input.metrics.increment(metric('timeout', 'total'));
      if (outcome === 'success' && record.resultCount === 0) {
        input.metrics.increment(metric('zero_result', 'total'));
      }

      const event = {
        event: 'search_query',
        outcome,
        resultClass,
        resourceTypes,
        candidateBucket,
        authorizedBucket,
        resultBucket,
        roundBucket,
        latencyBucket,
      } as const;
      if (outcome === 'success') input.logger.info(event, 'Search query completed');
      else input.logger.warn(event, 'Search query did not complete');
    },
  });
}

function metric(...segments: readonly string[]): string {
  if (segments.some((segment) => !/^[a-z0-9_]+$/u.test(segment))) {
    throw new TypeError('Search telemetry metric segment is outside the closed namespace.');
  }
  return [METRIC_PREFIX, ...segments].join('.');
}

function closedOutcome(value: SearchTelemetryOutcome): SearchTelemetryOutcome {
  if (!(OUTCOMES as readonly string[]).includes(value)) throw new TypeError('Unknown Search telemetry outcome.');
  return value;
}

function closedResourceTypes(values: readonly string[]): readonly SearchResourceType[] {
  if (values.some((value) => !(RESOURCE_TYPES as readonly string[]).includes(value))) {
    throw new TypeError('Unknown Search telemetry resource type.');
  }
  const selected = new Set(values as readonly SearchResourceType[]);
  return Object.freeze(RESOURCE_TYPES.filter((value) => selected.has(value)));
}

function assertConsistentCounts(record: SearchTelemetryRecord): void {
  for (const [name, value] of [
    ['candidateCount', record.candidateCount],
    ['authorizedCount', record.authorizedCount],
    ['resultCount', record.resultCount],
    ['requestedCount', record.requestedCount],
    ['roundCount', record.roundCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Search telemetry ${name} must be a non-negative safe integer.`);
    }
  }
  if (record.authorizedCount > record.candidateCount || record.resultCount > record.authorizedCount) {
    throw new TypeError('Search telemetry counts violate candidate >= authorized >= result.');
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function integerInRange(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(maximum, Math.floor(value));
}

function countBucket(value: number): CountBucket {
  const count = integerInRange(value, 400);
  if (count === 0) return '000';
  if (count <= 10) return '001_010';
  if (count <= 50) return '011_050';
  if (count <= 100) return '051_100';
  if (count <= 200) return '101_200';
  return '201_400';
}

function roundsBucket(value: number): RoundBucket {
  return String(integerInRange(value, 4)) as RoundBucket;
}

function latencyMsBucket(value: number): LatencyBucket {
  if (value <= 10) return 'le_10';
  if (value <= 50) return 'le_50';
  if (value <= 100) return 'le_100';
  if (value <= 250) return 'le_250';
  if (value <= 500) return 'le_500';
  if (value <= 1_000) return 'le_1000';
  if (value <= 2_500) return 'le_2500';
  return 'gt_2500';
}

function classifyResult(record: SearchTelemetryRecord,
  outcome: SearchTelemetryOutcome): SearchTelemetryResultClass {
  if (outcome !== 'success') return 'failure';
  if (record.resultCount === 0) return 'zero';
  return record.resultCount >= record.requestedCount ? 'full' : 'partial';
}
