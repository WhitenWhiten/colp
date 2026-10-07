import { sql, type Kysely, type Migration } from 'kysely';

/**
 * R10 Directory q/tag filter indexes.
 * Adds one normalized generated column for the q substring filter and a trigram GIN
 * plus a jsonb GIN so both filters stay index-backed on the live/published predicate.
 * The directory search text is the NFC contract (plain lower()), deliberately distinct
 * from the NFKC search_text column so full-width/ligature compatibility never matches.
 * Kysely runs PostgreSQL migrations in one transaction — CREATE INDEX CONCURRENTLY is unavailable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collections
    ADD COLUMN directory_search_text text GENERATED ALWAYS AS (
      lower(coalesce(title, '') || ' ' || coalesce(summary, ''))
    ) STORED`.execute(db);
  // The q filter is always a '%term%' pattern, so this search column must not carry
  // histogram/MCV stats.  patternsel_common consults the column histogram even for a
  // fully-wildcarded pattern, and a single random histogram boundary landing on a rare
  // term inflates the LIKE estimate from the 0.0001 floor to ~1/bucket (~0.01), which
  // flips the planner from the trigram GIN to the full-table order index.  With no
  // stats the estimate is the deterministic 0.0001 heuristic floor and the GIN path
  // always wins.  (pg_trgm has no statistics-support machinery in PG16 regardless.)
  await sql`ALTER TABLE collections ALTER COLUMN directory_search_text SET STATISTICS 0`.execute(db);
  await sql`CREATE INDEX collections_publication_directory_search_trgm_idx
    ON collections USING gin (directory_search_text public.gin_trgm_ops)
    WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL`.execute(db);
  await sql`CREATE INDEX collections_publication_directory_tags_idx
    ON collections USING gin ((coalesce(payload_json->'tags', '[]'::jsonb)) jsonb_ops)
    WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_publication_directory_tags_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collections_publication_directory_search_trgm_idx`.execute(db);
  await sql`ALTER TABLE collections DROP COLUMN IF EXISTS directory_search_text`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
