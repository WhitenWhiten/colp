import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE digest_series
      ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS language text
  `.execute(db);
  await sql`
    ALTER TABLE digest_series
      DROP CONSTRAINT IF EXISTS digest_series_tags_array
  `.execute(db);
  await sql`
    ALTER TABLE digest_series
      ADD CONSTRAINT digest_series_tags_array CHECK (jsonb_typeof(tags) = 'array')
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS catalog_preferences (
      account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
      hidden_owner_account_ids jsonb NOT NULL CHECK (jsonb_typeof(hidden_owner_account_ids) = 'array'),
      hidden_tags jsonb NOT NULL CHECK (jsonb_typeof(hidden_tags) = 'array'),
      hidden_title_keywords jsonb NOT NULL CHECK (jsonb_typeof(hidden_title_keywords) = 'array'),
      preferred_languages jsonb NOT NULL CHECK (jsonb_typeof(preferred_languages) = 'array'),
      revision text NOT NULL CHECK (revision ~ '^[1-9][0-9]{0,18}$' AND length(revision) BETWEEN 1 AND 19),
      updated_at timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS digest_series_language_idx
      ON digest_series (language)
      WHERE language IS NOT NULL AND deleted_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS collections_catalog_language_idx
      ON collections ((payload_json #>> '{extensions,language}'))
      WHERE deleted_at IS NULL AND publication_slug IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collections_catalog_language_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS digest_series_language_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS catalog_preferences`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
