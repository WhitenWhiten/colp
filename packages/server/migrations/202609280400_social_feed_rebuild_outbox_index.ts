import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  ONLINE_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * Feed rebuilds replay completed `social.collection-change` outbox rows by
 * scope and commit ordinal. The general outbox indexes either cover only
 * unfinished states or lead with claim timing columns, so completed history
 * otherwise degrades to a full ledger scan.
 *
 * Keep `state` in the covering payload because rebuilds deliberately detect
 * an unresolved source row and fail closed. The predicate therefore selects
 * the immutable handler/event identity rather than only `state='completed'`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureTransactionalPerformanceIndex(db, ONLINE_PERFORMANCE_INDEXES.feedRebuild);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS outbox_social_feed_rebuild_source_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
