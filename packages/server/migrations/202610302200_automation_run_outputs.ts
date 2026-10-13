import { sql,type Kysely } from 'kysely';
export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`CREATE TABLE automation_run_outputs (
    id text PRIMARY KEY,result_id text NOT NULL REFERENCES automation_results(id) ON DELETE CASCADE,
    run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,job_id text NOT NULL UNIQUE REFERENCES automation_jobs(id) ON DELETE CASCADE,
    target_id text NOT NULL REFERENCES automation_targets(id),output_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );CREATE INDEX automation_run_output_page ON automation_run_outputs(run_id,created_at,id);
  CREATE FUNCTION automation_output_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM id FROM automation_runs WHERE id=NEW.run_id FOR UPDATE;
    NEW.created_at := greatest(NEW.created_at,(SELECT max(created_at)+interval '1 microsecond' FROM automation_run_outputs WHERE run_id=NEW.run_id));
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_output_order BEFORE INSERT ON automation_run_outputs FOR EACH ROW EXECUTE FUNCTION automation_output_order();
  CREATE TRIGGER automation_output_immutable BEFORE UPDATE ON automation_run_outputs FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable();
  CREATE TABLE automation_run_reads (
    owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    through_created_at timestamptz NOT NULL,through_output_id text NOT NULL,PRIMARY KEY(owner_id,run_id)
  );
  CREATE FUNCTION automation_accept_run_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='accepted' AND NEW.output_json->>'kind'='text' AND NEW.output_json->>'textType' IN ('digest','review') THEN
      INSERT INTO automation_run_outputs(id,result_id,run_id,job_id,target_id,output_json)
        SELECT gen_random_uuid()::text,NEW.id,j.run_id,j.id,j.target_id,NEW.output_json FROM automation_jobs j WHERE j.id=NEW.job_id
        ON CONFLICT(job_id) DO NOTHING;
      IF FOUND THEN UPDATE automation_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE id=(SELECT run_id FROM automation_jobs WHERE id=NEW.job_id);END IF;
    END IF; RETURN NEW;
  END $$;
  CREATE TRIGGER automation_result_run_output AFTER INSERT OR UPDATE OF status ON automation_results FOR EACH ROW EXECUTE FUNCTION automation_accept_run_output();
  INSERT INTO automation_run_outputs(id,result_id,run_id,job_id,target_id,output_json,created_at)
    SELECT gen_random_uuid()::text,a.id,j.run_id,j.id,j.target_id,a.output_json,a.created_at FROM automation_results a JOIN automation_jobs j ON j.id=a.job_id
    WHERE a.status='accepted' AND a.output_json->>'kind'='text' AND a.output_json->>'textType' IN ('digest','review') ON CONFLICT DO NOTHING;`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{
  await sql`DROP TRIGGER automation_result_run_output ON automation_results;DROP FUNCTION automation_accept_run_output();DROP TABLE automation_run_reads,automation_run_outputs;DROP FUNCTION automation_output_order()`.execute(db);
}
