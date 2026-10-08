import { sql, type Kysely, type Migration } from 'kysely';

/** P3-22 expand: immutable Pull issue evidence and monotonic Replica Ack receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_replicas
    ADD COLUMN checkpoint_stream_kind smallint,
    ADD COLUMN checkpoint_stable_id text`.execute(db);

  // Pre-P3-22 checkpoints have no issued-cursor evidence or stable tie-breaker.
  await sql`UPDATE sync_replicas SET
      checkpoint_cursor = NULL,
      checkpoint_commit_ordinal = NULL,
      checkpoint_stream_kind = NULL,
      checkpoint_stable_id = NULL,
      wire_json = jsonb_set(jsonb_set(wire_json, '{checkpoint,acknowledgedCursor}', 'null'::jsonb),
        '{checkpoint,acknowledgedCommitOrdinal}', 'null'::jsonb)
    WHERE status <> 'retired' AND (checkpoint_cursor IS NOT NULL OR checkpoint_commit_ordinal IS NOT NULL)`.execute(db);
  await sql`UPDATE sync_replicas SET
      checkpoint_stream_kind = CASE WHEN checkpoint_commit_ordinal = 0 THEN 0 ELSE 1 END,
      checkpoint_stable_id = CASE WHEN checkpoint_commit_ordinal = 0 THEN '' ELSE left(checkpoint_cursor, 512) END
    WHERE status = 'retired' AND checkpoint_cursor IS NOT NULL AND checkpoint_commit_ordinal IS NOT NULL`.execute(db);

  await sql`ALTER TABLE sync_replicas ADD CONSTRAINT sync_replicas_checkpoint_tuple_check CHECK (
      (checkpoint_cursor IS NULL AND checkpoint_commit_ordinal IS NULL
        AND checkpoint_stream_kind IS NULL AND checkpoint_stable_id IS NULL)
      OR
      (checkpoint_cursor IS NOT NULL AND checkpoint_commit_ordinal IS NOT NULL
        AND checkpoint_stream_kind IN (0,1) AND checkpoint_stable_id IS NOT NULL
        AND ((checkpoint_commit_ordinal = 0 AND checkpoint_stream_kind = 0 AND checkpoint_stable_id = '')
          OR (checkpoint_commit_ordinal > 0 AND length(checkpoint_stable_id) BETWEEN 1 AND 512)))
    )`.execute(db);

  await sql`CREATE TABLE sync_pull_cursor_evidence (
    evidence_id bigserial PRIMARY KEY,
    cursor text NOT NULL CHECK (length(cursor) BETWEEN 1 AND 128),
    cursor_digest text NOT NULL CHECK (length(cursor_digest) = 64),
    session_id text NOT NULL,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    policy_revision text NOT NULL,
    protocol_version text NOT NULL CHECK (protocol_version = '0.1'),
    tuple_commit_ordinal bigint NOT NULL CHECK (tuple_commit_ordinal >= 0),
    tuple_stream_kind smallint NOT NULL CHECK (tuple_stream_kind IN (0,1)),
    tuple_stable_id text NOT NULL,
    cursor_expires_at timestamptz NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT current_timestamp,
    upper_commit_ordinal bigint NOT NULL CHECK (upper_commit_ordinal >= 0),
    upper_stream_kind smallint NOT NULL CHECK (upper_stream_kind IN (0,1)),
    upper_stable_id text NOT NULL,
    collection_revision text NOT NULL,
    page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 1000),
    purge_commit_ordinal bigint NOT NULL CHECK (purge_commit_ordinal >= 0),
    purge_stream_kind smallint NOT NULL CHECK (purge_stream_kind IN (0,1)),
    purge_stable_id text NOT NULL,
    CONSTRAINT sync_pull_cursor_evidence_session_scope_fk FOREIGN KEY (
      session_id, account_id, collection_id, replica_id
    ) REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE RESTRICT,
    CONSTRAINT sync_pull_cursor_evidence_generation_fk FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT,
    CONSTRAINT sync_pull_cursor_evidence_expiry_check CHECK (cursor_expires_at > issued_at),
    CONSTRAINT sync_pull_cursor_evidence_tuple_check CHECK (
      (tuple_commit_ordinal = 0 AND tuple_stream_kind = 0 AND tuple_stable_id = '')
      OR (tuple_commit_ordinal > 0 AND length(tuple_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_pull_cursor_evidence_upper_check CHECK (
      (upper_commit_ordinal = 0 AND upper_stream_kind = 0 AND upper_stable_id = '')
      OR (upper_commit_ordinal > 0 AND length(upper_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_pull_cursor_evidence_purge_check CHECK (
      (purge_commit_ordinal = 0 AND purge_stream_kind = 0 AND purge_stable_id = '')
      OR (purge_commit_ordinal > 0 AND length(purge_stable_id) BETWEEN 1 AND 512)
    ),
    CONSTRAINT sync_pull_cursor_evidence_receipt_scope_unique UNIQUE (
      session_id, account_id, collection_id, replica_id, lease_generation, cursor_digest
    ),
    UNIQUE (replica_id, cursor_digest)
  )`.execute(db);
  await sql`CREATE INDEX sync_pull_cursor_evidence_scope_tuple_idx
    ON sync_pull_cursor_evidence(replica_id, lease_generation, tuple_commit_ordinal,
      tuple_stream_kind, tuple_stable_id COLLATE "C")`.execute(db);

  await sql`CREATE TABLE sync_ack_receipts (
    principal_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
    request_digest text NOT NULL CHECK (length(request_digest) = 64),
    session_id text NOT NULL,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    cursor_digest text NOT NULL CHECK (length(cursor_digest) = 64),
    result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    result_digest text NOT NULL CHECK (length(result_digest) = 64),
    claimed_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    PRIMARY KEY (principal_id, idempotency_key),
    CONSTRAINT sync_ack_receipts_session_scope_fk FOREIGN KEY (
      session_id, principal_id, collection_id, replica_id
    ) REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE RESTRICT,
    CONSTRAINT sync_ack_receipts_generation_fk FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT,
    CONSTRAINT sync_ack_receipts_cursor_evidence_fk FOREIGN KEY (
      session_id, principal_id, collection_id, replica_id, lease_generation, cursor_digest
    ) REFERENCES sync_pull_cursor_evidence(
      session_id, account_id, collection_id, replica_id, lease_generation, cursor_digest
    ) ON DELETE RESTRICT,
    CONSTRAINT sync_ack_receipts_time_check CHECK (completed_at >= claimed_at)
  )`.execute(db);
  await sql`CREATE INDEX sync_ack_receipts_replica_completed_idx
    ON sync_ack_receipts(replica_id, completed_at, idempotency_key)`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_ack_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Sync Pull cursor evidence and completed Ack receipts are immutable';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_pull_cursor_evidence_immutable
    BEFORE UPDATE OR DELETE ON sync_pull_cursor_evidence
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_ack_authority_mutation()`.execute(db);
  await sql`CREATE TRIGGER sync_ack_receipts_immutable
    BEFORE UPDATE OR DELETE ON sync_ack_receipts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_ack_authority_mutation()`.execute(db);
}

/** Developer-only destructive rollback after P3-22 readers and writers are drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_ack_receipts_immutable ON sync_ack_receipts`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_pull_cursor_evidence_immutable ON sync_pull_cursor_evidence`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_ack_authority_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_ack_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_pull_cursor_evidence`.execute(db);
  await sql`ALTER TABLE sync_replicas DROP CONSTRAINT IF EXISTS sync_replicas_checkpoint_tuple_check,
    DROP COLUMN IF EXISTS checkpoint_stream_kind,
    DROP COLUMN IF EXISTS checkpoint_stable_id`.execute(db);
}

export const migration: Migration = { up, down };
