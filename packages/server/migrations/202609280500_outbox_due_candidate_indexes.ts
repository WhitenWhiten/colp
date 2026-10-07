import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  ONLINE_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * The worker selects queued work and expired leases through separate ordered
 * branches. Keep each branch's readiness timestamp and deterministic tie-break
 * in one partial index so PostgreSQL can stop after the first eligible row
 * instead of merging two states and sorting a growing backlog.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureTransactionalPerformanceIndex(db, ONLINE_PERFORMANCE_INDEXES.outboxPending);
  await ensureTransactionalPerformanceIndex(db, ONLINE_PERFORMANCE_INDEXES.outboxExpiredLease);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS outbox_expired_lease_due_candidate_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS outbox_pending_due_candidate_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
