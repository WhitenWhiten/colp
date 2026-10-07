import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  HOT_PATH_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * Expand-only hot-path indexes from the 2026-08-27 backend performance audit
 * (IDX-01 / IDX-03 / IDX-04). No index is dropped; N-1 binaries ignore them.
 *
 * 1. outbox claim: both projection_latest_only EXISTS probes correlate on
 *    (handler_name, aggregate_id) over unfinished rows; the earlier-ordinal
 *    probe additionally compares commit_ordinal. Without this index each
 *    claim rescans the claim/lease indexes per candidate, degrading linearly
 *    with backlog size.
 * 2. classify inbox: cross-collection keyset ORDER BY n.created_at DESC,
 *    n.id COLLATE "C" DESC over live bookmarks of owned collections
 *    (classify-inbox-query.ts) had no created_at-ordered index at all.
 * 3./4. insight purge: purgeExpired batches walk the globally oldest rows
 *    (events by occurred_at, daily by day); the existing
 *    (collection_id, occurred_at) index and the collection_id-leading PK
 *    cannot serve either scan.
 *
 * Existing installations prebuild these manifest-owned indexes with
 * db:indexes:online; fresh/small databases build them in this transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Earlier migrations in the same Migrator transaction may have queued
  // DEFERRABLE INITIALLY DEFERRED trigger events on nodes (phase1 AFTER
  // INSERT OR UPDATE, plus FK constraint triggers). CREATE INDEX refuses
  // while those events are pending.
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db);
  for (const definition of HOT_PATH_PERFORMANCE_INDEXES) {
    await ensureTransactionalPerformanceIndex(db, definition);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS publication_insight_daily_day_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS publication_insight_events_occurred_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_live_bookmark_created_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS outbox_events_handler_aggregate_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
