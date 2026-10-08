import { sql, type Kysely, type Migration } from 'kysely';

/** P3-10 expand: durable Sequence lanes, lifetime Operation claims, and immutable replay receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_replica_id_ledger
    ADD CONSTRAINT sync_replica_id_ledger_collection_identity_unique
    UNIQUE (replica_id, collection_id)`.execute(db);
  await sql`ALTER TABLE sync_sessions
    ADD CONSTRAINT sync_sessions_sequence_binding_unique
    UNIQUE (session_id, collection_id, replica_id, lease_generation)`.execute(db);

  await sql`CREATE TABLE sync_sequence_lanes (
    replica_id text NOT NULL,
    collection_id text NOT NULL,
    sequence_scope text NOT NULL,
    next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
    retention_policy text NOT NULL DEFAULT 'replica_lifetime' CHECK (retention_policy = 'replica_lifetime'),
    retained_through_retirement boolean NOT NULL DEFAULT true CHECK (retained_through_retirement),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (replica_id, sequence_scope),
    CONSTRAINT sync_sequence_lane_collection_scope CHECK (
      sequence_scope = 'collection:' || collection_id
    ),
    CONSTRAINT sync_sequence_lane_replica_collection_fk
      FOREIGN KEY (replica_id, collection_id)
      REFERENCES sync_replica_id_ledger(replica_id, collection_id) ON DELETE RESTRICT,
    CONSTRAINT sync_sequence_lane_complete_identity_unique
      UNIQUE (replica_id, sequence_scope, collection_id)
  )`.execute(db);

  await sql`CREATE TABLE sync_sequence_operation_claims (
    operation_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT
      CHECK (length(operation_id) BETWEEN 1 AND 512),
    replica_id text NOT NULL,
    collection_id text NOT NULL,
    sequence_scope text NOT NULL,
    sequence_number bigint NOT NULL CHECK (sequence_number BETWEEN 1 AND 9007199254740991),
    canonical_digest text NOT NULL CHECK (canonical_digest ~ '^[0-9a-f]{64}$'),
    retention_policy text NOT NULL DEFAULT 'replica_lifetime' CHECK (retention_policy = 'replica_lifetime'),
    retained_through_retirement boolean NOT NULL DEFAULT true CHECK (retained_through_retirement),
    claimed_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT sync_sequence_claim_lane_unique
      UNIQUE (replica_id, sequence_scope, sequence_number),
    CONSTRAINT sync_sequence_claim_complete_unique
      UNIQUE (operation_id, replica_id, sequence_scope, sequence_number, canonical_digest),
    CONSTRAINT sync_sequence_claim_lane_fk
      FOREIGN KEY (replica_id, sequence_scope, collection_id)
      REFERENCES sync_sequence_lanes(replica_id, sequence_scope, collection_id) ON DELETE RESTRICT
  )`.execute(db);
  await sql`CREATE INDEX sync_sequence_claim_replica_retention_idx
    ON sync_sequence_operation_claims(replica_id, claimed_at, operation_id)`.execute(db);

  await sql`CREATE TABLE sync_sequence_receipts (
    replica_id text NOT NULL,
    collection_id text NOT NULL,
    sequence_scope text NOT NULL,
    sequence_number bigint NOT NULL CHECK (sequence_number BETWEEN 1 AND 9007199254740991),
    operation_id text NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 1 AND 512),
    canonical_digest text NOT NULL CHECK (canonical_digest ~ '^[0-9a-f]{64}$'),
    session_id text NOT NULL,
    lease_generation bigint NOT NULL CHECK (lease_generation > 0),
    server_batch_id text NOT NULL CHECK (length(server_batch_id) BETWEEN 1 AND 512),
    media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
    endpoint_identity text NOT NULL CHECK (length(endpoint_identity) BETWEEN 1 AND 512),
    status text NOT NULL CHECK (status IN ('applied','rebased','noop','conflicted','rejected','deferred')),
    result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
    terminal boolean GENERATED ALWAYS AS (status <> 'deferred') STORED,
    retention_policy text NOT NULL DEFAULT 'replica_lifetime' CHECK (retention_policy = 'replica_lifetime'),
    retained_through_retirement boolean NOT NULL DEFAULT true CHECK (retained_through_retirement),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    finalized_at timestamptz,
    PRIMARY KEY (replica_id, sequence_scope, sequence_number),
    CONSTRAINT sync_sequence_receipt_lane_unique
      UNIQUE (replica_id, sequence_scope, sequence_number),
    CONSTRAINT sync_sequence_receipt_claim_fk
      FOREIGN KEY (operation_id, replica_id, sequence_scope, sequence_number, canonical_digest)
      REFERENCES sync_sequence_operation_claims(
        operation_id, replica_id, sequence_scope, sequence_number, canonical_digest
      ) ON DELETE RESTRICT,
    CONSTRAINT sync_sequence_receipt_lane_fk
      FOREIGN KEY (replica_id, sequence_scope, collection_id)
      REFERENCES sync_sequence_lanes(replica_id, sequence_scope, collection_id) ON DELETE RESTRICT,
    CONSTRAINT sync_sequence_receipt_session_fk
      FOREIGN KEY (session_id, collection_id, replica_id, lease_generation)
      REFERENCES sync_sessions(session_id, collection_id, replica_id, lease_generation) ON DELETE RESTRICT,
    CONSTRAINT sync_sequence_receipt_batch_session_binding CHECK (
      server_batch_id = session_id OR
      (left(server_batch_id, length(session_id) + 1) = session_id || '.' AND
        length(server_batch_id) > length(session_id) + 1)
    ),
    CONSTRAINT sync_sequence_receipt_finalization CHECK (
      (status = 'deferred' AND finalized_at IS NULL) OR
      (status <> 'deferred' AND finalized_at IS NOT NULL)
    )
  )`.execute(db);
  await sql`CREATE INDEX sync_sequence_receipt_session_idx
    ON sync_sequence_receipts(session_id, sequence_number, operation_id)`.execute(db);

  await sql`CREATE FUNCTION enforce_sync_sequence_lane_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Sequence lanes are retained for the Replica lifetime'
          USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.next_sequence <> 1 THEN
          RAISE EXCEPTION 'Sequence lanes must start at one' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF NEW.replica_id IS DISTINCT FROM OLD.replica_id OR
         NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.sequence_scope IS DISTINCT FROM OLD.sequence_scope OR
         NEW.retention_policy IS DISTINCT FROM OLD.retention_policy OR
         NEW.retained_through_retirement IS DISTINCT FROM OLD.retained_through_retirement OR
         NEW.created_at IS DISTINCT FROM OLD.created_at OR
         NEW.next_sequence < OLD.next_sequence OR NEW.next_sequence > OLD.next_sequence + 1 THEN
        RAISE EXCEPTION 'Sequence lane identity and continuity are immutable'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.next_sequence = OLD.next_sequence + 1 AND NOT EXISTS (
        SELECT 1 FROM sync_sequence_receipts receipt
        WHERE receipt.replica_id = OLD.replica_id
          AND receipt.sequence_scope = OLD.sequence_scope
          AND receipt.sequence_number = OLD.next_sequence
          AND receipt.terminal
      ) THEN
        RAISE EXCEPTION 'Sequence lane cannot advance without its terminal receipt'
          USING ERRCODE = '23514';
      END IF;
      NEW.updated_at := current_timestamp;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_sequence_lanes_guard
    BEFORE INSERT OR UPDATE OR DELETE ON sync_sequence_lanes
    FOR EACH ROW EXECUTE FUNCTION enforce_sync_sequence_lane_transition()`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_sequence_claim_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'lifecycle-wide Sequence Operation claims are immutable'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_sequence_operation_claims_immutable
    BEFORE UPDATE OR DELETE ON sync_sequence_operation_claims
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_sequence_claim_mutation()`.execute(db);

  await sql`CREATE FUNCTION enforce_sync_sequence_receipt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
          SELECT 1 FROM sync_sequence_lanes lane
          WHERE lane.replica_id = NEW.replica_id
            AND lane.sequence_scope = NEW.sequence_scope
            AND lane.next_sequence = NEW.sequence_number
        ) THEN
          RAISE EXCEPTION 'Sequence receipt must finalize the locked expected Sequence'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' OR OLD.status <> 'deferred' THEN
        RAISE EXCEPTION 'terminal Sequence receipts are immutable and retained'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.replica_id IS DISTINCT FROM OLD.replica_id OR
         NEW.collection_id IS DISTINCT FROM OLD.collection_id OR
         NEW.sequence_scope IS DISTINCT FROM OLD.sequence_scope OR
         NEW.sequence_number IS DISTINCT FROM OLD.sequence_number OR
         NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
         NEW.canonical_digest IS DISTINCT FROM OLD.canonical_digest OR
         NEW.session_id IS DISTINCT FROM OLD.session_id OR
         NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR
         NEW.server_batch_id IS DISTINCT FROM OLD.server_batch_id OR
         NEW.media_type IS DISTINCT FROM OLD.media_type OR
         NEW.endpoint_identity IS DISTINCT FROM OLD.endpoint_identity OR
         NEW.retention_policy IS DISTINCT FROM OLD.retention_policy OR
         NEW.retained_through_retirement IS DISTINCT FROM OLD.retained_through_retirement OR
         NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'deferred Sequence receipt binding is immutable'
          USING ERRCODE = '23514';
      END IF;
      NEW.updated_at := current_timestamp;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_sequence_receipts_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON sync_sequence_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_sync_sequence_receipt_transition()`.execute(db);
}

/** Down is a developer-only destructive rollback; production retains ledgers through expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_sequence_receipts_immutable ON sync_sequence_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS enforce_sync_sequence_receipt_transition()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_sequence_operation_claims_immutable ON sync_sequence_operation_claims`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_sequence_claim_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_sequence_lanes_guard ON sync_sequence_lanes`.execute(db);
  await sql`DROP FUNCTION IF EXISTS enforce_sync_sequence_lane_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_sequence_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_sequence_operation_claims`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_sequence_lanes`.execute(db);
  await sql`ALTER TABLE sync_sessions
    DROP CONSTRAINT IF EXISTS sync_sessions_sequence_binding_unique`.execute(db);
  await sql`ALTER TABLE sync_replica_id_ledger
    DROP CONSTRAINT IF EXISTS sync_replica_id_ledger_collection_identity_unique`.execute(db);
}

export const migration: Migration = { up, down };
