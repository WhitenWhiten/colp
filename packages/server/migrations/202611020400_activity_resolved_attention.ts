import { sql, type Kysely } from 'kysely';

/** Reconcile notifications with the final run state and outstanding approval jobs. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION activity_record_run() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE activity_kind text; current_run automation_runs%ROWTYPE; BEGIN
    SELECT * INTO current_run FROM automation_runs WHERE id=NEW.id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF current_run.state NOT IN ('completed','partial','failed','blocked','review') THEN
      IF current_run.state='cancelled' OR NOT EXISTS (
        SELECT 1 FROM automation_jobs WHERE run_id=current_run.id AND state='awaitingApproval'
      ) THEN DELETE FROM activity_items WHERE run_id=current_run.id; END IF;
      RETURN NEW;
    END IF;
    IF current_run.explanation_json->>'manualSelection'='true' OR
      (current_run.kind <> 'manual' AND NOT EXISTS (SELECT 1 FROM automation_rule_revisions v WHERE v.id=current_run.rule_revision_id
        AND jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)) THEN RETURN NEW; END IF;
    activity_kind := CASE current_run.state WHEN 'completed' THEN 'run_completed' WHEN 'partial' THEN 'run_partial'
      WHEN 'review' THEN 'run_attention' ELSE 'run_failed' END;
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      VALUES(gen_random_uuid()::text,current_run.owner_id,activity_kind,'run:'||current_run.id,current_run.id,current_run.explanation_json->>'collectionId',
        (SELECT count(*) FROM automation_run_outputs WHERE run_id=current_run.id),
        jsonb_build_object('status',current_run.state,'attention',CASE WHEN current_run.state='review' THEN 'review' END))
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=CASE
        WHEN activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.details_json->>'status' IS DISTINCT FROM current_run.state
        THEN NULL ELSE activity_items.read_at END
      WHERE activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.count IS DISTINCT FROM EXCLUDED.count
        OR activity_items.details_json IS DISTINCT FROM EXCLUDED.details_json;
    RETURN NEW;
  END $$;
  CREATE OR REPLACE FUNCTION activity_record_job_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      SELECT gen_random_uuid()::text,r.owner_id,'run_attention','run:'||r.id,r.id,r.explanation_json->>'collectionId',
        (SELECT count(*) FROM automation_run_outputs WHERE run_id=r.id),jsonb_build_object('status',r.state,'attention','awaitingApproval')
      FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id WHERE r.id=NEW.run_id AND r.state<>'cancelled'
        AND r.explanation_json->>'manualSelection' IS DISTINCT FROM 'true'
        AND (r.kind='manual' OR jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=NULL;
    RETURN NEW;
  END $$;
  DROP TRIGGER activity_run ON automation_runs;
  CREATE CONSTRAINT TRIGGER activity_run AFTER INSERT OR UPDATE OF state ON automation_runs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION activity_record_run();
  CREATE FUNCTION activity_clear_resolved_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    DELETE FROM activity_items WHERE run_id=NEW.run_id AND kind='run_attention'
      AND details_json->>'attention'='awaitingApproval'
      AND NOT EXISTS (SELECT 1 FROM automation_jobs WHERE run_id=NEW.run_id AND state='awaitingApproval');
    RETURN NEW;
  END $$;
  CREATE TRIGGER activity_job_approval_resolved AFTER UPDATE OF state ON automation_jobs FOR EACH ROW
    WHEN (OLD.state='awaitingApproval' AND NEW.state IS DISTINCT FROM OLD.state)
    EXECUTE FUNCTION activity_clear_resolved_approval();
  -- Existing installations may already contain cancelled or resolved requests.
  DELETE FROM activity_items i USING automation_runs r WHERE i.run_id=r.id AND (
    r.state='cancelled' OR ((r.state IN ('waiting','running') OR i.details_json->>'attention'='awaitingApproval')
      AND NOT EXISTS (SELECT 1 FROM automation_jobs j WHERE j.run_id=r.id AND j.state='awaitingApproval'))
  );`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER activity_job_approval_resolved ON automation_jobs;
  DROP FUNCTION activity_clear_resolved_approval();
  CREATE OR REPLACE FUNCTION activity_record_run() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE activity_kind text; current_run automation_runs%ROWTYPE; BEGIN
    SELECT * INTO current_run FROM automation_runs WHERE id=NEW.id;
    IF NOT FOUND OR current_run.state NOT IN ('completed','partial','failed','blocked','review') THEN RETURN NEW; END IF;
    IF current_run.explanation_json->>'manualSelection'='true' OR
      (current_run.kind <> 'manual' AND NOT EXISTS (SELECT 1 FROM automation_rule_revisions v WHERE v.id=current_run.rule_revision_id
        AND jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)) THEN RETURN NEW; END IF;
    activity_kind := CASE current_run.state WHEN 'completed' THEN 'run_completed' WHEN 'partial' THEN 'run_partial'
      WHEN 'review' THEN 'run_attention' ELSE 'run_failed' END;
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      VALUES(gen_random_uuid()::text,current_run.owner_id,activity_kind,'run:'||current_run.id,current_run.id,current_run.explanation_json->>'collectionId',
        (SELECT count(*) FROM automation_run_outputs WHERE run_id=current_run.id),
        jsonb_build_object('status',current_run.state,'attention',CASE WHEN current_run.state='review' THEN 'review' END))
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=CASE
        WHEN activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.details_json->>'status' IS DISTINCT FROM current_run.state
        THEN NULL ELSE activity_items.read_at END
      WHERE activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.count IS DISTINCT FROM EXCLUDED.count
        OR activity_items.details_json IS DISTINCT FROM EXCLUDED.details_json;
    RETURN NEW;
  END $$;
  CREATE OR REPLACE FUNCTION activity_record_job_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      SELECT gen_random_uuid()::text,r.owner_id,'run_attention','run:'||r.id,r.id,r.explanation_json->>'collectionId',
        (SELECT count(*) FROM automation_run_outputs WHERE run_id=r.id),jsonb_build_object('status',r.state,'attention','awaitingApproval')
      FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id WHERE r.id=NEW.run_id
        AND r.explanation_json->>'manualSelection' IS DISTINCT FROM 'true'
        AND (r.kind='manual' OR jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=NULL;
    RETURN NEW;
  END $$;
  DROP TRIGGER activity_run ON automation_runs;
  CREATE CONSTRAINT TRIGGER activity_run AFTER INSERT OR UPDATE OF state ON automation_runs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    WHEN (NEW.state IN ('completed','partial','failed','blocked','review')) EXECUTE FUNCTION activity_record_run();`.execute(db);
}
