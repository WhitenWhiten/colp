import { sql, type Kysely } from 'kysely';

/** Every new approval transition is actionable, even when the run's summary is unchanged. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION activity_record_job_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
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
    DROP TRIGGER activity_job_approval ON automation_jobs;
    CREATE TRIGGER activity_job_approval AFTER UPDATE OF state ON automation_jobs FOR EACH ROW
      WHEN (NEW.state='awaitingApproval' AND OLD.state IS DISTINCT FROM NEW.state)
      EXECUTE FUNCTION activity_record_job_approval();`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION activity_record_job_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      SELECT gen_random_uuid()::text,r.owner_id,'run_attention','run:'||r.id,r.id,r.explanation_json->>'collectionId',
        (SELECT count(*) FROM automation_run_outputs WHERE run_id=r.id),jsonb_build_object('status',r.state,'attention','awaitingApproval')
      FROM automation_runs r JOIN automation_rule_revisions v ON v.id=r.rule_revision_id WHERE r.id=NEW.run_id
        AND r.explanation_json->>'manualSelection' IS DISTINCT FROM 'true'
        AND (r.kind='manual' OR jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=CASE
        WHEN activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.details_json IS DISTINCT FROM EXCLUDED.details_json
        THEN NULL ELSE activity_items.read_at END;
    RETURN NEW;
  END $$;
    DROP TRIGGER activity_job_approval ON automation_jobs;
    CREATE TRIGGER activity_job_approval AFTER UPDATE OF state ON automation_jobs FOR EACH ROW
      WHEN (NEW.state='awaitingApproval') EXECUTE FUNCTION activity_record_job_approval();`.execute(db);
}
