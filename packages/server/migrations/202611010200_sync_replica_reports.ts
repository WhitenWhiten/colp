import { sql, type Kysely } from 'kysely';

/**
 * Expand-only: what each replica last reported about its own sync. Health is a
 * display fact from the extension (state, reason, set-aside issues); Ack warnings
 * are the latest `warnings` of a successful Ack. Neither touches lease, cursor or
 * lifecycle authority. Previous binaries ignore the table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_replica_reports (
    replica_id text PRIMARY KEY REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    health_state text CHECK (health_state IN ('syncing','degraded','stopped','paused')),
    health_code text CHECK (health_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    health_since timestamptz,
    health_revision bigint CHECK (health_revision > 0),
    health_reported_at timestamptz,
    issue_total integer CHECK (issue_total >= 0),
    issues jsonb CHECK (jsonb_typeof(issues) = 'array' AND jsonb_array_length(issues) <= 50
      AND octet_length(issues::text) <= 32768),
    extension_version text CHECK (extension_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
    ack_warnings jsonb CHECK (jsonb_typeof(ack_warnings) = 'array' AND octet_length(ack_warnings::text) <= 65536),
    ack_warnings_at timestamptz,
    CONSTRAINT sync_replica_reports_health_group_check CHECK (
      (health_state IS NULL AND health_code IS NULL AND health_since IS NULL AND health_revision IS NULL
        AND health_reported_at IS NULL AND issue_total IS NULL AND issues IS NULL AND extension_version IS NULL)
      OR (health_state IS NOT NULL AND health_since IS NOT NULL AND health_revision IS NOT NULL
        AND health_reported_at IS NOT NULL AND issue_total IS NOT NULL AND issues IS NOT NULL
        AND (health_state <> 'stopped' OR health_code IS NOT NULL))),
    CONSTRAINT sync_replica_reports_ack_group_check CHECK ((ack_warnings IS NULL) = (ack_warnings_at IS NULL))
  )`.execute(db);
  await sql`CREATE INDEX sync_replica_reports_account_idx ON sync_replica_reports (account_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE sync_replica_reports`.execute(db);
}
