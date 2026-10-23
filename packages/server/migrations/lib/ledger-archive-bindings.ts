import { sql, type Kysely } from 'kysely';

/** A committed floor proves the old prefix; each new segment proves only its contiguous tail. */
export async function setIncrementalLedgerArchiveBindings(db: Kysely<unknown>, incremental: boolean): Promise<void> {
  await replaceHistoryFloorBinding(db, incremental);
  await replacePurgeJobBinding(db, incremental);
}

async function replaceHistoryFloorBinding(
  db: Kysely<unknown>,
  incremental: boolean,
): Promise<void> {
  const lower = sql.raw(incremental ? 'OLD.floor_commit_ordinal + 1' : '1');
  const rows = sql.raw(incremental ? 'NEW.floor_commit_ordinal - OLD.floor_commit_ordinal' : 'NEW.floor_commit_ordinal');
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
        OR archive.source_relation <> 'public.operation_payloads'
        OR archive.source_scope <> 'collection:' || NEW.collection_id
        OR archive.source_key_kind <> 'bigint'
        OR archive.source_key_comparator <> 'signed-bigint-ascending-v1'
        OR lower(archive.source_key_bounds) <> ${lower}
        OR upper(archive.source_key_bounds) <> NEW.floor_commit_ordinal+1
        OR archive.row_count <> ${rows} OR archive.source_bytes <= 0
        OR archive.archive_schema_version <> 1
      THEN RAISE EXCEPTION 'Archive manifest does not bind the next complete operation payload segment'
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

async function replacePurgeJobBinding(db: Kysely<unknown>, incremental: boolean): Promise<void> {
  const bounds = sql.raw(incremental
    ? 'job.lower_bound < 1 OR job.upper_bound <> job.floor_commit_ordinal + 1'
    : 'job.lower_bound <> 1');
  await sql`CREATE OR REPLACE FUNCTION validate_ledger_payload_purge_binding(job ledger_payload_purge_jobs)
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
           OR ${bounds}
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
           OR ${bounds}
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
}
