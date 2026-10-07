import { sql, type Kysely, type Migration } from 'kysely';
import {
  ensureTransactionalPerformanceIndex,
  FK_CASCADE_PERFORMANCE_INDEXES,
} from '../src/infrastructure/database/online-performance-indexes.js';

/**
 * Expand-only FK / cascade / lease-recovery indexes from the 2026-08-27
 * backend performance audit (IDX-05 / IDX-06). PostgreSQL never creates FK
 * indexes automatically, so every ON DELETE CASCADE / RESTRICT referencing
 * side below was a sequential scan. N-1 binaries ignore these indexes.
 *
 * - social_feed_items.collection_id: collections CASCADE plus the ops
 *   captureScope scan (feed-operations-postgres.ts) walk the whole table.
 * - social_public_activity.collection_id: collections CASCADE.
 * - notifications.actor_profile_id: the account-disable trigger deletes by
 *   actor_profile_id (202607290200 handle_account_disabled).
 * - notification_deliveries.recipient_account_id: ops listing filters on the
 *   FK-leading column; the composite FK has no supporting index.
 * - notification_deliveries leased recovery: the email claim takes
 *   state='leased' AND leased_until <= now, mirroring
 *   collection_invite_deliveries_leased_until_idx.
 * - relations from/to endpoints: relations_*_fk are ON DELETE RESTRICT and
 *   the existing endpoint indexes are partial (WHERE deleted_at IS NULL);
 *   FK integrity checks must also see tombstoned rows, so they need full
 *   indexes.
 *
 * Existing installations prebuild these manifest-owned indexes with
 * db:indexes:online; fresh/small databases build them in this transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const definition of FK_CASCADE_PERFORMANCE_INDEXES) {
    await ensureTransactionalPerformanceIndex(db, definition);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS relations_to_node_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS relations_from_node_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS notification_deliveries_leased_until_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS notification_deliveries_recipient_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS notifications_actor_profile_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS social_public_activity_collection_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS social_feed_items_collection_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
