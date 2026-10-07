import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Sync Pull history floor authority.
 *
 * V1 deliberately supports operation tuples only. Canonical mutation allocates
 * a dense, continuous per-Collection operation ordinal range (documented in
 * docs/02-data-and-transactions.md section 4.2). Therefore the only accepted
 * proof is an exact [1, floor + 1) manifest with exactly `floor` rows.
 * This migration neither archives nor deletes any source row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE sync_history_floors (
    collection_id text PRIMARY KEY REFERENCES collections(id) ON DELETE RESTRICT,
    floor_commit_ordinal bigint NOT NULL DEFAULT 0 CHECK (floor_commit_ordinal >= 0),
    floor_stream_kind smallint NOT NULL DEFAULT 0 CHECK (floor_stream_kind = 0),
    floor_stable_id text NOT NULL DEFAULT '',
    archive_segment_id uuid REFERENCES ledger_archive_segments(segment_id) ON DELETE RESTRICT,
    state_revision bigint NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
    advanced_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT sync_history_floors_tuple_shape CHECK (
      (floor_commit_ordinal = 0 AND floor_stream_kind = 0
        AND floor_stable_id = '' AND archive_segment_id IS NULL AND state_revision = 0)
      OR (floor_commit_ordinal > 0 AND floor_stream_kind = 0
        AND length(floor_stable_id) BETWEEN 1 AND 512
        AND archive_segment_id IS NOT NULL AND state_revision > 0)
    ),
    CONSTRAINT sync_history_floors_advanced_at_finite CHECK (
      advanced_at > '-infinity'::timestamptz AND advanced_at < 'infinity'::timestamptz
    )
  )`.execute(db);

  await sql`CREATE FUNCTION guard_sync_history_floor_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE
      archive ledger_archive_segments%ROWTYPE;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Sync history floors cannot be truncated'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_truncate_guard';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Sync history floors cannot be deleted'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_delete_guard';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.floor_commit_ordinal <> 0 OR NEW.floor_stream_kind <> 0
           OR NEW.floor_stable_id <> '' OR NEW.archive_segment_id IS NOT NULL
           OR NEW.state_revision <> 0 THEN
          RAISE EXCEPTION 'Sync history floor must materialize at implicit zero'
            USING ERRCODE='23514', CONSTRAINT='sync_history_floors_transition_guard';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
         OR NEW.state_revision <> OLD.state_revision + 1
         OR NEW.floor_stream_kind <> 0
         OR (NEW.floor_commit_ordinal, NEW.floor_stream_kind,
             NEW.floor_stable_id COLLATE "C")
              <= (OLD.floor_commit_ordinal, OLD.floor_stream_kind,
                  OLD.floor_stable_id COLLATE "C")
         OR NEW.archive_segment_id IS NULL
         OR NEW.advanced_at < OLD.advanced_at THEN
        RAISE EXCEPTION 'Sync history floor must advance by one revision'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_transition_guard';
      END IF;

      -- Rare floor advances exclude concurrent Replica writes before taking any
      -- Replica row lock. Repository callers acquire this lock before updating
      -- the floor row; keeping it here makes direct SQL fail closed as well.
      LOCK TABLE sync_replicas IN SHARE MODE;

      IF NOT EXISTS (
        SELECT 1 FROM operations operation
         WHERE operation.collection_id = NEW.collection_id
           AND operation.commit_ordinal = NEW.floor_commit_ordinal
           AND operation.sync_stream_kind = 0
           AND operation.operation_id = NEW.floor_stable_id
           AND operation.sync_wire_json IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Sync history floor boundary is not an operation tuple'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_boundary_missing';
      END IF;

      SELECT * INTO archive FROM ledger_archive_segments segment
       WHERE segment.segment_id = NEW.archive_segment_id FOR SHARE;
      IF NOT FOUND
         OR archive.ledger_family <> 'operation'
         OR archive.source_relation <> 'public.operations'
         OR archive.source_scope <> 'collection:' || NEW.collection_id
         OR archive.source_key_kind <> 'bigint'
         OR archive.source_key_comparator <> 'signed-bigint-ascending-v1'
         OR lower(archive.source_key_bounds) <> 1
         OR upper(archive.source_key_bounds) <> NEW.floor_commit_ordinal + 1
         OR archive.row_count <> NEW.floor_commit_ordinal
         OR archive.source_bytes <= 0
         OR archive.archive_schema_version <> 1 THEN
        RAISE EXCEPTION 'Archive manifest does not bind the complete operation prefix'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_binding_mismatch';
      END IF;
      IF archive.state NOT IN (
          'verified','reader_cutover','detached','deletable','deleted'
         ) OR archive.verified_at IS NULL
         OR NOT (archive.stage_evidence ? 'verified') THEN
        RAISE EXCEPTION 'Archive manifest has not reached verified state'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_archive_not_verified';
      END IF;

      IF EXISTS (
        SELECT 1 FROM sync_replicas replica
         WHERE replica.collection_id = NEW.collection_id
           AND replica.status = 'active'
           AND (replica.checkpoint_commit_ordinal IS NULL
             OR replica.checkpoint_stream_kind IS NULL
             OR replica.checkpoint_stable_id IS NULL
             OR (replica.checkpoint_commit_ordinal, replica.checkpoint_stream_kind,
                 replica.checkpoint_stable_id COLLATE "C")
                  < (NEW.floor_commit_ordinal, NEW.floor_stream_kind,
                     NEW.floor_stable_id COLLATE "C"))
      ) THEN
        RAISE EXCEPTION 'An active Replica checkpoint is behind the Sync history floor'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_active_replica_behind';
      END IF;
      NEW.advanced_at := current_timestamp;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER sync_history_floors_transition_guard
    BEFORE INSERT OR UPDATE OR DELETE ON sync_history_floors
    FOR EACH ROW EXECUTE FUNCTION guard_sync_history_floor_transition()`.execute(db);
  await sql`CREATE TRIGGER sync_history_floors_truncate_guard
    BEFORE TRUNCATE ON sync_history_floors
    FOR EACH STATEMENT EXECUTE FUNCTION guard_sync_history_floor_transition()`.execute(db);

  await sql`CREATE FUNCTION create_sync_history_floor() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      INSERT INTO sync_history_floors(collection_id) VALUES (NEW.id);
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER collections_create_sync_history_floor
    AFTER INSERT ON collections FOR EACH ROW EXECUTE FUNCTION create_sync_history_floor()`.execute(db);
  await sql`INSERT INTO sync_history_floors(collection_id)
    SELECT collection.id FROM collections collection ON CONFLICT DO NOTHING`.execute(db);

  await sql`COMMENT ON TABLE sync_history_floors IS
    'Monotonic Sync Pull operation-history floor backed by verified archive evidence; advancement never deletes source data.'`.execute(db);
  await sql`COMMENT ON COLUMN sync_history_floors.archive_segment_id IS
    'Evidence binding only. It does not authorize archive, payload, operation, revision, receipt, or tombstone deletion.'`.execute(db);
}

/** Developer/test rollback only; never a history-retention action. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS collections_create_sync_history_floor ON collections`.execute(db);
  await sql`DROP FUNCTION IF EXISTS create_sync_history_floor()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_history_floors_truncate_guard ON sync_history_floors`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_history_floors_transition_guard ON sync_history_floors`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_sync_history_floor_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_history_floors`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
