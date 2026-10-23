import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE activity_items (
    id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('agent_bookmarks_added','run_completed','run_partial','run_failed','run_attention')),
    source_key text NOT NULL, agent_client_id text, collection_id text REFERENCES collections(id) ON DELETE CASCADE,
    run_id text REFERENCES automation_runs(id) ON DELETE CASCADE,
    count integer NOT NULL DEFAULT 0 CHECK (count >= 0), details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), read_at timestamptz, UNIQUE(account_id,source_key)
  );
  CREATE INDEX activity_items_account_page ON activity_items(account_id,updated_at DESC,id DESC);
  CREATE INDEX activity_items_account_unread ON activity_items(account_id,updated_at DESC,id DESC) WHERE read_at IS NULL;
  CREATE INDEX activity_items_run ON activity_items(run_id) WHERE run_id IS NOT NULL;
  CREATE TABLE activity_members (
    source_event_id text PRIMARY KEY, activity_id text NOT NULL REFERENCES activity_items(id) ON DELETE CASCADE,
    collection_id text NOT NULL, node_id text NOT NULL, parent_id text, operation_id text NOT NULL, occurred_at timestamptz NOT NULL
  );
  CREATE INDEX activity_members_activity ON activity_members(activity_id,occurred_at DESC);
  CREATE FUNCTION activity_record_run() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE activity_kind text; BEGIN
    IF NEW.explanation_json->>'manualSelection'='true' OR
      (NEW.kind <> 'manual' AND NOT EXISTS (SELECT 1 FROM automation_rule_revisions v WHERE v.id=NEW.rule_revision_id
        AND jsonb_array_length(coalesce(v.definition_json->'tasks','[]'::jsonb))>0)) THEN RETURN NEW; END IF;
    activity_kind := CASE NEW.state WHEN 'completed' THEN 'run_completed' WHEN 'partial' THEN 'run_partial'
      WHEN 'review' THEN 'run_attention' ELSE 'run_failed' END;
    INSERT INTO activity_items(id,account_id,kind,source_key,run_id,collection_id,count,details_json)
      VALUES(gen_random_uuid()::text,NEW.owner_id,activity_kind,'run:'||NEW.id,NEW.id,NEW.explanation_json->>'collectionId',
        (SELECT count(*) FROM automation_run_outputs WHERE run_id=NEW.id),
        jsonb_build_object('status',NEW.state,'attention',CASE WHEN NEW.state='review' THEN 'review' END))
    ON CONFLICT(account_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,count=EXCLUDED.count,details_json=EXCLUDED.details_json,
      revision=activity_items.revision+1,updated_at=clock_timestamp(),read_at=CASE
        WHEN activity_items.kind IS DISTINCT FROM EXCLUDED.kind OR activity_items.details_json->>'status' IS DISTINCT FROM NEW.state
        THEN NULL ELSE activity_items.read_at END;
    RETURN NEW;
  END $$;
  CREATE TRIGGER activity_run AFTER INSERT OR UPDATE OF state ON automation_runs FOR EACH ROW
    WHEN (NEW.state IN ('completed','partial','failed','blocked','review')) EXECUTE FUNCTION activity_record_run();
  CREATE FUNCTION activity_record_job_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
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
  CREATE TRIGGER activity_job_approval AFTER UPDATE OF state ON automation_jobs FOR EACH ROW
    WHEN (NEW.state='awaitingApproval') EXECUTE FUNCTION activity_record_job_approval();`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER activity_job_approval ON automation_jobs; DROP FUNCTION activity_record_job_approval();
    DROP TRIGGER activity_run ON automation_runs; DROP FUNCTION activity_record_run(); DROP TABLE activity_members,activity_items;`.execute(db);
}
