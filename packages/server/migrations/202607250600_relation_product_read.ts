import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX relations_product_live_from_idx ON relations
    (collection_id, from_node_id, updated_at DESC, id COLLATE "C" ASC) WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX relations_product_live_to_idx ON relations
    (collection_id, to_node_id, updated_at DESC, id COLLATE "C" ASC) WHERE deleted_at IS NULL`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS relations_product_live_to_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS relations_product_live_from_idx`.execute(db);
}
