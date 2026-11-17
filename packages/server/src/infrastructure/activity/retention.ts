import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';

export const ACTIVITY_RETENTION_BATCH_SIZE = 1000;
export const ACTIVITY_RETENTION_INTERVAL_MS = 3_600_000;
/** Yield after this many batches so a large backlog never monopolizes a worker. */
export const ACTIVITY_RETENTION_MAX_BATCHES = 8;
/** Wall-clock budget per pass; the remainder waits for the next tick. */
export const ACTIVITY_RETENTION_TIME_BUDGET_MS = 1_000;

/**
 * A bounded batch from each retention arm. The arms are separate statements so
 * each one can use its own index; the caller drains until both return short.
 */
export async function purgeActivity(db: Kysely<DatabaseSchema>, limit = ACTIVITY_RETENTION_BATCH_SIZE): Promise<number> {
  const occurred = await sql`WITH expired AS (SELECT id FROM activity_items
    WHERE occurred_at<clock_timestamp()-interval '365 days'
    ORDER BY occurred_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    DELETE FROM activity_items USING expired WHERE activity_items.id=expired.id RETURNING activity_items.id`.execute(db);
  const read = await sql`WITH expired AS (SELECT id FROM activity_items
    WHERE read_at IS NOT NULL AND updated_at<clock_timestamp()-interval '90 days'
    ORDER BY updated_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    DELETE FROM activity_items USING expired WHERE activity_items.id=expired.id RETURNING activity_items.id`.execute(db);
  return occurred.rows.length + read.rows.length;
}

export interface ActivityRetentionDrainOptions {
  /** Hard cap on full batches per pass; the remainder waits for the next tick. */
  readonly maxBatches?: number;
  /** Wall-clock budget for the whole pass (same shape as SyncEvidenceMaintenanceJob). */
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
  /** Checked before every batch so `stop()` never waits for the whole backlog. */
  readonly stopped?: () => boolean;
}

/**
 * Run bounded batches until an arm comes back short, the batch cap is reached,
 * the time budget is spent, or the schedule was stopped — without holding one
 * long lock and without letting one tick drain an unbounded backlog.
 */
export async function drainActivityRetention(
  purge: (limit: number) => Promise<number>,
  batchSize = ACTIVITY_RETENTION_BATCH_SIZE,
  options: ActivityRetentionDrainOptions = {},
): Promise<number> {
  const maxBatches = options.maxBatches ?? ACTIVITY_RETENTION_MAX_BATCHES;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new TypeError('Invalid activity retention batch cap.');
  }
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.timeBudgetMs ?? ACTIVITY_RETENTION_TIME_BUDGET_MS);
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (options.stopped?.() === true) return total;
    const deleted = await purge(batchSize);
    total += deleted;
    if (deleted < batchSize) return total;
    if (now() >= deadline) return total;
  }
  return total;
}

export interface ActivityRetentionSchedule {
  /** Run one bounded pass, sharing an in-flight pass instead of overlapping it. */
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Run at start and on every tick. A restart shorter than the interval therefore
 * still catches up, while the immediate pass stays off the readiness path. Each
 * pass is bounded (max batches / time budget), and `stop()` both prevents new
 * batches and awaits only the batch already in flight.
 */
export function scheduleActivityRetention(
  purge: (limit: number) => Promise<number>,
  options: {
    readonly intervalMs?: number;
    readonly batchSize?: number;
    readonly maxBatches?: number;
    readonly timeBudgetMs?: number;
    readonly now?: () => number;
    readonly onError?: (error: unknown) => void;
  } = {},
): ActivityRetentionSchedule {
  const intervalMs = options.intervalMs ?? ACTIVITY_RETENTION_INTERVAL_MS;
  const batchSize = options.batchSize ?? ACTIVITY_RETENTION_BATCH_SIZE;
  let active: Promise<number> | undefined;
  let stopped = false;
  const runOnce = (): Promise<number> => {
    active ??= drainActivityRetention(purge, batchSize, {
      ...(options.maxBatches === undefined ? {} : { maxBatches: options.maxBatches }),
      ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      stopped: () => stopped,
    })
      .catch((error: unknown) => {
        try { options.onError?.(error); } catch { /* the next tick remains eligible */ }
        return 0;
      })
      .finally(() => { active = undefined; });
    return active;
  };
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  timer.unref();
  void runOnce();
  return { runOnce, async stop() { stopped = true; clearInterval(timer); await active; } };
}
