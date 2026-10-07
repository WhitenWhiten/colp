import { sql, type Kysely, type Migration } from 'kysely';

/**
 * SYNC-Q-007 D1: expand orthogonal lifecycle columns and a SQL policy function.
 * Linear `state` remains the write path; columns are mapped and fenced to that mapping.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE FUNCTION ledger_archive_lifecycle_from_linear(linear_state text)
    RETURNS TABLE(object_state text, read_state text, hot_source_state text)
    LANGUAGE plpgsql IMMUTABLE STRICT AS $body$
    BEGIN
      CASE
        WHEN linear_state IN ('open', 'sealed', 'exported') THEN
          object_state := 'creating'; read_state := 'disabled'; hot_source_state := 'attached';
        WHEN linear_state = 'verified' THEN
          object_state := 'verified'; read_state := 'verified'; hot_source_state := 'attached';
        WHEN linear_state = 'reader_cutover' THEN
          object_state := 'verified'; read_state := 'cutover'; hot_source_state := 'attached';
        WHEN linear_state IN ('detached', 'deletable') THEN
          object_state := 'verified'; read_state := 'cutover'; hot_source_state := 'detached';
        WHEN linear_state = 'deleted' THEN
          object_state := 'deleted'; read_state := 'disabled'; hot_source_state := 'detached';
        ELSE
          RAISE EXCEPTION 'Archive linear state % has no lifecycle mapping', linear_state
            USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_lifecycle_unmapped';
      END CASE;
      RETURN NEXT;
    END
    $body$`.execute(db);

  await sql`
    CREATE FUNCTION ledger_archive_policy_decisions(
      object_state text, read_state text, hot_source_state text, legal_hold boolean
    ) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $body$
    DECLARE
      verified_object boolean := object_state = 'verified';
      reader_open boolean := read_state IN ('verified', 'cutover');
      cutover boolean := read_state = 'cutover';
      attached boolean := hot_source_state = 'attached';
      detached boolean := hot_source_state = 'detached';
      hold boolean := legal_hold IS TRUE;
      can_read_object boolean := verified_object AND reader_open;
      can_hydrate boolean := verified_object AND cutover;
      can_cutover_reader boolean := verified_object AND read_state = 'verified' AND attached AND NOT hold;
      can_cutover_hot boolean := verified_object AND cutover AND attached AND NOT hold;
      can_mark_deletable boolean := verified_object AND cutover AND detached AND NOT hold;
      can_advance_floor boolean := object_state IN ('verified', 'deleted');
    BEGIN
      IF object_state NOT IN ('creating', 'verified', 'unavailable', 'deleted')
         OR read_state NOT IN ('disabled', 'verified', 'cutover')
         OR hot_source_state NOT IN ('attached', 'purging', 'detached') THEN
        RAISE EXCEPTION 'Archive lifecycle fields are not a known orthogonal triple'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_policy_invalid_lifecycle';
      END IF;
      RETURN jsonb_build_object(
        'canReadObject', can_read_object,
        'canHydratePayload', can_hydrate,
        'canCutoverReader', can_cutover_reader,
        'canCutoverHot', can_cutover_hot,
        'canPurgeHot', can_cutover_hot,
        'canDetachHot', can_cutover_hot,
        'canMarkDeletable', can_mark_deletable,
        'canDeleteObject', can_mark_deletable,
        'canAdvanceFloor', can_advance_floor,
        'canConfirmExport', can_advance_floor
      );
    END
    $body$`.execute(db);

  await sql`
    CREATE FUNCTION ledger_archive_policy_can_advance_floor(
      object_state text, read_state text, hot_source_state text, legal_hold boolean
    ) RETURNS boolean LANGUAGE sql IMMUTABLE AS $body$
      SELECT (ledger_archive_policy_decisions(
        object_state, read_state, hot_source_state, legal_hold
      ) ->> 'canAdvanceFloor')::boolean
    $body$`.execute(db);

  await sql`
    CREATE FUNCTION ledger_archive_policy_can_confirm_export_from_linear(linear_state text)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $body$
      SELECT (ledger_archive_policy_decisions(
        mapped.object_state, mapped.read_state, mapped.hot_source_state, false
      ) ->> 'canConfirmExport')::boolean
      FROM ledger_archive_lifecycle_from_linear(linear_state) AS mapped
    $body$`.execute(db);

  await sql`ALTER TABLE ledger_archive_segments
    ADD COLUMN object_state text,
    ADD COLUMN read_state text,
    ADD COLUMN hot_source_state text`.execute(db);

  await sql`UPDATE ledger_archive_segments AS segment
    SET object_state = mapped.object_state,
        read_state = mapped.read_state,
        hot_source_state = mapped.hot_source_state
    FROM ledger_archive_segments AS source,
         LATERAL ledger_archive_lifecycle_from_linear(source.state) AS mapped
    WHERE segment.segment_id = source.segment_id`.execute(db);

  await sql`DO $body$ BEGIN
    IF EXISTS (
      SELECT 1 FROM ledger_archive_segments
      WHERE object_state IS NULL OR read_state IS NULL OR hot_source_state IS NULL
    ) THEN
      RAISE EXCEPTION 'Archive lifecycle backfill left unmapped segment rows'
        USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_lifecycle_unmapped';
    END IF;
  END $body$`.execute(db);

  await sql`ALTER TABLE ledger_archive_segments
    ALTER COLUMN object_state SET NOT NULL,
    ALTER COLUMN read_state SET NOT NULL,
    ALTER COLUMN hot_source_state SET NOT NULL,
    ADD CONSTRAINT ledger_archive_segments_object_state_check
      CHECK (object_state IN ('creating', 'verified', 'unavailable', 'deleted')),
    ADD CONSTRAINT ledger_archive_segments_read_state_check
      CHECK (read_state IN ('disabled', 'verified', 'cutover')),
    ADD CONSTRAINT ledger_archive_segments_hot_source_state_check
      CHECK (hot_source_state IN ('attached', 'purging', 'detached'))`.execute(db);

  await sql`
    CREATE FUNCTION sync_ledger_archive_orthogonal_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    DECLARE mapped record;
    BEGIN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      SELECT * INTO mapped FROM ledger_archive_lifecycle_from_linear(NEW.state);
      IF TG_OP = 'UPDATE'
         AND (NEW.object_state IS DISTINCT FROM mapped.object_state
           OR NEW.read_state IS DISTINCT FROM mapped.read_state
           OR NEW.hot_source_state IS DISTINCT FROM mapped.hot_source_state)
         AND (NEW.object_state IS DISTINCT FROM OLD.object_state
           OR NEW.read_state IS DISTINCT FROM OLD.read_state
           OR NEW.hot_source_state IS DISTINCT FROM OLD.hot_source_state)
         AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'Orthogonal archive lifecycle cannot diverge from linear state'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_lifecycle_mismatch';
      END IF;
      NEW.object_state := mapped.object_state;
      NEW.read_state := mapped.read_state;
      NEW.hot_source_state := mapped.hot_source_state;
      RETURN NEW;
    END
    $body$`.execute(db);
  await sql`CREATE TRIGGER ledger_archive_segments_lifecycle_sync
    BEFORE INSERT OR UPDATE ON ledger_archive_segments
    FOR EACH ROW EXECUTE FUNCTION sync_ledger_archive_orthogonal_lifecycle()`.execute(db);

  await sql`COMMENT ON COLUMN ledger_archive_segments.object_state IS
    'Orthogonal archive-object state. deleted is an object-deletion receipt, never source deletion.'`.execute(db);
  await sql`COMMENT ON COLUMN ledger_archive_segments.deleted_at IS
    'Receipt time for an externally verified archive-object deletion; not a source-data delete grant.'`.execute(db);
}

/** Test-only rollback. Refuses when orthogonal columns diverged from the linear map. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $body$ BEGIN
    IF EXISTS (
      SELECT 1 FROM ledger_archive_segments segment
      CROSS JOIN LATERAL ledger_archive_lifecycle_from_linear(segment.state) mapped
      WHERE segment.object_state IS DISTINCT FROM mapped.object_state
         OR segment.read_state IS DISTINCT FROM mapped.read_state
         OR segment.hot_source_state IS DISTINCT FROM mapped.hot_source_state
    ) THEN
      RAISE EXCEPTION 'Cannot drop orthogonal archive lifecycle: stored columns diverged from linear state'
        USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_lifecycle_mismatch';
    END IF;
  END $body$`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_archive_segments_lifecycle_sync
    ON ledger_archive_segments`.execute(db);
  await sql`DROP FUNCTION IF EXISTS sync_ledger_archive_orthogonal_lifecycle()`.execute(db);
  await sql`ALTER TABLE ledger_archive_segments
    DROP CONSTRAINT IF EXISTS ledger_archive_segments_object_state_check,
    DROP CONSTRAINT IF EXISTS ledger_archive_segments_read_state_check,
    DROP CONSTRAINT IF EXISTS ledger_archive_segments_hot_source_state_check,
    DROP COLUMN IF EXISTS object_state,
    DROP COLUMN IF EXISTS read_state,
    DROP COLUMN IF EXISTS hot_source_state`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledger_archive_policy_can_confirm_export_from_linear(text)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledger_archive_policy_can_advance_floor(text, text, text, boolean)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledger_archive_policy_decisions(text, text, text, boolean)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledger_archive_lifecycle_from_linear(text)`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
