import { sql, type Kysely, type Migration } from 'kysely';

/**
 * SYNC-Q-011 D1: expand page-level Pull evidence.
 *
 * Each Pull response writes at most one envelope row. Signed event cursors stay
 * HMAC-stateless. Ack/checkpoint still reference next-cursor evidence during
 * this expand; this table is the new authority for page range and handoff.
 *
 * Kysely runs PostgreSQL migrations in one transaction, so CONCURRENTLY index
 * creation is not available.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_pull_page_evidence (
    page_id bigserial PRIMARY KEY,
    page_digest text NOT NULL CHECK (length(page_digest) = 64),
    next_cursor_digest text NOT NULL CHECK (length(next_cursor_digest) = 64),
    session_id text NOT NULL,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    lifecycle_revision bigint NOT NULL CHECK (lifecycle_revision >= 0),
    policy_revision text NOT NULL,
    protocol_version text NOT NULL CHECK (protocol_version IN ('0.1','0.2')),
    page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 1000),
    event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 1000),
    lower_commit_ordinal bigint NOT NULL CHECK (lower_commit_ordinal >= 0),
    lower_stream_kind smallint NOT NULL CHECK (lower_stream_kind IN (0,1)),
    lower_stable_id text NOT NULL,
    upper_commit_ordinal bigint NOT NULL CHECK (upper_commit_ordinal >= 0),
    upper_stream_kind smallint NOT NULL CHECK (upper_stream_kind IN (0,1)),
    upper_stable_id text NOT NULL,
    purge_commit_ordinal bigint NOT NULL CHECK (purge_commit_ordinal >= 0),
    purge_stream_kind smallint NOT NULL CHECK (purge_stream_kind IN (0,1)),
    purge_stable_id text NOT NULL,
    page_expires_at timestamptz NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT sync_pull_page_evidence_session_scope_fk FOREIGN KEY (
      session_id, account_id, collection_id, replica_id
    ) REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE RESTRICT,
    CONSTRAINT sync_pull_page_evidence_generation_fk FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT,
    CONSTRAINT sync_pull_page_evidence_expiry_check CHECK (page_expires_at > issued_at),
    CONSTRAINT sync_pull_page_evidence_lower_check CHECK (
      (lower_commit_ordinal = 0 AND lower_stream_kind = 0 AND lower_stable_id = '')
      OR (lower_commit_ordinal > 0 AND length(lower_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_pull_page_evidence_upper_check CHECK (
      (upper_commit_ordinal = 0 AND upper_stream_kind = 0 AND upper_stable_id = '')
      OR (upper_commit_ordinal > 0 AND length(upper_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_pull_page_evidence_purge_check CHECK (
      (purge_commit_ordinal = 0 AND purge_stream_kind = 0 AND purge_stable_id = '')
      OR (purge_commit_ordinal > 0 AND length(purge_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_pull_page_evidence_receipt_scope_unique UNIQUE (
      session_id, account_id, collection_id, replica_id, lease_generation, next_cursor_digest
    ),
    UNIQUE (replica_id, next_cursor_digest),
    UNIQUE (replica_id, page_digest)
  )`.execute(db);
  await sql`CREATE INDEX sync_pull_page_evidence_cleanup_idx
    ON sync_pull_page_evidence(page_expires_at, replica_id)`.execute(db);
  await sql`CREATE FUNCTION guard_sync_pull_page_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND (OLD.page_expires_at <= current_timestamp OR EXISTS (
            SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=OLD.replica_id
              AND replica.status IN ('recovery_required', 'retired')))
          AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts receipt
            WHERE receipt.replica_id=OLD.replica_id AND receipt.cursor_digest=OLD.next_cursor_digest)
          AND NOT EXISTS (SELECT 1 FROM sync_replicas replica
            JOIN sync_pull_cursor_evidence evidence
              ON evidence.replica_id=replica.replica_id
             AND evidence.cursor=replica.checkpoint_cursor
            WHERE replica.replica_id=OLD.replica_id
              AND evidence.cursor_digest=OLD.next_cursor_digest) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync Pull page evidence is immutable outside expiry cleanup';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_pull_page_evidence_immutable
    BEFORE UPDATE OR DELETE ON sync_pull_page_evidence
    FOR EACH ROW EXECUTE FUNCTION guard_sync_pull_page_evidence()`.execute(db);
}

/** Developer-only destructive rollback after SYNC-Q-011 readers drain the expand table. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_pull_page_evidence_immutable
    ON sync_pull_page_evidence`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_sync_pull_page_evidence()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_pull_page_evidence`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
