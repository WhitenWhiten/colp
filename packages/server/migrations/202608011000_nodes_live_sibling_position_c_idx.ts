import { sql, type Kysely, type Migration } from 'kysely';

/**
 * C-collation live-sibling index for R09 bounded placement reads.
 * Keeps the existing unique live-sibling index until duplicate-data and plan evidence complete.
 * Kysely runs PostgreSQL migrations in one transaction — CREATE INDEX CONCURRENTLY is unavailable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX nodes_live_sibling_position_c_idx
    ON nodes (collection_id, parent_id, (position_token COLLATE "C"), id)
    WHERE deleted_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS nodes_live_sibling_position_c_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
