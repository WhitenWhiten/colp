import { sql, type Kysely } from 'kysely';

/**
 * COLP Server: `allow_search_indexing` is the public discovery opt-in ("lets
 * search engines index the public pages"). It no longer limits what an owner
 * or member finds in their own collections, so the collection member recall
 * GINs drop it from their partial predicate. Same names, so the R11 member
 * branches keep their index-backed plans. Nodes and annotations never had it.
 * Kysely runs PostgreSQL migrations in one transaction — CREATE INDEX
 * CONCURRENTLY is unavailable; a self-hosted library is small.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_search_member_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_member_vector_idx`.execute(db);
  await sql`CREATE INDEX collections_search_member_trgm_idx
    ON collections USING gin (search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX collections_search_member_vector_idx
    ON collections USING gin (search_vector)
    WHERE deleted_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_search_member_vector_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_search_member_trgm_idx`.execute(db);
  await sql`CREATE INDEX collections_search_member_trgm_idx
    ON collections USING gin (search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND allow_search_indexing`.execute(db);
  await sql`CREATE INDEX collections_search_member_vector_idx
    ON collections USING gin (search_vector)
    WHERE deleted_at IS NULL AND allow_search_indexing`.execute(db);
}
