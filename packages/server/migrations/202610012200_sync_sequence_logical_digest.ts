import { sql, type Kysely, type Migration } from 'kysely';

/**
 * T-07: Sequence receipts store which digest algorithm produced canonical_digest.
 * v1 includes HTTP attempt fields; v2 is the logical Operation. Old rows stay v1
 * and remain replayable when Operation bytes still match.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sync_sequence_operation_claims
      ADD COLUMN digest_algorithm text NOT NULL DEFAULT 'known.sync-sequence.v1'
      CHECK (digest_algorithm IN ('known.sync-sequence.v1','known.sync-sequence.logical.v2'))
  `.execute(db);
  await sql`
    ALTER TABLE sync_sequence_receipts
      ADD COLUMN digest_algorithm text NOT NULL DEFAULT 'known.sync-sequence.v1'
      CHECK (digest_algorithm IN ('known.sync-sequence.v1','known.sync-sequence.logical.v2'))
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION enforce_sync_sequence_receipt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
           NEW.digest_algorithm IS DISTINCT FROM OLD.digest_algorithm OR
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
    $$
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION enforce_sync_sequence_receipt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
    $$
  `.execute(db);
  await sql`ALTER TABLE sync_sequence_receipts DROP COLUMN IF EXISTS digest_algorithm`.execute(db);
  await sql`ALTER TABLE sync_sequence_operation_claims DROP COLUMN IF EXISTS digest_algorithm`.execute(db);
}

export const migration: Migration = { up, down };
