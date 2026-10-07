import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_classification_settings (
    collection_id text PRIMARY KEY REFERENCES collections(id) ON DELETE RESTRICT,
    owner_subject_id text NOT NULL REFERENCES accounts(subject_id) ON DELETE RESTRICT,
    auto_tag_mode text NOT NULL DEFAULT 'off' CHECK (auto_tag_mode IN ('off','suggest')),
    max_auto_tags integer NOT NULL DEFAULT 3 CHECK (max_auto_tags BETWEEN 0 AND 3),
    execution_mode text NOT NULL DEFAULT 'server_managed' CHECK (execution_mode = 'server_managed'),
    provider_profile_id text CHECK (provider_profile_id IS NULL),
    revision bigint NOT NULL CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE collection_classification_settings`.execute(db);
}
