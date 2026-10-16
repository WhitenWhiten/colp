import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX nodes_live_folder_share_keyset_idx ON nodes (collection_id, id COLLATE "C")
    WHERE deleted_at IS NULL AND kind IN ('folder', 'bookmark')`.execute(db);
  await sql`CREATE INDEX relations_live_folder_share_keyset_idx ON relations (collection_id, id COLLATE "C")
    WHERE deleted_at IS NULL AND visibility = 'public'`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS relations_live_folder_share_keyset_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS nodes_live_folder_share_keyset_idx`.execute(db);
}
