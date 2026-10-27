import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Retire protocol authority only after its Replica is retired.
 *
 * Sequence receipts, claims and lanes are retained for the Replica lifetime;
 * an active Replica therefore keeps every row forever. Once the Replica is
 * retired it can never issue another Sequence, so the worker can remove those
 * rows without weakening duplicate-claim protection for any live Replica.
 *
 * Node revision history has no Replica owner. It becomes reclaimable only below
 * a materialized history floor whose archive segment is verified: the floor is
 * the protocol watermark proving that no reader still needs those revisions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX sync_sequence_claims_replica_cleanup_idx
    ON sync_sequence_operation_claims(replica_id, sequence_scope, sequence_number)`.execute(db);
  await sql`CREATE INDEX sync_node_revision_history_commit_cleanup_idx
    ON sync_node_revision_history(collection_id, commit_ordinal)`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION enforce_sync_sequence_lane_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM sync_replicas replica
            WHERE replica.replica_id = OLD.replica_id AND replica.status = 'retired') THEN
          RETURN OLD;
        END IF;
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

  await sql`CREATE OR REPLACE FUNCTION forbid_sync_sequence_claim_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM sync_replicas replica
          WHERE replica.replica_id = OLD.replica_id AND replica.status = 'retired') THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'lifecycle-wide Sequence Operation claims are immutable'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION enforce_sync_sequence_receipt_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM sync_replicas replica
            WHERE replica.replica_id = OLD.replica_id AND replica.status = 'retired') THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'terminal Sequence receipts are immutable and retained'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.status <> 'deferred' THEN
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

  await sql`CREATE OR REPLACE FUNCTION forbid_sync_node_revision_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1 FROM sync_history_floors floor
        WHERE floor.collection_id = OLD.collection_id
          AND floor.floor_commit_ordinal > 0
          AND floor.archive_segment_id IS NOT NULL
          AND OLD.commit_ordinal < floor.floor_commit_ordinal
      ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'sync Node revision history is immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);
}

/** Developer-only destructive rollback; production uses expand/migrate/contract. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION forbid_sync_node_revision_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'sync Node revision history is immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION enforce_sync_sequence_receipt_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
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

  await sql`CREATE OR REPLACE FUNCTION forbid_sync_sequence_claim_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'lifecycle-wide Sequence Operation claims are immutable'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION enforce_sync_sequence_lane_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
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

  await sql`DROP INDEX sync_node_revision_history_commit_cleanup_idx`.execute(db);
  await sql`DROP INDEX sync_sequence_claims_replica_cleanup_idx`.execute(db);
}

export const migration: Migration = { up, down };
