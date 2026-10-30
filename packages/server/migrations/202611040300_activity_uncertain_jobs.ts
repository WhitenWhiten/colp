import { sql, type Kysely } from 'kysely';

// Keep active run attention aligned with durable jobs without replaying unknown work.
const runTrigger = (active: string) => sql.raw(`CREATE OR REPLACE FUNCTION activity_record_run() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE activity_kind text; current_run automation_runs%ROWTYPE; BEGIN
    SELECT * INTO current_run FROM automation_runs WHERE id=NEW.id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF current_run.state NOT IN ('completed','partial','failed','blocked','review') THEN
${active}
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
`);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION activity_reconcile_uncertain_run(wanted_run_id text) RETURNS void LANGUAGE plpgsql AS $$
  DECLARE current_run automation_runs%ROWTYPE; BEGIN
    SELECT * INTO current_run FROM automation_runs WHERE id=wanted_run_id;
    IF NOT FOUND OR current_run.state NOT IN ('waiting','running') THEN RETURN; END IF;
    IF EXISTS(SELECT 1 FROM automation_jobs WHERE run_id=wanted_run_id AND state='awaitingApproval') THEN RETURN; END IF;
    IF NOT EXISTS(SELECT 1 FROM automation_jobs WHERE run_id=wanted_run_id AND state='uncertain') THEN
      DELETE FROM activity_items WHERE run_id=wanted_run_id;
      RETURN;
    END IF;
    IF current_run.explanation_json->>'manualSelection'='true' OR
      (current_run.kind <> 'manual' AND NOT EXISTS(SELECT 1 FROM automation_rule_revisions v WHERE v.id=current_run.rule_revision_id
        AND jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)) THEN RETURN; END IF;
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      VALUES(gen_random_uuid()::text,current_run.owner_id,'run_attention','run:'||current_run.id,current_run.id,
        current_run.explanation_json->>'collectionId',(SELECT count(*) FROM automation_run_outputs WHERE run_id=current_run.id),
        '{"status":"uncertain","attention":"review"}'::jsonb)
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=NULL
      WHERE activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.count IS DISTINCT FROM EXCLUDED.count
        OR activity_items.details_json IS DISTINCT FROM EXCLUDED.details_json;
  END $$;
  CREATE FUNCTION activity_uncertain_job_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM activity_reconcile_uncertain_run(NEW.run_id); RETURN NEW;
  END $$;
  CREATE CONSTRAINT TRIGGER activity_job_uncertain AFTER INSERT OR UPDATE OF state ON automation_jobs
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION activity_uncertain_job_changed();`.execute(db);
  await runTrigger(`      IF current_run.state='cancelled' THEN DELETE FROM activity_items WHERE run_id=current_run.id;
      ELSE PERFORM activity_reconcile_uncertain_run(current_run.id); END IF;`).execute(db);
  await sql`SELECT activity_reconcile_uncertain_run(r.id) FROM automation_runs r
    WHERE r.state IN ('waiting','running') AND EXISTS(SELECT 1 FROM automation_jobs j WHERE j.run_id=r.id AND j.state='uncertain')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runTrigger(`      IF current_run.state='cancelled' OR NOT EXISTS (
        SELECT 1 FROM automation_jobs WHERE run_id=current_run.id AND state='awaitingApproval'
      ) THEN DELETE FROM activity_items WHERE run_id=current_run.id; END IF;
`).execute(db);
  await sql`DROP TRIGGER activity_job_uncertain ON automation_jobs;
    DROP FUNCTION activity_uncertain_job_changed(); DROP FUNCTION activity_reconcile_uncertain_run(text);
    DELETE FROM activity_items WHERE kind='run_attention' AND details_json->>'status'='uncertain'`.execute(db);
}
