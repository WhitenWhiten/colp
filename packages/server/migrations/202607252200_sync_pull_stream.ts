import { sql, type Kysely, type Migration } from 'kysely';

/** P3-20 expand: durable protocol projection and exact Pull keyset indexes. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE operations
    ADD COLUMN sync_wire_json jsonb CHECK (
      sync_wire_json IS NULL OR jsonb_typeof(sync_wire_json) = 'object'
    )`.execute(db);
  await sql`ALTER TABLE operations
    ADD COLUMN sync_stream_kind smallint GENERATED ALWAYS AS (0) STORED`.execute(db);
  await sql`DROP TRIGGER sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION forbid_sync_conflict_mutation()`.execute(db);
  await sql`ALTER TABLE sync_conflicts ADD COLUMN pull_wire_json jsonb`.execute(db);
  await sql`ALTER TABLE sync_conflicts
    ADD COLUMN sync_stream_kind smallint GENERATED ALWAYS AS (1) STORED`.execute(db);
  await sql`UPDATE sync_conflicts SET pull_wire_json = jsonb_strip_nulls(jsonb_build_object(
    'id', conflict_id,
    'collectionId', collection_id,
    'targetId', target_id,
    'type', conflict_type,
    'field', CASE WHEN jsonb_array_length(conflicting_fields) = 1 THEN conflicting_fields->>0 ELSE NULL END,
    'incomingOpId', operation_id,
    'createdAt', created_at,
    'status', status,
    'allowedResolutions', allowed_resolutions,
    'revision', revision
  ))`.execute(db);
  await sql`ALTER TABLE sync_conflicts ALTER COLUMN pull_wire_json SET NOT NULL`.execute(db);
  await sql`ALTER TABLE sync_conflicts ADD CONSTRAINT sync_conflicts_pull_wire_object
    CHECK (jsonb_typeof(pull_wire_json) = 'object')`.execute(db);
  await createConflictImmutabilityTrigger(db);
  await sql`CREATE INDEX operations_sync_pull_order_idx
    ON operations(collection_id, commit_ordinal, sync_stream_kind, operation_id COLLATE "C")
    INCLUDE (sync_wire_json)
    WHERE sync_wire_json IS NOT NULL`.execute(db);
  await sql`DROP INDEX sync_conflicts_pull_order_idx`.execute(db);
  await sql`CREATE INDEX sync_conflicts_pull_order_idx
    ON sync_conflicts(collection_id, commit_ordinal, sync_stream_kind, conflict_id COLLATE "C")
    INCLUDE (pull_wire_json)`.execute(db);
}

/** Developer-only destructive rollback after P3-20 readers and writers are drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS operations_sync_pull_order_idx`.execute(db);
  await sql`ALTER TABLE operations DROP COLUMN IF EXISTS sync_wire_json`.execute(db);
  await sql`ALTER TABLE operations DROP COLUMN IF EXISTS sync_stream_kind`.execute(db);
  await sql`DROP INDEX IF EXISTS sync_conflicts_pull_order_idx`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_conflict_mutation()`.execute(db);
  await sql`ALTER TABLE sync_conflicts DROP COLUMN IF EXISTS pull_wire_json`.execute(db);
  await sql`ALTER TABLE sync_conflicts DROP COLUMN IF EXISTS sync_stream_kind`.execute(db);
  await sql`CREATE INDEX sync_conflicts_pull_order_idx
    ON sync_conflicts(collection_id, commit_ordinal, conflict_id)`.execute(db);
  await createConflictImmutabilityTrigger(db);
}

async function createConflictImmutabilityTrigger(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION forbid_sync_conflict_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.status = 'open' AND NEW.status = 'resolved'
        AND NEW.revision <> OLD.revision
        AND (to_jsonb(NEW) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at',
          'sync_stream_kind']::text[])
          = (to_jsonb(OLD) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at',
          'sync_stream_kind']::text[])
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'sync Conflict is immutable outside its one open to resolved transition'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_conflicts_immutable
    BEFORE UPDATE OR DELETE ON sync_conflicts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_conflict_mutation()`.execute(db);
}

export const migration: Migration = { up, down };
