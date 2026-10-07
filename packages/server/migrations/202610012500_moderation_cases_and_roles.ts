import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS moderation_cases (
      id text PRIMARY KEY,
      reporter_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      target_kind text NOT NULL CHECK (
        target_kind IN ('collection', 'bookmark', 'digest_series', 'digest_edition', 'account', 'comment')
      ),
      target_id text NOT NULL,
      parent_id text,
      target_json jsonb NOT NULL,
      target_fingerprint text NOT NULL,
      category text NOT NULL CHECK (
        category IN ('spam', 'harassment', 'illegal_content', 'privacy', 'other')
      ),
      description text NOT NULL,
      status text NOT NULL CHECK (
        status IN ('submitted', 'in_review', 'resolved', 'dismissed')
      ),
      public_resolution text,
      assigned_to_account_id text REFERENCES accounts(id) ON DELETE RESTRICT,
      internal_note text,
      revision text NOT NULL CHECK (revision ~ '^[1-9][0-9]{0,18}$' AND length(revision) BETWEEN 1 AND 19),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS moderation_cases_open_dedupe
      ON moderation_cases (reporter_account_id, target_fingerprint, category)
      WHERE status IN ('submitted', 'in_review')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_cases_reporter_created_idx
      ON moderation_cases (reporter_account_id, created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_cases_official_created_idx
      ON moderation_cases (created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS moderation_evidence (
      id text PRIMARY KEY,
      case_id text NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
      target_json jsonb NOT NULL,
      captured_at timestamptz NOT NULL,
      source_revision text,
      title text,
      body_text text,
      source_url text,
      truncated boolean NOT NULL,
      record_bytes integer NOT NULL CHECK (record_bytes >= 0 AND record_bytes <= 65536),
      retain_until timestamptz NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_evidence_case_idx
      ON moderation_evidence (case_id, id)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS moderation_roles (
      account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE RESTRICT,
      reviewer boolean NOT NULL DEFAULT false,
      moderator boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL,
      CHECK (reviewer OR moderator)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS moderation_evidence`.execute(db);
  await sql`DROP TABLE IF EXISTS moderation_cases`.execute(db);
  await sql`DROP TABLE IF EXISTS moderation_roles`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
