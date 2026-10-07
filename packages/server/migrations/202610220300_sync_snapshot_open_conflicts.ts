import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P1-6: freeze the open conflicts covered by a Snapshot cut. The rows are the
 * recovery list; the cut row records that this Snapshot was checked, including
 * a count of zero. Receipts are the client's confirmation that it persisted
 * that list before bootstrap Ack.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_bootstrap_snapshot_conflicts (
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE CASCADE,
    conflict_index integer NOT NULL CHECK (conflict_index >= 0),
    conflict_id text NOT NULL,
    revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 128),
    wire_json jsonb NOT NULL,
    PRIMARY KEY (snapshot_id, conflict_index),
    UNIQUE (snapshot_id, conflict_id),
    CHECK (jsonb_typeof(wire_json) = 'object'
      AND NOT wire_json ? 'base' AND NOT wire_json ? 'server' AND NOT wire_json ? 'incoming')
  )`.execute(db);
  await sql`CREATE TABLE sync_bootstrap_snapshot_conflict_cuts (
    snapshot_id text PRIMARY KEY REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE CASCADE,
    conflict_count integer NOT NULL CHECK (conflict_count >= 0),
    conflict_digest text NOT NULL CHECK (conflict_digest ~ '^[0-9a-f]{64}$')
  )`.execute(db);
  await sql`CREATE TABLE sync_bootstrap_snapshot_conflict_receipts (
    snapshot_id text NOT NULL REFERENCES sync_bootstrap_snapshots(snapshot_id) ON DELETE CASCADE,
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    conflict_count integer NOT NULL CHECK (conflict_count >= 0),
    conflict_digest text NOT NULL CHECK (conflict_digest ~ '^[0-9a-f]{64}$'),
    confirmed_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (snapshot_id, session_id)
  )`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_bootstrap_snapshot_conflict_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'snapshot open conflict recovery facts are immutable';
    END $$`.execute(db);
  for (const table of [
    'sync_bootstrap_snapshot_conflicts',
    'sync_bootstrap_snapshot_conflict_cuts',
    'sync_bootstrap_snapshot_conflict_receipts',
  ] as const) {
    await sql.raw(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION forbid_sync_bootstrap_snapshot_conflict_update()`).execute(db);
  }
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    'sync_bootstrap_snapshot_conflict_receipts',
    'sync_bootstrap_snapshot_conflict_cuts',
    'sync_bootstrap_snapshot_conflicts',
  ] as const) {
    await sql.raw(`DROP TRIGGER IF EXISTS ${table}_immutable ON ${table}`).execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS forbid_sync_bootstrap_snapshot_conflict_update()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshot_conflict_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshot_conflict_cuts`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_bootstrap_snapshot_conflicts`.execute(db);
}

export const migration: Migration = { up, down };
