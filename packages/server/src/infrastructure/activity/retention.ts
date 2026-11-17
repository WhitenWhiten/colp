import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';

export const ACTIVITY_RETENTION_BATCH_SIZE = 1000;
export const ACTIVITY_RETENTION_INTERVAL_MS = 3_600_000;

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

/** Run full batches until an arm comes back short, without holding one long lock. */
export async function drainActivityRetention(
  purge: (limit: number) => Promise<number>,
  batchSize = ACTIVITY_RETENTION_BATCH_SIZE,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await purge(batchSize);
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

export interface ActivityRetentionSchedule {
  /** Run one bounded pass, sharing an in-flight pass instead of overlapping it. */
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Run at start and on every tick. A restart shorter than the interval therefore
 * still catches up, while the immediate pass stays off the readiness path.
 */
export function scheduleActivityRetention(
  purge: (limit: number) => Promise<number>,
  options: {
    readonly intervalMs?: number;
    readonly batchSize?: number;
    readonly onError?: (error: unknown) => void;
  } = {},
): ActivityRetentionSchedule {
  const intervalMs = options.intervalMs ?? ACTIVITY_RETENTION_INTERVAL_MS;
  const batchSize = options.batchSize ?? ACTIVITY_RETENTION_BATCH_SIZE;
  let active: Promise<number> | undefined;
  const runOnce = (): Promise<number> => {
    active ??= drainActivityRetention(purge, batchSize)
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
  return { runOnce, async stop() { clearInterval(timer); await active; } };
}
