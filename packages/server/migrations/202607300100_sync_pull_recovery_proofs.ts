import { sql, type Kysely, type Migration } from 'kysely';

/** P3-38: bounded digest-only proof for expired Pull cursor recovery. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_bootstrap_snapshots ADD COLUMN recovery_pull_page_limit integer
    CHECK (recovery_pull_page_limit IS NULL OR recovery_pull_page_limit BETWEEN 1 AND 1000)`.execute(db);
  await sql`CREATE TABLE sync_pull_cursor_recovery_proofs (
    proof_id bigserial PRIMARY KEY,
    cursor_digest text NOT NULL CHECK (length(cursor_digest) = 64),
    authority_session_id text NOT NULL,
    authority_lifecycle_revision bigint NOT NULL CHECK (authority_lifecycle_revision > 0),
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
    upper_commit_ordinal bigint NOT NULL CHECK (upper_commit_ordinal >= 0),
    upper_stream_kind smallint NOT NULL CHECK (upper_stream_kind IN (0,1)),
    upper_stable_id text NOT NULL,
    purge_commit_ordinal bigint NOT NULL CHECK (purge_commit_ordinal >= 0),
    purge_stream_kind smallint NOT NULL CHECK (purge_stream_kind IN (0,1)),
    purge_stable_id text NOT NULL,
    cursor_expires_at timestamptz NOT NULL,
    proof_expires_at timestamptz NOT NULL,
    issued_at timestamptz NOT NULL,
    consumed_at timestamptz,
    UNIQUE (replica_id, cursor_digest),
    CONSTRAINT sync_pull_cursor_recovery_proofs_session_fk FOREIGN KEY (
      authority_session_id, account_id, collection_id, replica_id
    ) REFERENCES sync_sessions(session_id, account_id, collection_id, replica_id) ON DELETE CASCADE,
    CONSTRAINT sync_pull_cursor_recovery_proofs_generation_fk FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE CASCADE,
    CONSTRAINT sync_pull_cursor_recovery_proofs_retention_check
      CHECK (proof_expires_at > cursor_expires_at AND cursor_expires_at > issued_at),
    CONSTRAINT sync_pull_cursor_recovery_proofs_consumed_check
      CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
    CONSTRAINT sync_pull_cursor_recovery_proofs_tuple_upper_check CHECK (
      tuple_commit_ordinal < upper_commit_ordinal OR
      (tuple_commit_ordinal = upper_commit_ordinal AND tuple_stream_kind < upper_stream_kind) OR
      (tuple_commit_ordinal = upper_commit_ordinal AND tuple_stream_kind = upper_stream_kind
        AND tuple_stable_id <= upper_stable_id)
    ),
    CONSTRAINT sync_pull_cursor_recovery_proofs_purge_tuple_check CHECK (
      purge_commit_ordinal < tuple_commit_ordinal OR
      (purge_commit_ordinal = tuple_commit_ordinal AND purge_stream_kind < tuple_stream_kind) OR
      (purge_commit_ordinal = tuple_commit_ordinal AND purge_stream_kind = tuple_stream_kind
        AND purge_stable_id <= tuple_stable_id)
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_pull_cursor_recovery_proofs_cleanup_idx
    ON sync_pull_cursor_recovery_proofs(proof_expires_at, replica_id)`.execute(db);
  await sql`CREATE FUNCTION guard_sync_pull_cursor_recovery_proof() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
          AND (to_jsonb(NEW) - 'consumed_at') = (to_jsonb(OLD) - 'consumed_at') THEN RETURN NEW; END IF;
      IF TG_OP = 'DELETE' AND (OLD.proof_expires_at <= current_timestamp OR OLD.consumed_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=OLD.replica_id
            AND replica.status IN ('recovery_required', 'retired'))) THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'Sync Pull cursor recovery proof is immutable outside consumption and cleanup';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_pull_cursor_recovery_proofs_immutable
    BEFORE UPDATE OR DELETE ON sync_pull_cursor_recovery_proofs
    FOR EACH ROW EXECUTE FUNCTION guard_sync_pull_cursor_recovery_proof()`.execute(db);

  // Existing evidence predates the configurable writer; retain it for one conservative month.
  await sql`INSERT INTO sync_pull_cursor_recovery_proofs (
      cursor_digest,authority_session_id,authority_lifecycle_revision,account_id,collection_id,
      replica_id,lease_generation,policy_revision,protocol_version,page_limit,
      tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,upper_commit_ordinal,upper_stream_kind,
      upper_stable_id,purge_commit_ordinal,purge_stream_kind,purge_stable_id,cursor_expires_at,
      proof_expires_at,issued_at)
    SELECT evidence.cursor_digest,evidence.session_id,session.lifecycle_revision,evidence.account_id,
      evidence.collection_id,evidence.replica_id,evidence.lease_generation,evidence.policy_revision,
      evidence.protocol_version,evidence.page_limit,evidence.tuple_commit_ordinal,
      evidence.tuple_stream_kind,evidence.tuple_stable_id,evidence.upper_commit_ordinal,
      evidence.upper_stream_kind,evidence.upper_stable_id,evidence.purge_commit_ordinal,
      evidence.purge_stream_kind,evidence.purge_stable_id,evidence.cursor_expires_at,
      evidence.cursor_expires_at + interval '30 days',evidence.issued_at
    FROM sync_pull_cursor_evidence evidence
    JOIN sync_sessions session ON session.session_id=evidence.session_id
    ON CONFLICT (replica_id,cursor_digest) DO NOTHING`.execute(db);

  await sql`DROP TRIGGER sync_pull_cursor_evidence_immutable ON sync_pull_cursor_evidence`.execute(db);
  await sql`CREATE FUNCTION guard_sync_pull_cursor_evidence_retention() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.cursor IS NULL AND OLD.cursor IS NOT NULL
          AND (OLD.cursor_expires_at <= current_timestamp OR EXISTS (
            SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=OLD.replica_id
              AND replica.status IN ('recovery_required', 'retired')))
          AND (to_jsonb(NEW) - 'cursor') = (to_jsonb(OLD) - 'cursor') THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' AND (OLD.cursor_expires_at <= current_timestamp OR EXISTS (
            SELECT 1 FROM sync_replicas replica WHERE replica.replica_id=OLD.replica_id
              AND replica.status IN ('recovery_required', 'retired')))
          AND NOT EXISTS (SELECT 1 FROM sync_ack_receipts receipt
            WHERE receipt.replica_id=OLD.replica_id AND receipt.cursor_digest=OLD.cursor_digest)
          AND NOT EXISTS (SELECT 1 FROM sync_replicas replica
            WHERE replica.replica_id=OLD.replica_id AND replica.checkpoint_cursor=OLD.cursor) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Sync Pull cursor evidence is immutable outside bounded expiry cleanup';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_pull_cursor_evidence_immutable
    BEFORE UPDATE OR DELETE ON sync_pull_cursor_evidence
    FOR EACH ROW EXECUTE FUNCTION guard_sync_pull_cursor_evidence_retention()`.execute(db);
  await sql`ALTER TABLE sync_pull_cursor_evidence ALTER COLUMN cursor DROP NOT NULL`.execute(db);
}

/** Developer-only destructive rollback after P3-38 readers and writers are drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_pull_cursor_evidence_immutable ON sync_pull_cursor_evidence`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_sync_pull_cursor_evidence_retention()`.execute(db);
  await sql`DELETE FROM sync_pull_cursor_evidence WHERE cursor IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM sync_ack_receipts receipt
      WHERE receipt.session_id = sync_pull_cursor_evidence.session_id
        AND receipt.principal_id = sync_pull_cursor_evidence.account_id
        AND receipt.collection_id = sync_pull_cursor_evidence.collection_id
        AND receipt.replica_id = sync_pull_cursor_evidence.replica_id
        AND receipt.lease_generation = sync_pull_cursor_evidence.lease_generation
        AND receipt.cursor_digest = sync_pull_cursor_evidence.cursor_digest
    )`.execute(db);
  await sql`UPDATE sync_pull_cursor_evidence SET cursor = 'redacted' WHERE cursor IS NULL`.execute(db);
  await sql`ALTER TABLE sync_pull_cursor_evidence ALTER COLUMN cursor SET NOT NULL`.execute(db);
  await sql`CREATE TRIGGER sync_pull_cursor_evidence_immutable
    BEFORE UPDATE OR DELETE ON sync_pull_cursor_evidence
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_ack_authority_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_pull_cursor_recovery_proofs_immutable
    ON sync_pull_cursor_recovery_proofs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_sync_pull_cursor_recovery_proof()`.execute(db);
  await sql`DROP TABLE sync_pull_cursor_recovery_proofs`.execute(db);
  await sql`ALTER TABLE sync_bootstrap_snapshots DROP COLUMN recovery_pull_page_limit`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
