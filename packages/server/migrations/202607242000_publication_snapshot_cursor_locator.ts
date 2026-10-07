import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // PostgreSQL marks convert_to(text, name) STABLE. This wrapper fixes the
  // target encoding, making the locator deterministic and index-safe.
  await sql`
    CREATE FUNCTION publication_locator_sha256_128(source text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      PARALLEL SAFE
      SET search_path = pg_catalog
      AS $$
        SELECT pg_catalog.encode(
          pg_catalog.substr(
            pg_catalog.sha256(pg_catalog.convert_to(source, 'UTF8')),
            1,
            16
          ),
          'hex'
        )
      $$
  `.execute(db);
  await sql`
    CREATE INDEX nodes_live_publication_cursor_locator_idx
      ON nodes (
        collection_id,
        publication_locator_sha256_128(id)
      )
      WHERE deleted_at IS NULL AND NOT is_root
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS nodes_live_publication_cursor_locator_idx`.execute(db);
  await sql`DROP FUNCTION IF EXISTS publication_locator_sha256_128(text)`.execute(db);
}
