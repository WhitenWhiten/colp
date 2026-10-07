import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-L-035: digest-only signed lineage that outlives cursor evidence and
 * recovery proofs. One immutable row per (replica_id, cursor_digest) keeps the
 * minimal issuance facts (cursor digest, binding, last tuple, expiry) plus a
 * purpose-separated receipt, so a legitimately expired long-offline cursor is
 * provably old while random/tampered cursors stay invalid. The full signed
 * cursor payload is never stored.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_pull_cursor_lineage (
    lineage_id bigserial PRIMARY KEY,
    cursor_digest text NOT NULL CHECK (length(cursor_digest) = 64),
    session_id text NOT NULL,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE CASCADE,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    policy_revision text NOT NULL,
    protocol_version text NOT NULL CHECK (protocol_version IN ('0.1','0.2')),
    page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 1000),
    tuple_commit_ordinal bigint NOT NULL CHECK (tuple_commit_ordinal >= 0),
    tuple_stream_kind smallint NOT NULL CHECK (tuple_stream_kind IN (0,1)),
    tuple_stable_id text NOT NULL,
    cursor_expires_at timestamptz NOT NULL,
    lineage_expires_at timestamptz NOT NULL,
    issued_at timestamptz NOT NULL,
    key_version text NOT NULL CHECK (length(key_version) BETWEEN 1 AND 64),
    receipt text NOT NULL CHECK (length(receipt) BETWEEN 1 AND 256),
    UNIQUE (replica_id, cursor_digest),
    CONSTRAINT sync_pull_cursor_lineage_session_scope_fk FOREIGN KEY (
      session_id, account_id, collection_id, replica_id
    ) REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE CASCADE,
    CONSTRAINT sync_pull_cursor_lineage_generation_fk FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE CASCADE,
    CONSTRAINT sync_pull_cursor_lineage_retention_check
      CHECK (lineage_expires_at > cursor_expires_at AND cursor_expires_at > issued_at),
    CONSTRAINT sync_pull_cursor_lineage_tuple_check CHECK (
      (tuple_commit_ordinal = 0 AND tuple_stream_kind = 0 AND tuple_stable_id = '')
      OR (tuple_commit_ordinal > 0 AND length(tuple_stable_id) BETWEEN 1 AND 512)
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_pull_cursor_lineage_cleanup_idx
    ON sync_pull_cursor_lineage(lineage_expires_at, replica_id)`.execute(db);
  await sql`CREATE FUNCTION guard_sync_pull_cursor_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND (OLD.lineage_expires_at <= current_timestamp OR EXISTS (
            SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=OLD.replica_id
              AND replica.status IN ('recovery_required', 'retired'))) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync Pull cursor lineage is immutable outside expiry cleanup';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_pull_cursor_lineage_immutable
    BEFORE UPDATE OR DELETE ON sync_pull_cursor_lineage
    FOR EACH ROW EXECUTE FUNCTION guard_sync_pull_cursor_lineage()`.execute(db);
}

/** Developer-only destructive rollback after FIX-L-035 readers and writers are drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_pull_cursor_lineage_immutable ON sync_pull_cursor_lineage`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_sync_pull_cursor_lineage()`.execute(db);
  await sql`DROP TABLE sync_pull_cursor_lineage`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
