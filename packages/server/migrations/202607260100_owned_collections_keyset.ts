import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Exact live owned-list comparator: owner, updated_at DESC, bytewise id ASC. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX collections_owned_live_updated_id_idx
    ON collections (owner_subject_id, updated_at DESC, (id COLLATE "C") ASC)
    WHERE deleted_at IS NULL`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_owned_live_updated_id_idx`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
