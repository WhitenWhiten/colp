import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  ONLINE_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * Explore popular ranking reads only collection-view counters from the rolling
 * day window. This compact covering index keeps that aggregate off the wider
 * daily primary key and lets it remain index-only after vacuum.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await ensureTransactionalPerformanceIndex(db, ONLINE_PERFORMANCE_INDEXES.exploreViews);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS publication_insight_daily_explore_views_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
