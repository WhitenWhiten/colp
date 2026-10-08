import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only archive control plane for append-only ledgers.
 *
 * This migration does not move or delete source rows.  A segment is a durable
 * manifest whose state can only advance one step at a time.  The btree_gist
 * exclusion constraint makes half-open bigint source-key ranges non-overlapping
 * for each ledger family/source relation/scope, including under concurrent
 * inserts. Source keys are explicitly signed bigint append ordinals/ids.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public`.execute(db);

  await sql`
    CREATE TABLE ledger_archive_segments (
      segment_id uuid PRIMARY KEY,
      ledger_family text NOT NULL,
      source_relation text NOT NULL,
      source_scope text NOT NULL,
      source_key_kind text NOT NULL,
      source_key_comparator text NOT NULL,
      source_key_bounds int8range NOT NULL,
      row_count bigint NOT NULL,
      source_bytes bigint NOT NULL,
      content_digest text NOT NULL,
      archive_object_uri text NOT NULL,
      archive_object_etag text NOT NULL,
      archive_schema_version integer NOT NULL,
      kms_key_id text NOT NULL,
      state text NOT NULL DEFAULT 'open',
      state_revision bigint NOT NULL DEFAULT 1,
      stage_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      sealed_at timestamptz,
      exported_at timestamptz,
      verified_at timestamptz,
      reader_cutover_at timestamptz,
      detached_at timestamptz,
      deletable_at timestamptz,
      deleted_at timestamptz,
      delete_after timestamptz,
      legal_hold boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT current_timestamp,
      updated_at timestamptz NOT NULL DEFAULT current_timestamp,

      CONSTRAINT ledger_archive_segments_family_check CHECK (
        length(ledger_family) BETWEEN 1 AND 64
        AND ledger_family ~ '^[a-z][a-z0-9_]*$'
      ),
      CONSTRAINT ledger_archive_segments_relation_check CHECK (
        length(source_relation) BETWEEN 3 AND 127
        AND source_relation ~ '^[a-z_][a-z0-9_]*[.][a-z_][a-z0-9_]*$'
      ),
      CONSTRAINT ledger_archive_segments_scope_check CHECK (
        length(source_scope) BETWEEN 1 AND 256
        AND source_scope ~ '^[A-Za-z0-9][A-Za-z0-9:_./-]*$'
      ),
      CONSTRAINT ledger_archive_segments_key_contract_check CHECK (
        source_key_kind = 'bigint'
        AND source_key_comparator = 'signed-bigint-ascending-v1'
      ),
      CONSTRAINT ledger_archive_segments_bounds_check CHECK (
        NOT isempty(source_key_bounds)
        AND NOT lower_inf(source_key_bounds)
        AND NOT upper_inf(source_key_bounds)
        AND lower_inc(source_key_bounds)
        AND NOT upper_inc(source_key_bounds)
      ),
      CONSTRAINT ledger_archive_segments_counts_check CHECK (
        row_count >= 0 AND source_bytes >= 0
      ),
      CONSTRAINT ledger_archive_segments_digest_check CHECK (
        content_digest ~ '^sha256:[0-9a-f]{64}$'
      ),
      CONSTRAINT ledger_archive_segments_uri_check CHECK (
        length(archive_object_uri) BETWEEN 8 AND 2048
        AND archive_object_uri ~ '^(s3|r2|gs|az)://[^/?#@[:space:]][^?#@[:space:]]*$'
      ),
      CONSTRAINT ledger_archive_segments_etag_check CHECK (
        length(archive_object_etag) BETWEEN 1 AND 256
        AND archive_object_etag !~ '[[:cntrl:]]'
      ),
      CONSTRAINT ledger_archive_segments_archive_contract_check CHECK (
        archive_schema_version > 0
        AND length(kms_key_id) BETWEEN 1 AND 256
        AND kms_key_id ~ '^[A-Za-z0-9][A-Za-z0-9:/_.-]*$'
      ),
      CONSTRAINT ledger_archive_segments_state_check CHECK (state IN (
        'open', 'sealed', 'exported', 'verified', 'reader_cutover',
        'detached', 'deletable', 'deleted'
      )),
      CONSTRAINT ledger_archive_segments_revision_check CHECK (state_revision > 0),
      CONSTRAINT ledger_archive_segments_evidence_check CHECK (
        jsonb_typeof(stage_evidence) = 'object'
        AND octet_length(stage_evidence::text) <= 16384
      ),
      CONSTRAINT ledger_archive_segments_hold_check CHECK (
        NOT legal_hold OR state NOT IN ('deletable', 'deleted')
      ),
      CONSTRAINT ledger_archive_segments_stage_time_check CHECK (
        (sealed_at IS NOT NULL) = (state <> 'open')
        AND (exported_at IS NOT NULL) = (state IN (
          'exported', 'verified', 'reader_cutover', 'detached', 'deletable', 'deleted'
        ))
        AND (verified_at IS NOT NULL) = (state IN (
          'verified', 'reader_cutover', 'detached', 'deletable', 'deleted'
        ))
        AND (reader_cutover_at IS NOT NULL) = (state IN (
          'reader_cutover', 'detached', 'deletable', 'deleted'
        ))
        AND (detached_at IS NOT NULL) = (state IN ('detached', 'deletable', 'deleted'))
        AND (deletable_at IS NOT NULL) = (state IN ('deletable', 'deleted'))
        AND (deleted_at IS NOT NULL) = (state = 'deleted')
      ),
      CONSTRAINT ledger_archive_segments_time_check CHECK (
        created_at > '-infinity'::timestamptz
        AND created_at < 'infinity'::timestamptz
        AND updated_at >= created_at
        AND updated_at < 'infinity'::timestamptz
        AND (delete_after IS NULL OR (
          delete_after > '-infinity'::timestamptz AND delete_after < 'infinity'::timestamptz
        ))
        AND (sealed_at IS NULL OR sealed_at >= created_at)
        AND (exported_at IS NULL OR exported_at >= sealed_at)
        AND (verified_at IS NULL OR verified_at >= exported_at)
        AND (reader_cutover_at IS NULL OR reader_cutover_at >= verified_at)
        AND (detached_at IS NULL OR detached_at >= reader_cutover_at)
        AND (deletable_at IS NULL OR deletable_at >= detached_at)
        AND (deleted_at IS NULL OR deleted_at >= deletable_at)
      ),
      CONSTRAINT ledger_archive_segments_source_bounds_excl EXCLUDE USING gist (
        ledger_family WITH =,
        source_relation WITH =,
        source_scope WITH =,
        source_key_kind WITH =,
        source_key_comparator WITH =,
        source_key_bounds WITH &&
      )
    )
  `.execute(db);

  await sql`
    CREATE INDEX ledger_archive_segments_pending_idx
      ON ledger_archive_segments (state, updated_at, segment_id)
      WHERE state <> 'deleted'
  `.execute(db);
  await sql`
    CREATE INDEX ledger_archive_segments_delete_after_idx
      ON ledger_archive_segments (delete_after, segment_id)
      WHERE state = 'detached' AND legal_hold = false
  `.execute(db);

  await sql`
    CREATE FUNCTION guard_ledger_archive_segment_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE
      expected_next text;
      evidence jsonb;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Archive segment manifests and evidence cannot be truncated'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_truncate_guard';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Archive segment manifests and evidence cannot be deleted'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_delete_guard';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'open'
            OR NEW.state_revision <> 1
            OR NEW.stage_evidence <> '{}'::jsonb
            OR NEW.sealed_at IS NOT NULL
            OR NEW.exported_at IS NOT NULL
            OR NEW.verified_at IS NOT NULL
            OR NEW.reader_cutover_at IS NOT NULL
            OR NEW.detached_at IS NOT NULL
            OR NEW.deletable_at IS NOT NULL
            OR NEW.deleted_at IS NOT NULL THEN
          RAISE EXCEPTION 'Archive segment must start open with revision one and no stage evidence'
            USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_transition_guard';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.segment_id IS DISTINCT FROM OLD.segment_id
          OR NEW.ledger_family IS DISTINCT FROM OLD.ledger_family
          OR NEW.source_relation IS DISTINCT FROM OLD.source_relation
          OR NEW.source_scope IS DISTINCT FROM OLD.source_scope
          OR NEW.source_key_kind IS DISTINCT FROM OLD.source_key_kind
          OR NEW.source_key_comparator IS DISTINCT FROM OLD.source_key_comparator
          OR NEW.source_key_bounds IS DISTINCT FROM OLD.source_key_bounds
          OR NEW.row_count IS DISTINCT FROM OLD.row_count
          OR NEW.source_bytes IS DISTINCT FROM OLD.source_bytes
          OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
          OR NEW.archive_object_uri IS DISTINCT FROM OLD.archive_object_uri
          OR NEW.archive_object_etag IS DISTINCT FROM OLD.archive_object_etag
          OR NEW.archive_schema_version IS DISTINCT FROM OLD.archive_schema_version
          OR NEW.kms_key_id IS DISTINCT FROM OLD.kms_key_id
          OR NEW.delete_after IS DISTINCT FROM OLD.delete_after
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Archive segment manifest and source bounds are immutable'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_manifest_immutable';
      END IF;

      IF NEW.state_revision <> OLD.state_revision + 1 THEN
        RAISE EXCEPTION 'Archive segment updates require the next state revision'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_revision_guard';
      END IF;

      IF NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
          OR NEW.exported_at IS DISTINCT FROM OLD.exported_at
          OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
          OR NEW.reader_cutover_at IS DISTINCT FROM OLD.reader_cutover_at
          OR NEW.detached_at IS DISTINCT FROM OLD.detached_at
          OR NEW.deletable_at IS DISTINCT FROM OLD.deletable_at
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        RAISE EXCEPTION 'Archive stage timestamps are database-owned'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_stage_time_guard';
      END IF;

      IF NEW.state = OLD.state THEN
        IF NEW.legal_hold IS NOT DISTINCT FROM OLD.legal_hold
            OR NEW.stage_evidence IS DISTINCT FROM OLD.stage_evidence THEN
          RAISE EXCEPTION 'Same-state archive updates may only change legal hold'
            USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_transition_guard';
        END IF;
        NEW.updated_at := current_timestamp;
        RETURN NEW;
      END IF;

      IF NEW.legal_hold IS DISTINCT FROM OLD.legal_hold THEN
        RAISE EXCEPTION 'Legal hold and lifecycle transition require separate CAS updates'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_transition_guard';
      END IF;

      expected_next := CASE OLD.state
        WHEN 'open' THEN 'sealed'
        WHEN 'sealed' THEN 'exported'
        WHEN 'exported' THEN 'verified'
        WHEN 'verified' THEN 'reader_cutover'
        WHEN 'reader_cutover' THEN 'detached'
        WHEN 'detached' THEN 'deletable'
        WHEN 'deletable' THEN 'deleted'
        ELSE NULL
      END;
      IF NEW.state IS DISTINCT FROM expected_next THEN
        RAISE EXCEPTION 'Illegal archive segment lifecycle transition'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_transition_guard';
      END IF;

      IF NEW.state IN ('deletable', 'deleted') AND OLD.legal_hold THEN
        RAISE EXCEPTION 'Legal hold blocks delete lifecycle states'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_legal_hold_guard';
      END IF;
      IF NEW.state = 'deletable' AND (
          OLD.delete_after IS NULL OR OLD.delete_after > current_timestamp
      ) THEN
        RAISE EXCEPTION 'Delete-after must be reached before a segment is deletable'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_delete_after_guard';
      END IF;

      IF (SELECT count(*) FROM jsonb_object_keys(NEW.stage_evidence))
            <> (SELECT count(*) FROM jsonb_object_keys(OLD.stage_evidence)) + 1
          OR NOT (NEW.stage_evidence @> OLD.stage_evidence)
          OR NOT (NEW.stage_evidence ? NEW.state)
          OR OLD.stage_evidence ? NEW.state THEN
        RAISE EXCEPTION 'Each lifecycle transition must append exactly its own evidence entry'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_evidence_guard';
      END IF;
      evidence := NEW.stage_evidence -> NEW.state;
      IF jsonb_typeof(evidence) <> 'object' OR evidence = '{}'::jsonb THEN
        RAISE EXCEPTION 'Lifecycle evidence must be a non-empty JSON object'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_evidence_guard';
      END IF;

      CASE NEW.state
        WHEN 'sealed' THEN NEW.sealed_at := current_timestamp;
        WHEN 'exported' THEN NEW.exported_at := current_timestamp;
        WHEN 'verified' THEN NEW.verified_at := current_timestamp;
        WHEN 'reader_cutover' THEN NEW.reader_cutover_at := current_timestamp;
        WHEN 'detached' THEN NEW.detached_at := current_timestamp;
        WHEN 'deletable' THEN NEW.deletable_at := current_timestamp;
        WHEN 'deleted' THEN NEW.deleted_at := current_timestamp;
      END CASE;
      NEW.updated_at := current_timestamp;
      RETURN NEW;
    END
    $function$
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_archive_segments_transition_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ledger_archive_segments
      FOR EACH ROW EXECUTE FUNCTION guard_ledger_archive_segment_transition()
  `.execute(db);
  await sql`
    CREATE TRIGGER ledger_archive_segments_truncate_guard
      BEFORE TRUNCATE ON ledger_archive_segments
      FOR EACH STATEMENT EXECUTE FUNCTION guard_ledger_archive_segment_transition()
  `.execute(db);

  await sql`COMMENT ON TABLE ledger_archive_segments IS
    'Append-only ledger archive manifests and lifecycle evidence only; this table grants no authority to delete source data.'`.execute(db);
  await sql`COMMENT ON COLUMN ledger_archive_segments.deleted_at IS
    'Records an externally executed and independently verified source action; no executor is provided by this control plane.'`.execute(db);
}

/** Developer/test rollback only; never a production retention or source-data action. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS ledger_archive_segments_truncate_guard ON ledger_archive_segments`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_archive_segments_transition_guard ON ledger_archive_segments`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_ledger_archive_segment_transition()`.execute(db);
  await sql`DROP TABLE IF EXISTS ledger_archive_segments`.execute(db);
  // btree_gist is shared infrastructure and is intentionally retained.
}

const migration: Migration = { up, down };
export default migration;
