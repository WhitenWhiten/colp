import { sql, type Kysely, type Migration } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS annotations_private_node_notes_keyset_idx
    ON annotations(collection_id, creator_principal_id, updated_at DESC, id COLLATE "C" ASC)
    WHERE subject_type = 'node' AND type = 'note' AND visibility = 'private' AND deleted_at IS NULL`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS annotations_private_node_notes_keyset_idx`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
