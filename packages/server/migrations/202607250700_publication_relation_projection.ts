import { sql, type Kysely } from 'kysely';

/** Stable collection-wide Publication Relation keyset order for P2B-13. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX relations_live_publication_keyset_idx
    ON relations (
      collection_id,
      (from_node_id COLLATE "C"),
      (to_node_id COLLATE "C"),
      (type COLLATE "C"),
      (id COLLATE "C")
    )
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX relations_live_publication_cursor_locator_idx
    ON relations (collection_id, publication_locator_sha256_128(id))
    WHERE deleted_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS relations_live_publication_cursor_locator_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS relations_live_publication_keyset_idx`.execute(db);
}
