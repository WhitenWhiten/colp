import { sql,type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs ADD COLUMN execution_context_json jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN input_revisions_json jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN reused_result_id text REFERENCES automation_results(id);
    CREATE FUNCTION automation_job_pins_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (NEW.run_id,NEW.task_id,NEW.target_id,NEW.task_json,NEW.contract_id,NEW.execution_context_json)
        IS DISTINCT FROM (OLD.run_id,OLD.task_id,OLD.target_id,OLD.task_json,OLD.contract_id,OLD.execution_context_json)
        OR (OLD.input_json IS NOT NULL AND (NEW.input_json,NEW.input_digest,NEW.input_revision,NEW.authority_digest,NEW.allowed_folders,NEW.input_revisions_json)
          IS DISTINCT FROM (OLD.input_json,OLD.input_digest,OLD.input_revision,OLD.authority_digest,OLD.allowed_folders,OLD.input_revisions_json)) THEN
        RAISE EXCEPTION 'Automation job pins are immutable' USING ERRCODE='23514';
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER automation_job_pins_immutable BEFORE UPDATE ON automation_jobs FOR EACH ROW EXECUTE FUNCTION automation_job_pins_immutable();`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER automation_job_pins_immutable ON automation_jobs; DROP FUNCTION automation_job_pins_immutable();
    ALTER TABLE automation_jobs DROP COLUMN execution_context_json,DROP COLUMN input_revisions_json,DROP COLUMN reused_result_id`.execute(db);
}
