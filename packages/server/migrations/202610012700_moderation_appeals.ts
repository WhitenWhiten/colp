import { sql, type Kysely, type Migration } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS moderation_appeals (
      id text PRIMARY KEY,
      action_id text NOT NULL REFERENCES moderation_actions(id) ON DELETE RESTRICT,
      appellant_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      description text NOT NULL,
      status text NOT NULL CHECK (status IN ('submitted', 'upheld', 'rejected')),
      resolution text,
      revision text NOT NULL CHECK (revision ~ '^[1-9][0-9]{0,18}$' AND length(revision) BETWEEN 1 AND 19),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      decided_by_account_id text REFERENCES accounts(id) ON DELETE RESTRICT
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS moderation_appeals_open_action_idx
      ON moderation_appeals (action_id)
      WHERE status = 'submitted'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_appeals_appellant_created_idx
      ON moderation_appeals (appellant_account_id, created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_appeals_official_created_idx
      ON moderation_appeals (created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_appeals_status_created_idx
      ON moderation_appeals (status, created_at DESC, id DESC)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS moderation_evidence_retain_until_idx
      ON moderation_evidence (retain_until, id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS moderation_evidence_retain_until_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS moderation_appeals`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
