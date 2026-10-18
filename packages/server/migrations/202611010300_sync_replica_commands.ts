import { sql, type Kysely } from 'kysely';

/**
 * Expand-only: what the owner asked a browser to do from the Sync center. A
 * command names only an action and, optionally, one issue of the browser's last
 * report, never data. It reaches the browser in a health report response and its
 * result comes back in a later report. Nothing here touches lease, cursor or
 * lifecycle authority. Previous binaries ignore the table and the column.
 *
 * `sync_replica_reports.health_actions` keeps what the last report offered for
 * the whole replica, so a command is only accepted for an action on offer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_replica_reports ADD COLUMN health_actions text[] NOT NULL DEFAULT '{}'
    CHECK (health_actions <@ ARRAY['retry','resume','rebuild']::text[])`.execute(db);
  await sql`CREATE TABLE sync_replica_commands (
    command_id text PRIMARY KEY CHECK (command_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (action IN ('retry','use_server','keep_local','discard_local','delete','keep',
      'resume','rebuild')),
    issue_id text CHECK (issue_id ~ '^[A-Za-z0-9._~-]{1,128}$'),
    state text NOT NULL CHECK (state IN ('pending','delivered','done','failed','expired')),
    result_code text CHECK (result_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    created_at timestamptz NOT NULL,
    delivered_at timestamptz,
    completed_at timestamptz,
    expires_at timestamptz NOT NULL,
    CONSTRAINT sync_replica_commands_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT sync_replica_commands_outcome_check CHECK (
      (state IN ('pending','delivered') AND completed_at IS NULL AND result_code IS NULL)
      OR (state IN ('done','failed','expired') AND completed_at IS NOT NULL))
  )`.execute(db);
  await sql`CREATE INDEX sync_replica_commands_replica_idx
    ON sync_replica_commands (replica_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX sync_replica_commands_account_idx ON sync_replica_commands (account_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE sync_replica_commands`.execute(db);
  await sql`ALTER TABLE sync_replica_reports DROP COLUMN health_actions`.execute(db);
}
