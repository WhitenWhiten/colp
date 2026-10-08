import { sql, type Kysely, type Migration } from 'kysely';

/** P3-25 expand: immutable, Replica-lifetime retirement command receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_replica_retirement_receipts (
    replica_id text NOT NULL REFERENCES sync_replicas(replica_id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL CHECK (
      octet_length(idempotency_key) BETWEEN 1 AND 512
      AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'
    ),
    principal_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    session_id text NOT NULL REFERENCES sync_sessions(session_id) ON DELETE RESTRICT,
    collection_id text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    retired_lifecycle_revision bigint NOT NULL CHECK (retired_lifecycle_revision > 0),
    result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
    completed_at timestamptz NOT NULL,
    PRIMARY KEY (replica_id, idempotency_key),
    FOREIGN KEY (replica_id, lease_generation)
      REFERENCES sync_replica_generations(replica_id, lease_generation) ON DELETE RESTRICT
  )`.execute(db);
  await sql`CREATE INDEX sync_replica_retirement_receipts_principal_idx
    ON sync_replica_retirement_receipts (principal_id, completed_at)`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_replica_retirement_receipt_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Sync Replica retirement receipt is immutable'; END $$`.execute(db);
  await sql`CREATE TRIGGER sync_replica_retirement_receipts_immutable
    BEFORE UPDATE OR DELETE ON sync_replica_retirement_receipts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_replica_retirement_receipt_mutation()`.execute(db);
}

/** Developer-only destructive rollback; production uses forward-compatible expansion. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_replica_retirement_receipts_immutable
    ON sync_replica_retirement_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_replica_retirement_receipt_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_replica_retirement_receipts`.execute(db);
}

export const migration: Migration = { up, down };
