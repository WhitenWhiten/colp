import { sql, type Kysely } from 'kysely';

/**
 * Split permanent audit facts from the bulky, independently archivable payload.
 *
 * PostgreSQL jsonb::text is the sole canonical representation. Writers and the
 * backfill therefore cannot disagree about key ordering, whitespace, byte size,
 * or digest input.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`.execute(db);

  await sql`
    CREATE TABLE audit_event_payloads (
      event_id bigint PRIMARY KEY,
      details_json jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      CONSTRAINT audit_event_payloads_event_fk FOREIGN KEY (event_id)
        REFERENCES audit_events(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT audit_event_payloads_details_object_check
        CHECK (jsonb_typeof(details_json) = 'object')
    )
  `.execute(db);

  await sql`
    ALTER TABLE audit_events
      ADD COLUMN payload_digest text,
      ADD COLUMN payload_bytes bigint,
      ADD COLUMN payload_schema_version integer,
      ADD COLUMN payload_bucket_locator text,
      ADD COLUMN hot_payload_id bigint,
      ADD COLUMN payload_archive_segment_id uuid
  `.execute(db);

  await sql`
    INSERT INTO audit_event_payloads(event_id, details_json, created_at)
    SELECT id, details_json, created_at FROM audit_events
  `.execute(db);
  await sql`
    UPDATE audit_events
       SET payload_digest = 'sha256:' || encode(
             public.digest(convert_to(details_json::text, 'UTF8'), 'sha256'), 'hex'
           ),
           payload_bytes = octet_length(convert_to(details_json::text, 'UTF8')),
           payload_schema_version = 1,
           payload_bucket_locator = 'hot://audit_event_payloads/' || id::text,
           hot_payload_id = id
  `.execute(db);

  await sql`
    DO $block$
    DECLARE invalid_count bigint;
    BEGIN
      SELECT count(*) INTO invalid_count
        FROM audit_events event
        LEFT JOIN audit_event_payloads payload ON payload.event_id = event.id
       WHERE payload.event_id IS NULL
          OR event.payload_digest <> 'sha256:' || encode(
               public.digest(convert_to(payload.details_json::text, 'UTF8'), 'sha256'), 'hex'
             )
          OR event.payload_bytes <> octet_length(convert_to(payload.details_json::text, 'UTF8'));
      IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'audit payload split backfill verification failed for % rows', invalid_count
          USING ERRCODE='23514', CONSTRAINT='audit_payload_split_backfill_guard';
      END IF;
    END
    $block$
  `.execute(db);

  await sql`
    ALTER TABLE audit_events
      ALTER COLUMN payload_digest SET NOT NULL,
      ALTER COLUMN payload_bytes SET NOT NULL,
      ALTER COLUMN payload_schema_version SET NOT NULL,
      ALTER COLUMN payload_bucket_locator SET NOT NULL,
      ADD CONSTRAINT audit_events_payload_digest_check
        CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
      ADD CONSTRAINT audit_events_payload_bytes_check CHECK (payload_bytes >= 2),
      ADD CONSTRAINT audit_events_payload_schema_check CHECK (payload_schema_version > 0),
      ADD CONSTRAINT audit_events_payload_locator_check CHECK (
        length(payload_bucket_locator) BETWEEN 8 AND 2048
        AND payload_bucket_locator !~ '[[:cntrl:]]'
      ),
      ADD CONSTRAINT audit_events_hot_payload_identity_check
        CHECK (hot_payload_id IS NULL OR hot_payload_id = id),
      ADD CONSTRAINT audit_events_payload_location_state_check CHECK (
        (hot_payload_id = id AND payload_archive_segment_id IS NULL
          AND payload_bucket_locator LIKE 'hot://%')
        OR (hot_payload_id IS NULL AND payload_archive_segment_id IS NOT NULL
          AND payload_bucket_locator NOT LIKE 'hot://%')
      ),
      ADD CONSTRAINT audit_events_archive_segment_fk FOREIGN KEY (payload_archive_segment_id)
        REFERENCES ledger_archive_segments(segment_id) ON DELETE RESTRICT,
      ADD CONSTRAINT audit_events_hot_payload_fk FOREIGN KEY (hot_payload_id)
        REFERENCES audit_event_payloads(event_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
  `.execute(db);
  await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db);
  await sql`
    CREATE INDEX audit_event_payloads_keyset_idx
      ON audit_event_payloads(created_at, event_id)
  `.execute(db);
  await sql`
    CREATE INDEX audit_events_hot_payload_keyset_idx
      ON audit_events(created_at, id) WHERE hot_payload_id IS NOT NULL
  `.execute(db);

  await sql`ALTER TABLE audit_events DROP COLUMN details_json`.execute(db);

  await sql`
    CREATE FUNCTION audit_payload_archive_authorized() RETURNS boolean
    LANGUAGE plpgsql VOLATILE AS $function$
    DECLARE archiver_role oid;
    BEGIN
      SELECT oid INTO archiver_role FROM pg_roles
       WHERE rolname = 'known_audit_payload_archiver';
      RETURN archiver_role IS NOT NULL
        AND pg_has_role(session_user, archiver_role, 'member')
        AND current_setting('known.audit_payload_archive_capability', true) = 'enabled'
        AND current_setting('known.audit_payload_archive_transaction', true)
          = pg_current_xact_id()::text;
    END
    $function$
  `.execute(db);

  await sql`
    CREATE FUNCTION guard_audit_event_header_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Audit event headers are permanent and cannot be truncated'
          USING ERRCODE='23514', CONSTRAINT='audit_events_truncate_guard';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Audit event headers are permanent and cannot be deleted'
          USING ERRCODE='23514', CONSTRAINT='audit_events_delete_guard';
      END IF;
      IF NOT audit_payload_archive_authorized() THEN
        RAISE EXCEPTION 'Audit event headers are immutable'
          USING ERRCODE='23514', CONSTRAINT='audit_events_update_guard';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
          OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
          OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
          OR NEW.event_type IS DISTINCT FROM OLD.event_type
          OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
          OR NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes
          OR NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version
          OR OLD.hot_payload_id IS NULL
          OR NEW.hot_payload_id IS NOT NULL
          OR OLD.payload_archive_segment_id IS NOT NULL
          OR NEW.payload_archive_segment_id IS NULL
          OR NEW.payload_bucket_locator LIKE 'hot://%' THEN
        RAISE EXCEPTION 'Archive capability may only cut a hot payload over to a cold locator'
          USING ERRCODE='23514', CONSTRAINT='audit_events_archive_cutover_guard';
      END IF;
      RETURN NEW;
    END
    $function$
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_events_update_guard
      BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION guard_audit_event_header_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_events_delete_guard
      BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION guard_audit_event_header_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_events_truncate_guard
      BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION guard_audit_event_header_mutation()
  `.execute(db);

  await sql`
    CREATE FUNCTION guard_audit_event_payload_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NOT audit_payload_archive_authorized() THEN
        RAISE EXCEPTION 'Audit hot payload mutation requires a transaction-local archive capability'
          USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard';
      END IF;
      IF TG_OP = 'UPDATE' OR TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Audit hot payloads may only be removed after reader cutover'
          USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard';
      END IF;
      RETURN OLD;
    END
    $function$
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_event_payloads_update_guard
      BEFORE UPDATE ON audit_event_payloads FOR EACH ROW EXECUTE FUNCTION guard_audit_event_payload_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_event_payloads_delete_guard
      BEFORE DELETE ON audit_event_payloads FOR EACH ROW EXECUTE FUNCTION guard_audit_event_payload_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER audit_event_payloads_truncate_guard
      BEFORE TRUNCATE ON audit_event_payloads FOR EACH STATEMENT EXECUTE FUNCTION guard_audit_event_payload_mutation()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $block$
    DECLARE unavailable_count bigint;
    BEGIN
      SELECT count(*) INTO unavailable_count
        FROM audit_events event
        LEFT JOIN audit_event_payloads payload ON payload.event_id = event.id
       WHERE payload.event_id IS NULL;
      IF unavailable_count <> 0 THEN
        RAISE EXCEPTION 'audit payload split down refused: % payloads are unavailable in hot storage',
          unavailable_count
          USING ERRCODE='23514', CONSTRAINT='audit_payload_split_down_guard';
      END IF;
    END
    $block$
  `.execute(db);

  await sql`DROP TRIGGER audit_event_payloads_truncate_guard ON audit_event_payloads`.execute(db);
  await sql`DROP TRIGGER audit_event_payloads_delete_guard ON audit_event_payloads`.execute(db);
  await sql`DROP TRIGGER audit_event_payloads_update_guard ON audit_event_payloads`.execute(db);
  await sql`DROP FUNCTION guard_audit_event_payload_mutation()`.execute(db);
  await sql`DROP TRIGGER audit_events_truncate_guard ON audit_events`.execute(db);
  await sql`DROP TRIGGER audit_events_delete_guard ON audit_events`.execute(db);
  await sql`DROP TRIGGER audit_events_update_guard ON audit_events`.execute(db);
  await sql`DROP FUNCTION guard_audit_event_header_mutation()`.execute(db);
  await sql`DROP FUNCTION audit_payload_archive_authorized()`.execute(db);

  await sql`ALTER TABLE audit_events ADD COLUMN details_json jsonb`.execute(db);
  await sql`
    UPDATE audit_events event SET details_json = payload.details_json
      FROM audit_event_payloads payload WHERE payload.event_id = event.id
  `.execute(db);
  await sql`
    ALTER TABLE audit_events
      ALTER COLUMN details_json SET NOT NULL,
      ALTER COLUMN details_json SET DEFAULT '{}'::jsonb,
      DROP CONSTRAINT audit_events_hot_payload_fk,
      DROP CONSTRAINT audit_events_archive_segment_fk,
      DROP CONSTRAINT audit_events_payload_location_state_check,
      DROP CONSTRAINT audit_events_hot_payload_identity_check,
      DROP CONSTRAINT audit_events_payload_locator_check,
      DROP CONSTRAINT audit_events_payload_schema_check,
      DROP CONSTRAINT audit_events_payload_bytes_check,
      DROP CONSTRAINT audit_events_payload_digest_check,
      DROP COLUMN payload_archive_segment_id,
      DROP COLUMN hot_payload_id,
      DROP COLUMN payload_bucket_locator,
      DROP COLUMN payload_schema_version,
      DROP COLUMN payload_bytes,
      DROP COLUMN payload_digest
  `.execute(db);
  await sql`DROP TABLE audit_event_payloads`.execute(db);
}
