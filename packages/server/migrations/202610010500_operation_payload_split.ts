import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Split immutable Operation facts from their large, archiveable JSON payload.
 *
 * `operation_payloads` is deliberately a regular table, not a declaratively
 * partitioned table. PostgreSQL requires every unique/primary key on a
 * partitioned table to contain the partition key, which would weaken the
 * global operation_id identity and the existing FK graph. The UTC month bucket
 * plus collection/ordinal index gives the archive executor deterministic,
 * bounded reclaim batches without compromising those constraints.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE operations IN ACCESS EXCLUSIVE MODE`.execute(db);

  await sql`CREATE FUNCTION operation_payload_canonical_bytes(payload jsonb, sync_wire jsonb)
    RETURNS bytea LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN convert_to(jsonb_build_object(
      'payloadJson', payload, 'syncWireJson', sync_wire
    )::text, 'UTF8')`.execute(db);
  await sql`CREATE FUNCTION operation_payload_sha256(payload jsonb, sync_wire jsonb)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN encode(sha256(operation_payload_canonical_bytes(payload, sync_wire)), 'hex')`.execute(db);

  await sql`ALTER TABLE operations
    ADD COLUMN payload_source text,
    ADD COLUMN payload_locator text,
    ADD COLUMN payload_digest_sha256 text,
    ADD COLUMN payload_bytes bigint,
    ADD COLUMN payload_schema_version integer,
    ADD COLUMN payload_bucket date,
    ADD COLUMN sync_wire_present boolean`.execute(db);

  await sql`CREATE TABLE operation_payloads (
    operation_id text PRIMARY KEY,
    collection_id text NOT NULL,
    commit_ordinal bigint NOT NULL CHECK (commit_ordinal > 0),
    payload_bucket date NOT NULL,
    payload_schema_version integer NOT NULL CHECK (payload_schema_version = 1),
    payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
    sync_wire_json jsonb CHECK (sync_wire_json IS NULL OR jsonb_typeof(sync_wire_json) = 'object'),
    canonical_digest_sha256 text NOT NULL CHECK (
      canonical_digest_sha256 ~ '^[0-9a-f]{64}$'
      AND canonical_digest_sha256 = operation_payload_sha256(payload_json, sync_wire_json)
    ),
    canonical_bytes bigint NOT NULL CHECK (
      canonical_bytes > 0
      AND canonical_bytes = octet_length(operation_payload_canonical_bytes(payload_json, sync_wire_json))
    ),
    created_at timestamptz NOT NULL,
    CONSTRAINT operation_payloads_operation_binding_unique UNIQUE (
      operation_id, collection_id, commit_ordinal, canonical_digest_sha256,
      canonical_bytes, payload_schema_version, payload_bucket
    ),
    CONSTRAINT operation_payloads_operation_fk FOREIGN KEY (
      operation_id, collection_id, commit_ordinal
    ) REFERENCES operations(operation_id, collection_id, commit_ordinal)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT operation_payloads_bucket_matches_created CHECK (
      payload_bucket = date_trunc('month', created_at AT TIME ZONE 'UTC')::date
    )
  )`.execute(db);

  await sql`WITH source AS (
      SELECT operation_id, collection_id, commit_ordinal, payload_json, sync_wire_json,
        created_at, date_trunc('month', created_at AT TIME ZONE 'UTC')::date AS payload_bucket,
        operation_payload_sha256(payload_json, sync_wire_json) AS digest,
        octet_length(operation_payload_canonical_bytes(payload_json, sync_wire_json)) AS bytes
      FROM operations
    )
    INSERT INTO operation_payloads (
      operation_id, collection_id, commit_ordinal, payload_bucket, payload_schema_version,
      payload_json, sync_wire_json, canonical_digest_sha256, canonical_bytes, created_at
    ) SELECT operation_id, collection_id, commit_ordinal, payload_bucket, 1,
        payload_json, sync_wire_json, digest, bytes, created_at FROM source`.execute(db);

  await sql`UPDATE operations operation SET
      payload_source = 'hot',
      payload_locator = 'operation_payloads/' || payload.payload_bucket::text || '/' || operation.operation_id,
      payload_digest_sha256 = payload.canonical_digest_sha256,
      payload_bytes = payload.canonical_bytes,
      payload_schema_version = payload.payload_schema_version,
      payload_bucket = payload.payload_bucket,
      sync_wire_present = payload.sync_wire_json IS NOT NULL
    FROM operation_payloads payload WHERE payload.operation_id = operation.operation_id`.execute(db);

  await sql`DO $body$ BEGIN
    IF EXISTS (
      SELECT 1 FROM operations operation
      LEFT JOIN operation_payloads payload ON payload.operation_id = operation.operation_id
      WHERE payload.operation_id IS NULL
        OR payload.collection_id <> operation.collection_id
        OR payload.commit_ordinal <> operation.commit_ordinal
        OR payload.canonical_digest_sha256 <> operation.payload_digest_sha256
        OR payload.canonical_bytes <> operation.payload_bytes
        OR payload.payload_schema_version <> operation.payload_schema_version
        OR payload.payload_bucket <> operation.payload_bucket
        OR payload.canonical_digest_sha256 <> operation_payload_sha256(
          payload.payload_json, payload.sync_wire_json)
        OR payload.canonical_bytes <> octet_length(operation_payload_canonical_bytes(
          payload.payload_json, payload.sync_wire_json))
    ) OR (SELECT count(*) FROM operations) <> (SELECT count(*) FROM operation_payloads) THEN
      RAISE EXCEPTION 'Operation payload split backfill failed exactness or digest validation';
    END IF;
  END $body$`.execute(db);
  // Flush the deferred three-column FK before building indexes; PostgreSQL
  // refuses CREATE INDEX while rows have pending deferred trigger events.
  await sql`SET CONSTRAINTS operation_payloads_operation_fk IMMEDIATE`.execute(db);

  await sql`ALTER TABLE operations
    ALTER COLUMN payload_source SET NOT NULL,
    ALTER COLUMN payload_locator SET NOT NULL,
    ALTER COLUMN payload_digest_sha256 SET NOT NULL,
    ALTER COLUMN payload_bytes SET NOT NULL,
    ALTER COLUMN payload_schema_version SET NOT NULL,
    ALTER COLUMN payload_bucket SET NOT NULL,
    ALTER COLUMN sync_wire_present SET NOT NULL,
    ADD CONSTRAINT operations_payload_source_check CHECK (payload_source IN ('hot', 'archive')),
    ADD CONSTRAINT operations_payload_locator_check CHECK (length(payload_locator) BETWEEN 1 AND 2048),
    ADD CONSTRAINT operations_payload_digest_check CHECK (payload_digest_sha256 ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT operations_payload_bytes_check CHECK (payload_bytes > 0),
    ADD CONSTRAINT operations_payload_schema_check CHECK (payload_schema_version = 1),
    ADD CONSTRAINT operations_payload_hot_locator_check CHECK (
      payload_source <> 'hot'
      OR payload_locator = 'operation_payloads/' || payload_bucket::text || '/' || operation_id
    )`.execute(db);

  await sql`DROP INDEX IF EXISTS operations_sync_pull_order_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS operations_attachment_finalize_command_idx`.execute(db);
  await sql`ALTER TABLE operations DROP COLUMN payload_json, DROP COLUMN sync_wire_json`.execute(db);
  await sql`CREATE INDEX operations_sync_pull_order_idx
    ON operations(collection_id, commit_ordinal, sync_stream_kind, operation_id COLLATE "C")
    INCLUDE (payload_source, payload_locator, payload_digest_sha256, payload_bytes, payload_schema_version)
    WHERE sync_wire_present`.execute(db);
  await sql`CREATE INDEX operation_payloads_archive_batch_idx
    ON operation_payloads(payload_bucket, collection_id, commit_ordinal, operation_id)`.execute(db);
  await sql`CREATE INDEX operation_payloads_command_idx
    ON operation_payloads((payload_json ->> 'commandId'), commit_ordinal DESC)
    INCLUDE (operation_id, collection_id)
    WHERE payload_json ? 'commandId'`.execute(db);

  await createGuards(db);
  await replaceHistoryFloorGuard(db, true);

  await sql`COMMENT ON TABLE operation_payloads IS
    'Immutable hot Operation payload source. Canonical bytes are UTF-8 PostgreSQL jsonb text for {payloadJson,syncWireJson}; deletion requires the separately provisioned archiver role and transaction-local capability.'`.execute(db);
  await sql`COMMENT ON COLUMN operations.payload_locator IS
    'Reader locator for payload_source; hot locators bind operation_payloads, archive locators are resolved through OperationPayloadSource.'`.execute(db);
}

async function createGuards(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION operation_payload_archive_authorized() RETURNS boolean
    LANGUAGE plpgsql STABLE AS $body$
    DECLARE archive_role oid;
    BEGIN
      archive_role := to_regrole('known_operation_payload_archiver');
      RETURN archive_role IS NOT NULL
        AND pg_has_role(session_user, archive_role, 'member')
        AND current_setting('known.operation_payload_archive', true) = 'enabled';
    END $body$`.execute(db);
  await sql`CREATE FUNCTION guard_operation_payload_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN
      IF TG_OP = 'TRUNCATE' OR NOT operation_payload_archive_authorized() THEN
        RAISE EXCEPTION 'Operation payloads are immutable; archive capability is required'
          USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Operation payloads cannot be updated'
          USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable';
      END IF;
      RETURN OLD;
    END $body$`.execute(db);
  await sql`CREATE TRIGGER operation_payloads_immutable
    BEFORE UPDATE OR DELETE ON operation_payloads FOR EACH ROW
    EXECUTE FUNCTION guard_operation_payload_mutation()`.execute(db);
  await sql`CREATE TRIGGER operation_payloads_truncate_guard
    BEFORE TRUNCATE ON operation_payloads FOR EACH STATEMENT
    EXECUTE FUNCTION guard_operation_payload_mutation()`.execute(db);

  await sql`CREATE FUNCTION guard_operation_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN
      IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Operation facts are permanent'
          USING ERRCODE='23514', CONSTRAINT='operations_permanent';
      END IF;
      IF NOT operation_payload_archive_authorized()
         OR OLD.payload_source <> 'hot' OR NEW.payload_source <> 'archive'
         OR (to_jsonb(NEW) - ARRAY['payload_source','payload_locator']::text[])
              IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY['payload_source','payload_locator']::text[]) THEN
        RAISE EXCEPTION 'Operation facts are immutable outside payload reader cutover'
          USING ERRCODE='23514', CONSTRAINT='operations_permanent';
      END IF;
      RETURN NEW;
    END $body$`.execute(db);
  await sql`CREATE TRIGGER operations_permanent
    BEFORE UPDATE OR DELETE ON operations FOR EACH ROW
    EXECUTE FUNCTION guard_operation_fact_mutation()`.execute(db);
  await sql`CREATE TRIGGER operations_truncate_guard
    BEFORE TRUNCATE ON operations FOR EACH STATEMENT
    EXECUTE FUNCTION guard_operation_fact_mutation()`.execute(db);

  await sql`CREATE FUNCTION verify_operation_hot_payload() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN
      IF NEW.payload_source = 'hot' AND NOT EXISTS (
        SELECT 1 FROM operation_payloads payload
        WHERE payload.operation_id = NEW.operation_id
          AND payload.collection_id = NEW.collection_id
          AND payload.commit_ordinal = NEW.commit_ordinal
          AND payload.canonical_digest_sha256 = NEW.payload_digest_sha256
          AND payload.canonical_bytes = NEW.payload_bytes
          AND payload.payload_schema_version = NEW.payload_schema_version
          AND payload.payload_bucket = NEW.payload_bucket
      ) THEN
        RAISE EXCEPTION 'Operation hot payload is missing or does not match facts'
          USING ERRCODE='23514', CONSTRAINT='operations_hot_payload_required';
      END IF;
      RETURN NEW;
    END $body$`.execute(db);
  await sql`CREATE CONSTRAINT TRIGGER operations_hot_payload_required
    AFTER INSERT OR UPDATE ON operations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION verify_operation_hot_payload()`.execute(db);
}

async function replaceHistoryFloorGuard(db: Kysely<unknown>, split: boolean): Promise<void> {
  const boundary = split
    ? sql`operation.sync_wire_present`
    : sql`operation.sync_wire_json IS NOT NULL`;
  await sql`CREATE OR REPLACE FUNCTION guard_sync_history_floor_transition() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    DECLARE archive ledger_archive_segments%ROWTYPE;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'Sync history floors cannot be truncated'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_truncate_guard'; END IF;
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Sync history floors cannot be deleted'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_delete_guard'; END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.floor_commit_ordinal <> 0 OR NEW.floor_stream_kind <> 0
          OR NEW.floor_stable_id <> '' OR NEW.archive_segment_id IS NOT NULL OR NEW.state_revision <> 0
        THEN RAISE EXCEPTION 'Sync history floor must materialize at implicit zero'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_transition_guard'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.collection_id IS DISTINCT FROM OLD.collection_id OR NEW.state_revision <> OLD.state_revision + 1
        OR NEW.floor_stream_kind <> 0 OR (NEW.floor_commit_ordinal, NEW.floor_stream_kind,
          NEW.floor_stable_id COLLATE "C") <= (OLD.floor_commit_ordinal, OLD.floor_stream_kind,
          OLD.floor_stable_id COLLATE "C") OR NEW.archive_segment_id IS NULL
        OR NEW.advanced_at < OLD.advanced_at
      THEN RAISE EXCEPTION 'Sync history floor must advance by one revision'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_transition_guard'; END IF;
      LOCK TABLE sync_replicas IN SHARE MODE;
      IF NOT EXISTS (SELECT 1 FROM operations operation WHERE operation.collection_id=NEW.collection_id
        AND operation.commit_ordinal=NEW.floor_commit_ordinal AND operation.sync_stream_kind=0
        AND operation.operation_id=NEW.floor_stable_id AND ${boundary})
      THEN RAISE EXCEPTION 'Sync history floor boundary is not an operation tuple'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_boundary_missing'; END IF;
      SELECT * INTO archive FROM ledger_archive_segments segment
        WHERE segment.segment_id=NEW.archive_segment_id FOR SHARE;
      IF NOT FOUND OR archive.ledger_family <> 'operation' OR archive.source_relation <> 'public.operations'
        OR archive.source_scope <> 'collection:' || NEW.collection_id OR archive.source_key_kind <> 'bigint'
        OR archive.source_key_comparator <> 'signed-bigint-ascending-v1'
        OR lower(archive.source_key_bounds) <> 1 OR upper(archive.source_key_bounds) <> NEW.floor_commit_ordinal+1
        OR archive.row_count <> NEW.floor_commit_ordinal OR archive.source_bytes <= 0
        OR archive.archive_schema_version <> 1
      THEN RAISE EXCEPTION 'Archive manifest does not bind the complete operation prefix'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_binding_mismatch'; END IF;
      IF archive.state NOT IN ('verified','reader_cutover','detached','deletable','deleted')
        OR archive.verified_at IS NULL OR NOT (archive.stage_evidence ? 'verified')
      THEN RAISE EXCEPTION 'Archive manifest has not reached verified state'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_archive_not_verified'; END IF;
      IF EXISTS (SELECT 1 FROM sync_replicas replica WHERE replica.collection_id=NEW.collection_id
        AND replica.status='active' AND (replica.checkpoint_commit_ordinal IS NULL
          OR replica.checkpoint_stream_kind IS NULL OR replica.checkpoint_stable_id IS NULL
          OR (replica.checkpoint_commit_ordinal, replica.checkpoint_stream_kind,
            replica.checkpoint_stable_id COLLATE "C") < (NEW.floor_commit_ordinal,
            NEW.floor_stream_kind, NEW.floor_stable_id COLLATE "C")))
      THEN RAISE EXCEPTION 'An active Replica checkpoint is behind the Sync history floor'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_active_replica_behind'; END IF;
      NEW.advanced_at := current_timestamp; RETURN NEW;
    END $body$`.execute(db);
}

/** Developer-only destructive reconstruction; drain split readers/writers first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS operations_hot_payload_required ON operations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS verify_operation_hot_payload()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS operations_truncate_guard ON operations`.execute(db);
  await sql`DROP TRIGGER IF EXISTS operations_permanent ON operations`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_operation_fact_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS operation_payloads_truncate_guard ON operation_payloads`.execute(db);
  await sql`DROP TRIGGER IF EXISTS operation_payloads_immutable ON operation_payloads`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_operation_payload_mutation()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS operation_payload_archive_authorized()`.execute(db);
  await sql`ALTER TABLE operations ADD COLUMN payload_json jsonb, ADD COLUMN sync_wire_json jsonb`.execute(db);
  await sql`UPDATE operations operation SET payload_json=payload.payload_json,
      sync_wire_json=payload.sync_wire_json FROM operation_payloads payload
      WHERE payload.operation_id=operation.operation_id`.execute(db);
  await sql`ALTER TABLE operations ALTER COLUMN payload_json SET NOT NULL,
    ALTER COLUMN payload_json SET DEFAULT '{}'::jsonb,
    ADD CHECK (sync_wire_json IS NULL OR jsonb_typeof(sync_wire_json)='object')`.execute(db);
  await replaceHistoryFloorGuard(db, false);
  await sql`DROP INDEX IF EXISTS operations_sync_pull_order_idx`.execute(db);
  await sql`CREATE INDEX operations_sync_pull_order_idx
    ON operations(collection_id, commit_ordinal, sync_stream_kind, operation_id COLLATE "C")
    INCLUDE (sync_wire_json) WHERE sync_wire_json IS NOT NULL`.execute(db);
  await sql`CREATE INDEX operations_attachment_finalize_command_idx
    ON operations ((payload_json ->> 'commandId'), commit_ordinal DESC)
    INCLUDE (operation_id, collection_id)
    WHERE operation_type='attachment.finalized' AND payload_json ? 'commandId'`.execute(db);
  await sql`ALTER TABLE operations
    DROP COLUMN payload_source, DROP COLUMN payload_locator, DROP COLUMN payload_digest_sha256,
    DROP COLUMN payload_bytes, DROP COLUMN payload_schema_version, DROP COLUMN payload_bucket,
    DROP COLUMN sync_wire_present`.execute(db);
  await sql`DROP TABLE operation_payloads`.execute(db);
  await sql`DROP FUNCTION operation_payload_sha256(jsonb, jsonb)`.execute(db);
  await sql`DROP FUNCTION operation_payload_canonical_bytes(jsonb, jsonb)`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
