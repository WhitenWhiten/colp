/**
 * Snapshot generated/completed/expires comparisons must use one PostgreSQL
 * clock. A JS Date parameter can land ahead of current_timestamp and invert
 * the completion window CHECK (generated <= completed < expires).
 */

export const SNAPSHOT_GENERATED_AT_SQL = 'current_timestamp';

export function snapshotExpiresAtSql(ttlMsPlaceholder: string): string {
  return `current_timestamp + (${ttlMsPlaceholder}::bigint * interval '1 millisecond')`;
}

export const SNAPSHOT_COMPLETED_AT_SQL = 'GREATEST(generated_at, current_timestamp)';

export function snapshotCompletionWindowHolds(generatedMs: number, completedMs: number, expiresMs: number): boolean {
  return generatedMs <= completedMs && completedMs < expiresMs;
}

/** GREATEST(generated_at, dbNow) keeps the CHECK when generated_at was a future JS Date. */
export function snapshotCompletedAtMs(generatedMs: number, databaseNowMs: number): number {
  return Math.max(generatedMs, databaseNowMs);
}
