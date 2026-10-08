import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Follow-up to R10 (`202608011100`) after catalog tags moved into
 * `payload_json.extensions` (`202609230500`).
 *
 * Directory and Explore tag filters use the catalog COALESCE
 * (extensions.tags, then root tags). The original GIN was
 * `coalesce(payload_json->'tags', '[]')`, so the planner seq-scanned
 * the live/published set. Rebuild the same index name on the catalog
 * expression. `down` restores the R10 root-only index.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_publication_directory_tags_idx`.execute(db);
  await sql`CREATE INDEX collections_publication_directory_tags_idx
    ON collections USING gin ((coalesce(case when jsonb_typeof(payload_json->'extensions'->'tags') = 'array' then payload_json->'extensions'->'tags' end, case when jsonb_typeof(payload_json->'tags') = 'array' then payload_json->'tags' end, '[]'::jsonb)) jsonb_ops)
    WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_publication_directory_tags_idx`.execute(db);
  await sql`CREATE INDEX collections_publication_directory_tags_idx
    ON collections USING gin ((coalesce(payload_json->'tags', '[]'::jsonb)) jsonb_ops)
    WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
