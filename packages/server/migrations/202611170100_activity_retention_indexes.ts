import { sql, type Kysely } from 'kysely';

/**
 * Serve each activity retention arm independently.
 *
 * The 365-day arm has no additional predicate, so it needs a plain
 * `(occurred_at, id)` btree for its ordered, bounded candidate scan. The
 * 90-day arm only ever selects read rows, so its `updated_at` index stays
 * partial and unread activity never enters that scan. Both carry `id` so the
 * keyset ORDER BY and LIMIT walk the index instead of sorting the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX activity_items_occurred_retention_idx
    ON activity_items(occurred_at,id)`.execute(db);
  await sql`CREATE INDEX activity_items_read_retention_idx
    ON activity_items(updated_at,id) WHERE read_at IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS activity_items_read_retention_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS activity_items_occurred_retention_idx`.execute(db);
}
