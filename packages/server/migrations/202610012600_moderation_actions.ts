import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS moderation_actions (
      id text PRIMARY KEY,
      case_id text NOT NULL REFERENCES moderation_cases(id) ON DELETE RESTRICT,
      target_kind text NOT NULL CHECK (
        target_kind IN ('collection', 'bookmark', 'digest_series', 'digest_edition', 'account', 'comment')
      ),
      target_id text NOT NULL,
      parent_id text,
      target_json jsonb NOT NULL,
      target_fingerprint text NOT NULL,
      action text NOT NULL CHECK (
        action IN (
          'delist', 'hide_public', 'restrict_interaction', 'restrict_publication',
          'hide_comment', 'lock_comments'
        )
      ),
      reason text NOT NULL,
      actor_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      state text NOT NULL CHECK (state IN ('active', 'revoked')),
      revision text NOT NULL CHECK (revision ~ '^[1-9][0-9]{0,18}$' AND length(revision) BETWEEN 1 AND 19),
      created_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoke_reason text,
      revoked_by_account_id text REFERENCES accounts(id) ON DELETE RESTRICT
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_actions_target_active_idx
      ON moderation_actions (target_kind, target_id, action)
      WHERE state = 'active'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_actions_case_idx
      ON moderation_actions (case_id, created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_actions_created_idx
      ON moderation_actions (created_at DESC, id DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS moderation_actions`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
