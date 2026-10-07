import { sql, type Kysely, type Migration } from 'kysely';

/** P3-18 expand: one canonical resolution transition plus immutable exact-replay receipts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION forbid_sync_conflict_mutation()`.execute(db);
  await sql`ALTER TABLE sync_conflicts
    ADD COLUMN resolved_by_operation_id text,
    ADD COLUMN resolved_by_principal_id text REFERENCES accounts(id) ON DELETE RESTRICT,
    ADD COLUMN resolution text CHECK (resolution IN ('server','incoming','custom','both')),
    ADD COLUMN resolution_result_json jsonb CHECK (
      resolution_result_json IS NULL OR jsonb_typeof(resolution_result_json) = 'object'
    ),
    ADD COLUMN resolved_at timestamptz,
    ADD CONSTRAINT sync_conflicts_resolution_operation_fk
      FOREIGN KEY (resolved_by_operation_id, collection_id)
      REFERENCES operations(operation_id, collection_id)
      DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT sync_conflicts_resolution_complete_check CHECK (
      (status = 'open' AND resolved_by_operation_id IS NULL AND resolved_by_principal_id IS NULL
        AND resolution IS NULL AND resolution_result_json IS NULL AND resolved_at IS NULL)
      OR
      (status = 'resolved' AND resolved_by_operation_id IS NOT NULL AND resolved_by_principal_id IS NOT NULL
        AND resolution IS NOT NULL AND resolution_result_json IS NOT NULL AND resolved_at IS NOT NULL)
    ),
    ADD CONSTRAINT sync_conflicts_resolved_operation_unique UNIQUE (resolved_by_operation_id)`.execute(db);

  await sql`CREATE TABLE sync_conflict_resolution_receipts (
    principal_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    conflict_id text NOT NULL REFERENCES sync_conflicts(conflict_id) ON DELETE RESTRICT,
    conflict_revision text NOT NULL CHECK (
      length(conflict_revision) BETWEEN 1 AND 128 AND conflict_revision ~ '^[A-Za-z0-9._~-]+$'
    ),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
    request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    resolution text NOT NULL CHECK (resolution IN ('server','incoming','custom','both')),
    result_json jsonb CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object'),
    result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
    operation_id text REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (principal_id, conflict_id, conflict_revision, idempotency_key),
    CHECK ((completed_at IS NULL AND result_json IS NULL AND result_digest IS NULL AND operation_id IS NULL)
      OR (completed_at IS NOT NULL AND result_json IS NOT NULL AND result_digest IS NOT NULL
        AND operation_id IS NOT NULL))
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX sync_conflict_one_completed_resolution_receipt
    ON sync_conflict_resolution_receipts(conflict_id) WHERE completed_at IS NOT NULL`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_conflict_resolution_receipt_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
        AND (to_jsonb(NEW) - ARRAY['result_json','result_digest','operation_id','completed_at']::text[])
          = (to_jsonb(OLD) - ARRAY['result_json','result_digest','operation_id','completed_at']::text[])
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'sync Conflict resolution receipt is immutable'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_conflict_resolution_receipts_immutable
    BEFORE UPDATE OR DELETE ON sync_conflict_resolution_receipts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_conflict_resolution_receipt_mutation()`.execute(db);

  await sql`CREATE FUNCTION forbid_sync_conflict_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.status = 'open' AND NEW.status = 'resolved'
        AND NEW.revision <> OLD.revision
        AND (to_jsonb(NEW) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at']::text[])
          = (to_jsonb(OLD) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at']::text[])
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

/** Developer-only destructive rollback after the P3-18 resolver has been drained. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_conflict_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS sync_conflict_resolution_receipts_immutable
    ON sync_conflict_resolution_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_sync_conflict_resolution_receipt_mutation()`.execute(db);
  await sql`DROP TABLE IF EXISTS sync_conflict_resolution_receipts`.execute(db);
  await sql`ALTER TABLE sync_conflicts
    DROP CONSTRAINT IF EXISTS sync_conflicts_resolution_complete_check,
    DROP CONSTRAINT IF EXISTS sync_conflicts_resolution_operation_fk,
    DROP CONSTRAINT IF EXISTS sync_conflicts_resolved_operation_unique,
    DROP COLUMN IF EXISTS resolved_at,
    DROP COLUMN IF EXISTS resolution_result_json,
    DROP COLUMN IF EXISTS resolution,
    DROP COLUMN IF EXISTS resolved_by_principal_id,
    DROP COLUMN IF EXISTS resolved_by_operation_id`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_conflict_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'sync Conflict is immutable until canonical resolution support is deployed'
          USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'sync Conflict is immutable' USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_conflicts_immutable
    BEFORE UPDATE OR DELETE ON sync_conflicts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_conflict_mutation()`.execute(db);
}

export const migration: Migration = { up, down };
