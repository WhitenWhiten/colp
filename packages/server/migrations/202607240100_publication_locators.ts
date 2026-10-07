import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collections
    ADD COLUMN publication_slug text,
    ADD COLUMN published_at timestamptz`.execute(db);
  // At this point every index key is NULL, so the required heap scan produces
  // no index entries to sort or build. The index then protects the backfill.
  await sql`CREATE UNIQUE INDEX collections_publication_slug_unique
    ON collections(publication_slug) WHERE publication_slug IS NOT NULL`.execute(db);
  await sql`ALTER TABLE collections
    ADD CONSTRAINT collections_publication_slug_canonical CHECK (
      publication_slug IS NULL OR (
        publication_slug = lower(publication_slug)
        AND length(publication_slug) BETWEEN 3 AND 263
        AND publication_slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'
      )
    ) NOT VALID,
    ADD CONSTRAINT collections_published_locator_required CHECK (
      visibility NOT IN ('public', 'unlisted')
      OR (publication_slug IS NOT NULL AND published_at IS NOT NULL)
    ) NOT VALID`.execute(db);
  // Kysely runs PostgreSQL migrations in one transaction, so CONCURRENTLY is
  // unavailable here. NOT VALID avoids separate validation scans. The scoped
  // backfill below still updates and row-locks legacy public/unlisted rows.
  await sql`UPDATE collections
    SET publication_slug = 'legacy-' || encode(convert_to(id, 'UTF8'), 'hex'),
        published_at = updated_at
    WHERE visibility IN ('public', 'unlisted')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_publication_slug_unique`.execute(db);
  await sql`ALTER TABLE collections
    DROP CONSTRAINT IF EXISTS collections_published_locator_required,
    DROP CONSTRAINT IF EXISTS collections_publication_slug_canonical,
    DROP COLUMN IF EXISTS published_at,
    DROP COLUMN IF EXISTS publication_slug`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
