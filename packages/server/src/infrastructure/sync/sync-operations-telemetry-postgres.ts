import { sql } from 'kysely';
import type { DatabaseRuntime } from '../database/index.js';
import type { Metrics } from '../telemetry/index.js';
import { syncDurationBucket, type SyncTelemetryBucket } from '../telemetry/sync-server.js';

export const SYNC_OPERATIONAL_METRICS = Object.freeze([
  'sync.queue.deferred',
  'sync.queue.oldest_age_ms',
  'sync.conflicts.open',
  'sync.conflicts.oldest_age_ms',
  'sync.recovery.required',
  'sync.purge.pending_tombstones',
  'sync.purge.oldest_age_ms',
] as const);

export interface SyncOperationalTelemetrySnapshot {
  readonly queue: { readonly deferred: number; readonly oldestAgeMs: number };
  readonly conflicts: { readonly open: number; readonly oldestAgeMs: number };
  readonly recovery: { readonly required: number };
  readonly purge: { readonly pendingTombstones: number; readonly oldestAgeMs: number };
}

interface SyncOperationalLogger {
  info(bindings: Record<string, unknown>, message: string): unknown;
}

export function createPostgresSyncOperationalTelemetry(
  database: Pick<DatabaseRuntime, 'db'>,
) {
  if (!database?.db) throw new TypeError('Sync operational telemetry requires PostgreSQL');
  return Object.freeze({
    async inspect(): Promise<SyncOperationalTelemetrySnapshot> {
      const [queue, conflicts, recovery, purge] = await Promise.all([
        sql<{ count: string; oldest_age_ms: number | string | null }>`
          select count(*)::text as count,
            coalesce(extract(epoch from (current_timestamp - min(created_at))) * 1000, 0) as oldest_age_ms
          from sync_sequence_receipts where status = 'deferred'
        `.execute(database.db),
        sql<{ count: string; oldest_age_ms: number | string | null }>`
          select count(*)::text as count,
            coalesce(extract(epoch from (current_timestamp - min(created_at))) * 1000, 0) as oldest_age_ms
          from sync_conflicts where status = 'open'
        `.execute(database.db),
        sql<{ count: string }>`
          select count(*)::text as count from sync_replicas where status = 'recovery_required'
        `.execute(database.db),
        sql<{ count: string; oldest_age_ms: number | string | null }>`
          select count(*)::text as count,
            coalesce(extract(epoch from (current_timestamp - min(purge_after))) * 1000, 0) as oldest_age_ms
          from sync_node_tombstones
          where payload_purged_at is null and purge_after <= current_timestamp
        `.execute(database.db),
      ]);
      return deepFreeze({
        queue: renameQueue(countAndAge(queue.rows[0], 'deferred queue')),
        conflicts: renameCount(countAndAge(conflicts.rows[0], 'open Conflict')),
        recovery: { required: boundedCount(recovery.rows[0]?.count, 'recovery backlog') },
        purge: renamePurge(countAndAge(purge.rows[0], 'purge backlog')),
      });
    },
  });
}

export function publishSyncOperationalTelemetry(
  snapshot: SyncOperationalTelemetrySnapshot,
  metrics: Metrics,
  logger: SyncOperationalLogger,
): void {
  assertSnapshot(snapshot);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[0], snapshot.queue.deferred);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[1], snapshot.queue.oldestAgeMs);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[2], snapshot.conflicts.open);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[3], snapshot.conflicts.oldestAgeMs);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[4], snapshot.recovery.required);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[5], snapshot.purge.pendingTombstones);
  metrics.gauge(SYNC_OPERATIONAL_METRICS[6], snapshot.purge.oldestAgeMs);
  logger.info({
    event: 'sync_operational_snapshot',
    deferredQueue: snapshot.queue.deferred,
    queueLagBucket: ageBucket(snapshot.queue.oldestAgeMs),
    openConflicts: snapshot.conflicts.open,
    conflictAgeBucket: ageBucket(snapshot.conflicts.oldestAgeMs),
    recoveryRequired: snapshot.recovery.required,
    pendingPurge: snapshot.purge.pendingTombstones,
    purgeAgeBucket: ageBucket(snapshot.purge.oldestAgeMs),
  }, 'sync operational snapshot published');
}

function countAndAge(
  row: { readonly count: string; readonly oldest_age_ms: number | string | null } | undefined,
  label: string,
) {
  return Object.freeze({
    count: boundedCount(row?.count, `${label} count`),
    oldestAgeMs: boundedAge(row?.oldest_age_ms, `${label} age`),
  });
}

function renameCount(value: { readonly count: number; readonly oldestAgeMs: number }) {
  return Object.freeze({ open: value.count, oldestAgeMs: value.oldestAgeMs });
}

function renameQueue(value: { readonly count: number; readonly oldestAgeMs: number }) {
  return Object.freeze({ deferred: value.count, oldestAgeMs: value.oldestAgeMs });
}

function renamePurge(value: { readonly count: number; readonly oldestAgeMs: number }) {
  return Object.freeze({ pendingTombstones: value.count, oldestAgeMs: value.oldestAgeMs });
}

function boundedCount(value: unknown, label: string): number {
  const count = typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new TypeError(`Sync operational ${label} is invalid`);
  }
  return count as number;
}

function boundedAge(value: unknown, label: string): number {
  const age = typeof value === 'string' && value.trim() !== '' ? Number(value) : value ?? 0;
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) {
    throw new TypeError(`Sync operational ${label} is invalid`);
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(age));
}

function assertSnapshot(value: SyncOperationalTelemetrySnapshot): void {
  boundedCount(value?.queue?.deferred, 'deferred queue count');
  boundedAge(value?.queue?.oldestAgeMs, 'deferred queue age');
  boundedCount(value?.conflicts?.open, 'open Conflict count');
  boundedAge(value?.conflicts?.oldestAgeMs, 'open Conflict age');
  boundedCount(value?.recovery?.required, 'recovery backlog');
  boundedCount(value?.purge?.pendingTombstones, 'purge backlog count');
  boundedAge(value?.purge?.oldestAgeMs, 'purge backlog age');
}

function ageBucket(value: number): SyncTelemetryBucket {
  return syncDurationBucket(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
