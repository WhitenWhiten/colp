import { sql, type Kysely, type Migration } from 'kysely';

/**
 * The only database authority for destructive ledger payload/source cutover.
 * Roles are provisioned by operations; this migration deliberately grants no
 * application role and every capability is transaction-, job-, and lease-bound.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE ledger_payload_purge_jobs (
    job_id uuid PRIMARY KEY,
    segment_id uuid NOT NULL UNIQUE REFERENCES ledger_archive_segments(segment_id) ON DELETE RESTRICT,
    family text NOT NULL CHECK (family IN ('operation','audit_payload','outbox_social')),
    scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
    lower_bound bigint NOT NULL,
    upper_bound bigint NOT NULL,
    floor_commit_ordinal bigint,
    floor_tie_breaker text,
    floor_revision bigint,
    authorization_mode text NOT NULL CHECK (authorization_mode = 'development'),
    authorization_environment text NOT NULL CHECK (authorization_environment = 'development'),
    authorization_reference text NOT NULL CHECK (
      length(authorization_reference) BETWEEN 1 AND 256
      AND authorization_reference !~ '[[:cntrl:]]'
    ),
    authorization_evidence jsonb NOT NULL CHECK (
      jsonb_typeof(authorization_evidence) = 'object'
      AND authorization_evidence <> '{}'::jsonb
      AND authorization_evidence @> '{"developmentDataLossAuthorized":true}'::jsonb
      AND octet_length(authorization_evidence::text) <= 4096
    ),
    status text NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending','running','retryable','succeeded','failed')
    ),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner text,
    lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
    lease_expires_at timestamptz,
    available_at timestamptz NOT NULL DEFAULT current_timestamp,
    last_error_class text,
    deleted_row_count bigint NOT NULL DEFAULT 0 CHECK (deleted_row_count >= 0),
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    started_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT ledger_payload_purge_jobs_bounds_check CHECK (
      lower_bound >= 1 AND upper_bound > lower_bound
    ),
    CONSTRAINT ledger_payload_purge_jobs_floor_shape CHECK (
      (family = 'audit_payload' AND floor_commit_ordinal IS NULL
        AND floor_tie_breaker IS NULL AND floor_revision IS NULL)
      OR (family = 'operation' AND floor_commit_ordinal = upper_bound - 1
        AND floor_tie_breaker IS NOT NULL AND length(floor_tie_breaker) > 0
        AND floor_revision IS NOT NULL AND floor_revision > 0)
      OR (family = 'outbox_social' AND floor_commit_ordinal = upper_bound - 1
        AND floor_tie_breaker IS NOT NULL AND length(floor_tie_breaker) > 0
        AND floor_revision IS NOT NULL AND floor_revision > 0)
    ),
    CONSTRAINT ledger_payload_purge_jobs_lease_check CHECK (
      (status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CONSTRAINT ledger_payload_purge_jobs_completion_check CHECK (
      (status IN ('succeeded','failed')) = (completed_at IS NOT NULL)
    ),
    CONSTRAINT ledger_payload_purge_jobs_error_check CHECK (
      last_error_class IS NULL OR (
        length(last_error_class) BETWEEN 1 AND 96
        AND last_error_class ~ '^[a-z][a-z0-9_]*$'
      )
    ),
    CONSTRAINT ledger_payload_purge_jobs_time_check CHECK (
      available_at > '-infinity'::timestamptz
      AND created_at > '-infinity'::timestamptz
      AND updated_at >= created_at
      AND (started_at IS NULL OR started_at >= created_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
    )
  )`.execute(db);

  await sql`CREATE TABLE ledger_payload_purge_receipts (
    receipt_id uuid PRIMARY KEY,
    job_id uuid NOT NULL UNIQUE REFERENCES ledger_payload_purge_jobs(job_id) ON DELETE RESTRICT,
    segment_id uuid NOT NULL UNIQUE REFERENCES ledger_archive_segments(segment_id) ON DELETE RESTRICT,
    family text NOT NULL CHECK (family IN ('operation','audit_payload','outbox_social')),
    scope_key text NOT NULL,
    lower_bound bigint NOT NULL,
    upper_bound bigint NOT NULL,
    deleted_row_count bigint NOT NULL CHECK (deleted_row_count >= 0),
    authorization_mode text NOT NULL CHECK (authorization_mode = 'development'),
    evidence jsonb NOT NULL CHECK (
      jsonb_typeof(evidence) = 'object' AND evidence <> '{}'::jsonb
      AND evidence @> '{"developmentDataLossAuthorized":true}'::jsonb
      AND octet_length(evidence::text) <= 8192
    ),
    completed_at timestamptz NOT NULL DEFAULT current_timestamp
  )`.execute(db);

  await sql`CREATE INDEX ledger_payload_purge_jobs_due_idx
    ON ledger_payload_purge_jobs(available_at, created_at, job_id)
    WHERE status IN ('pending','retryable')`.execute(db);
  await sql`CREATE INDEX ledger_payload_purge_jobs_expired_lease_idx
    ON ledger_payload_purge_jobs(lease_expires_at, job_id)
    WHERE status = 'running'`.execute(db);

  // Capture a fixed, schema-local SECURITY DEFINER search path. Listing
  // pg_temp last prevents implicit temporary-schema precedence.
  await sql`SELECT set_config(
    'search_path', quote_ident(current_schema()) || ',pg_catalog,pg_temp', true
  )`.execute(db);
  await replaceSyncHistoryFloorArchiveRelation(db, true);
  await createAuthorizationFunctions(db);
  await createJobGuards(db);
  await replacePayloadGuards(db);
  await createOutboxGuards(db);
  await createDetachGuard(db);

  await sql`COMMENT ON TABLE ledger_payload_purge_jobs IS
    'Development-authorized, manifest-bound destructive payload/source purge jobs. No generic relation DELETE authority.'`.execute(db);
  await sql`COMMENT ON TABLE ledger_payload_purge_receipts IS
    'Permanent evidence of database source rows removed by a fenced payload purge job.'`.execute(db);
}

async function replaceSyncHistoryFloorArchiveRelation(
  db: Kysely<unknown>,
  payloadRelation: boolean,
): Promise<void> {
  const sourceRelation = payloadRelation
    ? sql.raw("'public.operation_payloads'")
    : sql.raw("'public.operations'");
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
          OR NEW.floor_stable_id <> '' OR NEW.archive_segment_id IS NOT NULL
          OR NEW.state_revision <> 0
        THEN RAISE EXCEPTION 'Sync history floor must materialize at implicit zero'
          USING ERRCODE='23514', CONSTRAINT='sync_history_floors_transition_guard'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
        OR NEW.state_revision <> OLD.state_revision + 1 OR NEW.floor_stream_kind <> 0
        OR (NEW.floor_commit_ordinal, NEW.floor_stream_kind,
          NEW.floor_stable_id COLLATE "C") <= (OLD.floor_commit_ordinal,
          OLD.floor_stream_kind, OLD.floor_stable_id COLLATE "C")
        OR NEW.archive_segment_id IS NULL OR NEW.advanced_at < OLD.advanced_at
      THEN RAISE EXCEPTION 'Sync history floor must advance by one revision'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_transition_guard'; END IF;
      LOCK TABLE sync_replicas IN SHARE MODE;
      IF NOT EXISTS (SELECT 1 FROM operations operation
        WHERE operation.collection_id=NEW.collection_id
          AND operation.commit_ordinal=NEW.floor_commit_ordinal
          AND operation.sync_stream_kind=0
          AND operation.operation_id=NEW.floor_stable_id
          AND operation.sync_wire_present)
      THEN RAISE EXCEPTION 'Sync history floor boundary is not an operation tuple'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_boundary_missing'; END IF;
      SELECT * INTO archive FROM ledger_archive_segments segment
        WHERE segment.segment_id=NEW.archive_segment_id FOR SHARE;
      IF NOT FOUND OR archive.ledger_family <> 'operation'
        OR archive.source_relation <> ${sourceRelation}
        OR archive.source_scope <> 'collection:' || NEW.collection_id
        OR archive.source_key_kind <> 'bigint'
        OR archive.source_key_comparator <> 'signed-bigint-ascending-v1'
        OR lower(archive.source_key_bounds) <> 1
        OR upper(archive.source_key_bounds) <> NEW.floor_commit_ordinal+1
        OR archive.row_count <> NEW.floor_commit_ordinal OR archive.source_bytes <= 0
        OR archive.archive_schema_version <> 1
      THEN RAISE EXCEPTION 'Archive manifest does not bind the complete operation payload prefix'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_binding_mismatch'; END IF;
      IF archive.state NOT IN ('verified','reader_cutover','detached','deletable','deleted')
        OR archive.verified_at IS NULL OR NOT (archive.stage_evidence ? 'verified')
      THEN RAISE EXCEPTION 'Archive manifest has not reached verified state'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_archive_not_verified'; END IF;
      IF EXISTS (SELECT 1 FROM sync_replicas replica
        WHERE replica.collection_id=NEW.collection_id AND replica.status='active'
          AND (replica.checkpoint_commit_ordinal IS NULL
            OR replica.checkpoint_stream_kind IS NULL OR replica.checkpoint_stable_id IS NULL
            OR (replica.checkpoint_commit_ordinal, replica.checkpoint_stream_kind,
              replica.checkpoint_stable_id COLLATE "C") < (NEW.floor_commit_ordinal,
              NEW.floor_stream_kind, NEW.floor_stable_id COLLATE "C")))
      THEN RAISE EXCEPTION 'An active Replica checkpoint is behind the Sync history floor'
        USING ERRCODE='23514', CONSTRAINT='sync_history_floors_active_replica_behind'; END IF;
      NEW.advanced_at := current_timestamp; RETURN NEW;
    END $body$`.execute(db);
}

async function createAuthorizationFunctions(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION ledger_payload_purger_role_member() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE purge_role oid;
    BEGIN
      purge_role := to_regrole('known_ledger_payload_purger');
      RETURN purge_role IS NOT NULL
        AND pg_has_role(session_user, purge_role, 'member');
    END
    $function$`.execute(db);

  await sql`CREATE FUNCTION ledger_payload_purge_authorized(expected_family text) RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE configured_job text;
    DECLARE configured_token text;
    BEGIN
      configured_job := current_setting('known.ledger_payload_purge_job', true);
      configured_token := current_setting('known.ledger_payload_purge_lease_token', true);
      RETURN ledger_payload_purger_role_member()
        AND current_setting('known.ledger_payload_purge_transaction', true)
          = pg_current_xact_id()::text
        AND configured_job ~ '^[0-9a-fA-F-]{36}$'
        AND configured_token ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM ledger_payload_purge_jobs job
          WHERE job.job_id = configured_job::uuid
            AND job.family = expected_family
            AND job.status = 'running'
            AND job.lease_token = configured_token::bigint
            AND job.lease_expires_at > current_timestamp
        );
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN false;
    END
    $function$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION ledger_payload_purger_role_member() FROM PUBLIC`.execute(db);
  await sql`REVOKE ALL ON FUNCTION ledger_payload_purge_authorized(text) FROM PUBLIC`.execute(db);
}

async function createJobGuards(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION validate_ledger_payload_purge_binding(job ledger_payload_purge_jobs)
    RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE segment ledger_archive_segments%ROWTYPE;
    BEGIN
      SELECT * INTO segment FROM ledger_archive_segments manifest
       WHERE manifest.segment_id = job.segment_id FOR SHARE;
      IF NOT FOUND OR segment.state <> 'reader_cutover' OR segment.legal_hold
         OR segment.verified_at IS NULL OR segment.reader_cutover_at IS NULL
         OR NOT (segment.stage_evidence ? 'verified')
         OR NOT (segment.stage_evidence ? 'reader_cutover')
         OR lower(segment.source_key_bounds) <> job.lower_bound
         OR upper(segment.source_key_bounds) <> job.upper_bound THEN
        RAISE EXCEPTION 'Purge job requires an exact, verified reader-cutover segment without legal hold'
          USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_manifest_not_ready';
      END IF;

      IF job.family = 'operation' THEN
        IF segment.ledger_family <> 'operation'
           OR segment.source_relation <> 'public.operation_payloads'
           OR segment.source_scope <> 'collection:' || job.scope_key
           OR job.lower_bound <> 1
           OR NOT EXISTS (
             SELECT 1 FROM sync_history_floors floor
             WHERE floor.collection_id = job.scope_key
               AND floor.archive_segment_id = job.segment_id
               AND floor.state_revision = job.floor_revision
               AND floor.floor_commit_ordinal >= job.floor_commit_ordinal
               AND floor.floor_stable_id = job.floor_tie_breaker
           )
           OR EXISTS (
             SELECT 1 FROM sync_replicas replica
             WHERE replica.collection_id = job.scope_key AND replica.status = 'active'
               AND (replica.checkpoint_commit_ordinal IS NULL
                 OR replica.checkpoint_stream_kind IS NULL
                 OR replica.checkpoint_stable_id IS NULL
                 OR (replica.checkpoint_commit_ordinal, replica.checkpoint_stream_kind,
                     replica.checkpoint_stable_id COLLATE "C")
                    < (job.floor_commit_ordinal, 0, job.floor_tie_breaker COLLATE "C"))
           ) THEN
          RAISE EXCEPTION 'Operation purge job is not bound to its floor or active replicas'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_operation_binding';
        END IF;
      ELSIF job.family = 'audit_payload' THEN
        IF segment.ledger_family <> 'audit_payload'
           OR segment.source_relation <> 'public.audit_event_payloads'
           OR segment.source_scope <> job.scope_key THEN
          RAISE EXCEPTION 'Audit payload purge job does not match its archive segment'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_audit_binding';
        END IF;
      ELSE
        IF segment.ledger_family <> 'outbox_social'
           OR segment.source_relation <> 'public.outbox_events'
           OR segment.source_scope <> job.scope_key
           OR job.lower_bound <> 1
           OR NOT EXISTS (
             SELECT 1 FROM outbox_retention_floors floor
             WHERE floor.handler_name = 'social.publish-collection-change'
               AND floor.event_type = 'social.collection-change'
               AND floor.aggregate_scope = job.scope_key
               AND floor.state_revision = job.floor_revision
               AND (floor.floor_commit_ordinal, floor.floor_domain_event_id)
                 >= (job.floor_commit_ordinal, job.floor_tie_breaker)
           )
           OR EXISTS (
             SELECT 1 FROM outbox_events source
             WHERE source.handler_name = 'social.publish-collection-change'
               AND source.event_type = 'social.collection-change'
               AND source.aggregate_scope = job.scope_key
               AND source.commit_ordinal >= job.lower_bound
               AND source.commit_ordinal < job.upper_bound
               AND (source.commit_ordinal, source.domain_event_id)
                   > (job.floor_commit_ordinal, job.floor_tie_breaker)
           ) THEN
          RAISE EXCEPTION 'Social Outbox purge job is not bound to its exact retention floor'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_outbox_binding';
        END IF;
      END IF;
    END
    $function$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION validate_ledger_payload_purge_binding(
    ledger_payload_purge_jobs) FROM PUBLIC`.execute(db);

  await sql`CREATE FUNCTION guard_ledger_payload_purge_job() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    BEGIN
      IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Ledger payload purge jobs are durable and cannot be removed'
          USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_immutable';
      END IF;
      IF NOT ledger_payload_purger_role_member() THEN
        RAISE EXCEPTION 'Ledger payload purge jobs require the externally provisioned purge role'
          USING ERRCODE='42501';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 OR NEW.lease_token <> 0
           OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
           OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL
           OR NEW.deleted_row_count <> 0 OR NEW.last_error_class IS NOT NULL THEN
          RAISE EXCEPTION 'Purge jobs must start in the canonical pending state'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_transition_guard';
        END IF;
        PERFORM validate_ledger_payload_purge_binding(NEW);
        RETURN NEW;
      END IF;
      IF (to_jsonb(NEW) - ARRAY[
          'status','attempt_count','lease_owner','lease_token','lease_expires_at','available_at',
          'last_error_class','deleted_row_count','started_at','completed_at','updated_at'
        ]::text[]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
          'status','attempt_count','lease_owner','lease_token','lease_expires_at','available_at',
          'last_error_class','deleted_row_count','started_at','completed_at','updated_at'
        ]::text[]) OR NEW.deleted_row_count < OLD.deleted_row_count THEN
        RAISE EXCEPTION 'Purge job identity, bounds, authorization, and counters are immutable'
          USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_identity_guard';
      END IF;
      IF OLD.status = 'running' AND NEW.status = 'running'
         AND NEW.attempt_count = OLD.attempt_count
         AND NEW.lease_token = OLD.lease_token
         AND NEW.lease_owner = OLD.lease_owner
         AND NEW.lease_expires_at = OLD.lease_expires_at
         AND NEW.available_at = OLD.available_at
         AND NEW.last_error_class IS NOT DISTINCT FROM OLD.last_error_class
         AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
         AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
         AND ledger_payload_purge_authorized(OLD.family) THEN
        NULL; -- progress checkpoint under the same live fenced lease
      ELSIF NEW.status = 'running' THEN
        IF NOT ((OLD.status IN ('pending','retryable')
              OR (OLD.status = 'running' AND OLD.lease_expires_at <= current_timestamp))
            AND NEW.attempt_count = OLD.attempt_count + 1
            AND NEW.lease_token = OLD.lease_token + 1
            AND NEW.lease_owner IS NOT NULL AND length(NEW.lease_owner) BETWEEN 1 AND 128
            AND NEW.lease_expires_at > current_timestamp
            AND NEW.completed_at IS NULL) THEN
          RAISE EXCEPTION 'Illegal purge job lease claim'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_lease_fence';
        END IF;
        PERFORM validate_ledger_payload_purge_binding(NEW);
      ELSIF OLD.status = 'running' AND NEW.status IN ('retryable','failed','succeeded') THEN
        IF NOT ledger_payload_purge_authorized(OLD.family)
           OR NEW.attempt_count <> OLD.attempt_count OR NEW.lease_token <> OLD.lease_token
           OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
           OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
          RAISE EXCEPTION 'Purge job completion requires its live transaction-bound lease'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_lease_fence';
        END IF;
        IF NEW.status = 'retryable' AND (
             NEW.completed_at IS NOT NULL
             OR (NEW.last_error_class IS NULL AND NEW.available_at > current_timestamp)
             OR (NEW.last_error_class IS NOT NULL AND NEW.available_at < current_timestamp)
           ) THEN
          RAISE EXCEPTION 'Purge retry must be an immediate batch release or delayed error retry'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_transition_guard';
        END IF;
        IF NEW.status = 'failed'
           AND (NEW.last_error_class IS NULL OR NEW.completed_at IS NULL) THEN
          RAISE EXCEPTION 'Failed purge jobs require a classified terminal outcome'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_transition_guard';
        END IF;
        IF NEW.status = 'succeeded' AND NOT EXISTS (
          SELECT 1 FROM ledger_archive_segments segment
          WHERE segment.segment_id = NEW.segment_id
            AND segment.state = 'detached' AND NOT segment.legal_hold
            AND segment.stage_evidence ? 'verified'
            AND segment.stage_evidence ? 'reader_cutover'
            AND segment.stage_evidence ? 'detached'
            AND segment.stage_evidence -> 'detached' ->> 'purgeJobId' = NEW.job_id::text
            AND segment.stage_evidence -> 'detached' ->> 'authorizationMode' = 'development'
        ) THEN
          RAISE EXCEPTION 'Purge success requires verified reader cutover and job-bound detach evidence'
            USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_success_evidence';
        END IF;
      ELSE
        RAISE EXCEPTION 'Illegal purge job state transition'
          USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_jobs_transition_guard';
      END IF;
      NEW.updated_at := current_timestamp;
      RETURN NEW;
    END
    $function$`.execute(db);

  await sql`CREATE TRIGGER ledger_payload_purge_jobs_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ledger_payload_purge_jobs
    FOR EACH ROW EXECUTE FUNCTION guard_ledger_payload_purge_job()`.execute(db);
  await sql`CREATE TRIGGER ledger_payload_purge_jobs_truncate_guard
    BEFORE TRUNCATE ON ledger_payload_purge_jobs
    FOR EACH STATEMENT EXECUTE FUNCTION guard_ledger_payload_purge_job()`.execute(db);

  await sql`CREATE FUNCTION write_ledger_payload_purge_receipt() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    BEGIN
      IF OLD.status <> 'succeeded' AND NEW.status = 'succeeded' THEN
        PERFORM set_config('known.ledger_payload_purge_receipt_job', NEW.job_id::text, true);
        INSERT INTO ledger_payload_purge_receipts(
          receipt_id, job_id, segment_id, family, scope_key, lower_bound, upper_bound,
          deleted_row_count, authorization_mode, evidence
        ) VALUES (
          gen_random_uuid(), NEW.job_id, NEW.segment_id, NEW.family, NEW.scope_key,
          NEW.lower_bound, NEW.upper_bound, NEW.deleted_row_count, NEW.authorization_mode,
          NEW.authorization_evidence || jsonb_build_object(
            'purgeJobId', NEW.job_id, 'segmentId', NEW.segment_id,
            'leaseToken', NEW.lease_token, 'sourceRowsDeleted', NEW.deleted_row_count
          )
        );
      END IF;
      RETURN NULL;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER ledger_payload_purge_jobs_receipt
    AFTER UPDATE OF status ON ledger_payload_purge_jobs
    FOR EACH ROW EXECUTE FUNCTION write_ledger_payload_purge_receipt()`.execute(db);

  await sql`CREATE FUNCTION guard_ledger_payload_purge_receipt() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    BEGIN
      IF TG_OP <> 'INSERT' OR current_setting('known.ledger_payload_purge_receipt_job', true)
          IS DISTINCT FROM NEW.job_id::text OR NOT EXISTS (
        SELECT 1 FROM ledger_payload_purge_jobs job
        WHERE job.job_id = NEW.job_id AND job.status = 'succeeded'
      ) THEN
        RAISE EXCEPTION 'Ledger payload purge receipts are trigger-owned and immutable'
          USING ERRCODE='23514', CONSTRAINT='ledger_payload_purge_receipts_immutable';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER ledger_payload_purge_receipts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ledger_payload_purge_receipts
    FOR EACH ROW EXECUTE FUNCTION guard_ledger_payload_purge_receipt()`.execute(db);
  await sql`CREATE TRIGGER ledger_payload_purge_receipts_truncate_guard
    BEFORE TRUNCATE ON ledger_payload_purge_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION guard_ledger_payload_purge_receipt()`.execute(db);
}

async function replacePayloadGuards(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION operation_payload_archive_authorized() RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE archive_role oid;
    BEGIN
      archive_role := to_regrole('known_operation_payload_archiver');
      RETURN archive_role IS NOT NULL
        AND pg_has_role(session_user, archive_role, 'member')
        AND current_setting('known.operation_payload_archive', true) = 'enabled'
        AND current_setting('known.operation_payload_archive_transaction', true)
          = pg_current_xact_id()::text
        AND ledger_payload_purge_authorized('operation');
    END
    $function$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION guard_operation_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE job ledger_payload_purge_jobs%ROWTYPE;
    BEGIN
      IF TG_OP IN ('TRUNCATE','DELETE') THEN
        RAISE EXCEPTION 'Operation facts are permanent'
          USING ERRCODE='23514', CONSTRAINT='operations_permanent';
      END IF;
      SELECT * INTO job FROM ledger_payload_purge_jobs
       WHERE job_id = nullif(current_setting('known.ledger_payload_purge_job', true),'')::uuid;
      IF NOT operation_payload_archive_authorized() OR NOT FOUND
         OR OLD.payload_source <> 'hot' OR NEW.payload_source <> 'archive'
         OR OLD.collection_id <> job.scope_key
         OR OLD.commit_ordinal < job.lower_bound OR OLD.commit_ordinal >= job.upper_bound
         OR NEW.payload_locator <> 'archive://ledger-segment/' || job.segment_id::text
              || '/operation/' || OLD.operation_id
         OR (to_jsonb(NEW) - ARRAY[
              'payload_source','payload_locator','sync_stream_kind'
            ]::text[])
              IS DISTINCT FROM
            (to_jsonb(OLD) - ARRAY[
              'payload_source','payload_locator','sync_stream_kind'
            ]::text[]) THEN
        RAISE EXCEPTION 'Operation facts are immutable outside their fenced payload cutover'
          USING ERRCODE='23514', CONSTRAINT='operations_permanent';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Operation facts are immutable outside their fenced payload cutover'
        USING ERRCODE='23514', CONSTRAINT='operations_permanent';
    END
    $function$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION guard_operation_payload_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE job ledger_payload_purge_jobs%ROWTYPE;
    BEGIN
      IF TG_OP IN ('TRUNCATE','UPDATE') THEN
        RAISE EXCEPTION 'Operation payloads may only be deleted by a fenced purge job'
          USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable';
      END IF;
      SELECT * INTO job FROM ledger_payload_purge_jobs
       WHERE job_id = nullif(current_setting('known.ledger_payload_purge_job', true),'')::uuid;
      IF NOT operation_payload_archive_authorized() OR NOT FOUND
         OR OLD.collection_id <> job.scope_key
         OR OLD.commit_ordinal < job.lower_bound OR OLD.commit_ordinal >= job.upper_bound
         OR NOT EXISTS (
           SELECT 1 FROM operations operation
           WHERE operation.operation_id = OLD.operation_id
             AND operation.payload_source = 'archive'
             AND operation.payload_locator = 'archive://ledger-segment/' || job.segment_id::text
               || '/operation/' || OLD.operation_id
         ) THEN
        RAISE EXCEPTION 'Operation payload delete is outside its fenced archive cutover'
          USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable';
      END IF;
      RETURN OLD;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Operation payload delete is outside its fenced archive cutover'
        USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable';
    END
    $function$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION audit_payload_archive_authorized() RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE archive_role oid;
    BEGIN
      archive_role := to_regrole('known_audit_payload_archiver');
      RETURN archive_role IS NOT NULL
        AND pg_has_role(session_user, archive_role, 'member')
        AND current_setting('known.audit_payload_archive_capability', true) = 'enabled'
        AND current_setting('known.audit_payload_archive_transaction', true)
          = pg_current_xact_id()::text
        AND ledger_payload_purge_authorized('audit_payload');
    END
    $function$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION guard_audit_event_header_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE job ledger_payload_purge_jobs%ROWTYPE;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'Audit event headers are permanent'
        USING ERRCODE='23514', CONSTRAINT='audit_events_truncate_guard'; END IF;
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Audit event headers are permanent'
        USING ERRCODE='23514', CONSTRAINT='audit_events_delete_guard'; END IF;
      SELECT * INTO job FROM ledger_payload_purge_jobs
       WHERE job_id = nullif(current_setting('known.ledger_payload_purge_job', true),'')::uuid;
      IF NOT audit_payload_archive_authorized() OR NOT FOUND
         OR OLD.id < job.lower_bound OR OLD.id >= job.upper_bound
         OR NEW.payload_archive_segment_id <> job.segment_id
         OR NEW.payload_bucket_locator <> 'archive://ledger-segment/' || job.segment_id::text
              || '/audit-event/' || OLD.id::text
         OR OLD.hot_payload_id <> OLD.id OR NEW.hot_payload_id IS NOT NULL
         OR (to_jsonb(NEW) - ARRAY[
              'hot_payload_id','payload_archive_segment_id','payload_bucket_locator'
            ]::text[]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
              'hot_payload_id','payload_archive_segment_id','payload_bucket_locator'
            ]::text[]) THEN
        RAISE EXCEPTION 'Audit header mutation is outside its fenced payload cutover'
          USING ERRCODE='23514', CONSTRAINT='audit_events_archive_cutover_guard';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit event headers are immutable'
        USING ERRCODE='23514', CONSTRAINT='audit_events_update_guard';
    END
    $function$`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION guard_audit_event_payload_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE job ledger_payload_purge_jobs%ROWTYPE;
    BEGIN
      IF TG_OP IN ('TRUNCATE','UPDATE') THEN
        RAISE EXCEPTION 'Audit hot payloads may only be deleted by a fenced purge job'
          USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard';
      END IF;
      SELECT * INTO job FROM ledger_payload_purge_jobs
       WHERE job_id = nullif(current_setting('known.ledger_payload_purge_job', true),'')::uuid;
      IF NOT audit_payload_archive_authorized() OR NOT FOUND
         OR OLD.event_id < job.lower_bound OR OLD.event_id >= job.upper_bound
         OR NOT EXISTS (
           SELECT 1 FROM audit_events event
           WHERE event.id = OLD.event_id AND event.hot_payload_id IS NULL
             AND event.payload_archive_segment_id = job.segment_id
         ) THEN
        RAISE EXCEPTION 'Audit payload delete is outside its fenced archive cutover'
          USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard';
      END IF;
      RETURN OLD;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Audit payload mutation requires a fenced purge job'
        USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard';
    END
    $function$`.execute(db);
}

async function createOutboxGuards(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION guard_outbox_event_delete_for_purge() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE job ledger_payload_purge_jobs%ROWTYPE;
    DECLARE outbox_role oid;
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'Outbox events cannot be truncated'
          USING ERRCODE='23514', CONSTRAINT='outbox_events_truncate_guard';
      END IF;
      outbox_role := to_regrole('known_outbox_payload_archiver');
      SELECT * INTO job FROM ledger_payload_purge_jobs
       WHERE job_id = nullif(current_setting('known.ledger_payload_purge_job', true),'')::uuid;
      IF outbox_role IS NULL OR NOT pg_has_role(session_user, outbox_role, 'member')
         OR NOT ledger_payload_purge_authorized('outbox_social') OR NOT FOUND
         OR OLD.handler_name <> 'social.publish-collection-change'
         OR OLD.event_type <> 'social.collection-change'
         OR OLD.aggregate_scope <> job.scope_key OR OLD.commit_ordinal IS NULL
         OR OLD.commit_ordinal < job.lower_bound OR OLD.commit_ordinal >= job.upper_bound
         OR (OLD.commit_ordinal, OLD.domain_event_id)
              > (job.floor_commit_ordinal, job.floor_tie_breaker)
         OR OLD.state <> 'completed'
         OR OLD.occurred_at > current_timestamp - interval '90 days'
         OR NOT EXISTS (
           SELECT 1 FROM outbox_retention_floors floor
           WHERE floor.handler_name = OLD.handler_name AND floor.event_type = OLD.event_type
             AND floor.aggregate_scope = OLD.aggregate_scope
             AND floor.state_revision = job.floor_revision
             AND (OLD.commit_ordinal, OLD.domain_event_id)
                   <= (floor.floor_commit_ordinal, floor.floor_domain_event_id)
         ) THEN
        RAISE EXCEPTION 'Outbox delete is outside the authorized social retention prefix'
          USING ERRCODE='23514', CONSTRAINT='outbox_events_delete_guard';
      END IF;
      RETURN OLD;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Outbox delete requires a fenced purge job'
        USING ERRCODE='23514', CONSTRAINT='outbox_events_delete_guard';
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER outbox_events_delete_guard
    BEFORE DELETE ON outbox_events FOR EACH ROW
    EXECUTE FUNCTION guard_outbox_event_delete_for_purge()`.execute(db);
  await sql`CREATE TRIGGER outbox_events_truncate_guard
    BEFORE TRUNCATE ON outbox_events FOR EACH STATEMENT
    EXECUTE FUNCTION guard_outbox_event_delete_for_purge()`.execute(db);
}

async function createDetachGuard(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION guard_payload_purge_segment_detach() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $function$
    DECLARE job ledger_payload_purge_jobs%ROWTYPE;
    BEGIN
      IF TG_OP <> 'UPDATE' OR NEW.state <> 'detached' OR OLD.state = 'detached'
         OR NOT (
           (OLD.ledger_family = 'operation'
             AND OLD.source_relation = 'public.operation_payloads')
           OR (OLD.ledger_family = 'audit_payload'
             AND OLD.source_relation = 'public.audit_event_payloads')
           OR (OLD.ledger_family = 'outbox_social'
             AND OLD.source_relation = 'public.outbox_events')
         ) THEN
        RETURN NEW;
      END IF;
      SELECT * INTO job FROM ledger_payload_purge_jobs
       WHERE job_id = nullif(current_setting('known.ledger_payload_purge_job', true),'')::uuid
         AND segment_id = OLD.segment_id;
      IF NOT FOUND OR NOT ledger_payload_purge_authorized(job.family)
         OR OLD.state <> 'reader_cutover' OR OLD.legal_hold
         OR NEW.stage_evidence -> 'detached' ->> 'purgeJobId' <> job.job_id::text
         OR NEW.stage_evidence -> 'detached' ->> 'authorizationMode' <> 'development'
         OR NEW.stage_evidence -> 'detached' ->> 'sourceRowsDeleted' <> job.deleted_row_count::text THEN
        RAISE EXCEPTION 'Segment detach requires its completed fenced purge job evidence'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_payload_detach_guard';
      END IF;
      IF (job.family = 'operation' AND (
            EXISTS (SELECT 1 FROM operation_payloads payload
              WHERE payload.collection_id=job.scope_key
                AND payload.commit_ordinal>=job.lower_bound
                AND payload.commit_ordinal<job.upper_bound)
            OR EXISTS (SELECT 1 FROM operations operation
              WHERE operation.collection_id=job.scope_key
                AND operation.commit_ordinal>=job.lower_bound
                AND operation.commit_ordinal<job.upper_bound
                AND (operation.payload_source <> 'archive'
                  OR operation.payload_locator <> 'archive://ledger-segment/' || job.segment_id::text
                    || '/operation/' || operation.operation_id))))
         OR (job.family = 'audit_payload' AND (
            EXISTS (SELECT 1 FROM audit_event_payloads payload
              WHERE payload.event_id>=job.lower_bound AND payload.event_id<job.upper_bound)
            OR EXISTS (SELECT 1 FROM audit_events event
              WHERE event.id>=job.lower_bound AND event.id<job.upper_bound
                AND (event.hot_payload_id IS NOT NULL
                  OR event.payload_archive_segment_id <> job.segment_id))))
         OR (job.family = 'outbox_social' AND EXISTS (
            SELECT 1 FROM outbox_events source
             WHERE source.handler_name='social.publish-collection-change'
               AND source.event_type='social.collection-change'
               AND source.aggregate_scope=job.scope_key
               AND source.commit_ordinal>=job.lower_bound
               AND source.commit_ordinal<job.upper_bound)) THEN
        RAISE EXCEPTION 'Segment cannot detach while bound hot payload/source rows remain'
          USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_payload_not_empty';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Segment detach requires a fenced purge job'
        USING ERRCODE='23514', CONSTRAINT='ledger_archive_segments_payload_detach_guard';
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER ledger_archive_segments_payload_detach_guard
    BEFORE UPDATE OF state ON ledger_archive_segments FOR EACH ROW
    EXECUTE FUNCTION guard_payload_purge_segment_detach()`.execute(db);
}

/** Developer/test rollback only; it refuses after any physical purge receipt. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $block$ BEGIN
    IF EXISTS (SELECT 1 FROM ledger_payload_purge_receipts) THEN
      RAISE EXCEPTION 'payload purge migration down refused after physical deletion receipts';
    END IF;
  END $block$`.execute(db);
  await replaceSyncHistoryFloorArchiveRelation(db, false);
  await sql`DROP TRIGGER IF EXISTS ledger_archive_segments_payload_detach_guard ON ledger_archive_segments`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_payload_purge_segment_detach()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_events_truncate_guard ON outbox_events`.execute(db);
  await sql`DROP TRIGGER IF EXISTS outbox_events_delete_guard ON outbox_events`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_outbox_event_delete_for_purge()`.execute(db);
  await restorePrePurgePayloadGuards(db);
  await sql`DROP TRIGGER IF EXISTS ledger_payload_purge_receipts_truncate_guard ON ledger_payload_purge_receipts`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_payload_purge_receipts_guard ON ledger_payload_purge_receipts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_ledger_payload_purge_receipt()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_payload_purge_jobs_receipt ON ledger_payload_purge_jobs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS write_ledger_payload_purge_receipt()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_payload_purge_jobs_truncate_guard ON ledger_payload_purge_jobs`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_payload_purge_jobs_guard ON ledger_payload_purge_jobs`.execute(db);
  await sql`DROP FUNCTION IF EXISTS guard_ledger_payload_purge_job()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_ledger_payload_purge_binding(ledger_payload_purge_jobs)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledger_payload_purge_authorized(text)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS ledger_payload_purger_role_member()`.execute(db);
  await sql`DROP TABLE IF EXISTS ledger_payload_purge_receipts`.execute(db);
  await sql`DROP TABLE IF EXISTS ledger_payload_purge_jobs`.execute(db);
  // Earlier migrations own the original Operation/Audit guards and will restore
  // them during a full down/up reconstruction.
}

async function restorePrePurgePayloadGuards(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION operation_payload_archive_authorized() RETURNS boolean
    LANGUAGE plpgsql STABLE AS $body$
    DECLARE archive_role oid;
    BEGIN
      archive_role := to_regrole('known_operation_payload_archiver');
      RETURN archive_role IS NOT NULL
        AND pg_has_role(session_user, archive_role, 'member')
        AND current_setting('known.operation_payload_archive', true) = 'enabled';
    END $body$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION guard_operation_payload_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN
      IF TG_OP = 'TRUNCATE' OR NOT operation_payload_archive_authorized() THEN
        RAISE EXCEPTION 'Operation payloads are immutable; archive capability is required'
          USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable';
      END IF;
      IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Operation payloads cannot be updated'
        USING ERRCODE='23514', CONSTRAINT='operation_payloads_immutable'; END IF;
      RETURN OLD;
    END $body$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION guard_operation_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $body$ BEGIN
      IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Operation facts are permanent'
        USING ERRCODE='23514', CONSTRAINT='operations_permanent'; END IF;
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

  await sql`CREATE OR REPLACE FUNCTION audit_payload_archive_authorized() RETURNS boolean
    LANGUAGE plpgsql VOLATILE AS $function$
    DECLARE archiver_role oid;
    BEGIN
      SELECT oid INTO archiver_role FROM pg_roles WHERE rolname='known_audit_payload_archiver';
      RETURN archiver_role IS NOT NULL
        AND pg_has_role(session_user, archiver_role, 'member')
        AND current_setting('known.audit_payload_archive_capability', true)='enabled'
        AND current_setting('known.audit_payload_archive_transaction', true)
          = pg_current_xact_id()::text;
    END $function$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION guard_audit_event_header_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $function$ BEGIN
      IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Audit event headers are permanent and cannot be truncated'
        USING ERRCODE='23514', CONSTRAINT='audit_events_truncate_guard'; END IF;
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Audit event headers are permanent and cannot be deleted'
        USING ERRCODE='23514', CONSTRAINT='audit_events_delete_guard'; END IF;
      IF NOT audit_payload_archive_authorized() THEN RAISE EXCEPTION 'Audit event headers are immutable'
        USING ERRCODE='23514', CONSTRAINT='audit_events_update_guard'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.collection_id IS DISTINCT FROM OLD.collection_id
        OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
        OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
        OR NEW.payload_bytes IS DISTINCT FROM OLD.payload_bytes
        OR NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version
        OR OLD.hot_payload_id IS NULL OR NEW.hot_payload_id IS NOT NULL
        OR OLD.payload_archive_segment_id IS NOT NULL OR NEW.payload_archive_segment_id IS NULL
        OR NEW.payload_bucket_locator LIKE 'hot://%' THEN
        RAISE EXCEPTION 'Archive capability may only cut a hot payload over to a cold locator'
          USING ERRCODE='23514', CONSTRAINT='audit_events_archive_cutover_guard';
      END IF;
      RETURN NEW;
    END $function$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION guard_audit_event_payload_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $function$ BEGIN
      IF NOT audit_payload_archive_authorized() THEN
        RAISE EXCEPTION 'Audit hot payload mutation requires a transaction-local archive capability'
          USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard'; END IF;
      IF TG_OP='UPDATE' OR TG_OP='TRUNCATE' THEN
        RAISE EXCEPTION 'Audit hot payloads may only be removed after reader cutover'
          USING ERRCODE='23514', CONSTRAINT='audit_event_payloads_mutation_guard'; END IF;
      RETURN OLD;
    END $function$`.execute(db);
}

const migration: Migration = { up, down };
export default migration;
