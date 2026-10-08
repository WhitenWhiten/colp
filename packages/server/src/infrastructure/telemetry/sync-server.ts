import type { Metrics } from './index.js';

export const SYNC_TELEMETRY_ENDPOINTS = Object.freeze([
  'manifest', 'session', 'snapshot', 'push', 'conflict', 'pull', 'ack', 'retire', 'purge', 'recovery',
] as const);
export const SYNC_TELEMETRY_OUTCOMES = Object.freeze([
  'success', 'problem', 'internal', 'timeout', 'abort', 'retry', 'replay', 'concurrency',
] as const);
export const SYNC_TELEMETRY_PROBLEMS = Object.freeze([
  'none', 'authentication_required', 'authorization_denied', 'invalid_document', 'invalid_json',
  'sequence_gap', 'sequence_blocked', 'conflict', 'precondition_failed', 'rate_limited',
  'replica_retired', 'recovery_required', 'service_unavailable', 'internal_error',
] as const);
export const SYNC_TELEMETRY_BUCKETS = Object.freeze([
  'under_10ms', 'under_100ms', 'under_1s', 'under_10s', 'over_10s',
] as const);

export type SyncTelemetryEndpoint = (typeof SYNC_TELEMETRY_ENDPOINTS)[number];
export type SyncTelemetryOutcome = (typeof SYNC_TELEMETRY_OUTCOMES)[number];
export type SyncTelemetryProblem = (typeof SYNC_TELEMETRY_PROBLEMS)[number];
export type SyncTelemetryBucket = (typeof SYNC_TELEMETRY_BUCKETS)[number];

export interface SyncServerTelemetryRecord {
  readonly endpoint: SyncTelemetryEndpoint;
  readonly outcome: SyncTelemetryOutcome;
  readonly problem: SyncTelemetryProblem;
  readonly bucket: SyncTelemetryBucket;
  readonly durationMs: number;
  readonly traceId?: string;
}

export interface SyncServerTelemetry {
  record(record: SyncServerTelemetryRecord): void;
}

export interface SyncStructuredLogger {
  info(bindings: Record<string, unknown>, message: string): unknown;
}

export function createSyncServerTelemetry(input: {
  readonly metrics: Metrics;
  readonly logger: SyncStructuredLogger;
}): SyncServerTelemetry {
  if (!input?.metrics || !input.logger) throw new TypeError('Sync telemetry dependencies are required');
  return Object.freeze({
    record(record: SyncServerTelemetryRecord): void {
      assertEnum('endpoint', record.endpoint, SYNC_TELEMETRY_ENDPOINTS);
      assertEnum('outcome', record.outcome, SYNC_TELEMETRY_OUTCOMES);
      assertEnum('problem', record.problem, SYNC_TELEMETRY_PROBLEMS);
      assertEnum('bucket', record.bucket, SYNC_TELEMETRY_BUCKETS);
      if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
        throw new TypeError('Sync telemetry duration must be a finite non-negative number');
      }
      if (record.traceId !== undefined && !/^[A-Fa-f0-9]{16,64}$/u.test(record.traceId)) {
        throw new TypeError('Sync telemetry trace correlation is invalid');
      }
      input.metrics.increment('sync.server.requests_total');
      input.metrics.increment(`sync.server.endpoint.${record.endpoint}`);
      input.metrics.increment(`sync.server.outcome.${record.outcome}`);
      input.metrics.increment(`sync.server.problem.${record.problem}`);
      input.metrics.increment(`sync.server.bucket.${record.bucket}`);
      input.metrics.observe('sync.server.duration_ms', record.durationMs);
      input.logger.info({
        event: 'sync_request', endpoint: record.endpoint, outcome: record.outcome,
        problem: record.problem, bucket: record.bucket,
        ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
      }, 'sync request completed');
    },
  });
}

export function syncDurationBucket(durationMs: number): SyncTelemetryBucket {
  if (durationMs < 10) return 'under_10ms';
  if (durationMs < 100) return 'under_100ms';
  if (durationMs < 1_000) return 'under_1s';
  if (durationMs < 10_000) return 'under_10s';
  return 'over_10s';
}

function assertEnum<Name extends string, Value extends string>(
  name: Name,
  value: Value,
  allowed: readonly Value[],
): void {
  if (!allowed.includes(value)) throw new TypeError(`Sync telemetry ${name} is not a fixed value`);
}
