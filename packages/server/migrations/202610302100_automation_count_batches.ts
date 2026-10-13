import { sql,type Kysely } from 'kysely';
export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`CREATE TABLE automation_batch_members (
    rule_revision_id text NOT NULL REFERENCES automation_rule_revisions(id),epoch bigint NOT NULL,partition_key text NOT NULL,
    distinct_key text NOT NULL,source_event_id text NOT NULL REFERENCES automation_event_facts(source_event_id),
    member_json jsonb NOT NULL,run_id text REFERENCES automation_runs(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(rule_revision_id,epoch,partition_key,distinct_key),UNIQUE(rule_revision_id,epoch,partition_key,source_event_id)
  );
  CREATE INDEX automation_batch_members_run ON automation_batch_members(run_id);
  CREATE FUNCTION automation_batch_member_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (to_jsonb(NEW)-'run_id') IS DISTINCT FROM (to_jsonb(OLD)-'run_id') OR OLD.run_id IS NOT NULL THEN
      RAISE EXCEPTION 'Batch membership is immutable'; END IF; RETURN NEW;
  END $$;
  CREATE TRIGGER automation_batch_member_immutable BEFORE UPDATE ON automation_batch_members FOR EACH ROW EXECUTE FUNCTION automation_batch_member_immutable();
  ALTER TABLE automation_jobs ADD COLUMN member_revisions_json jsonb NOT NULL DEFAULT '{}';`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{
  await sql`ALTER TABLE automation_jobs DROP COLUMN member_revisions_json;DROP TABLE automation_batch_members;DROP FUNCTION automation_batch_member_immutable()`.execute(db);
}
