import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_task_completions (
    job_id text PRIMARY KEY REFERENCES automation_jobs(id) ON DELETE CASCADE,
    id text NOT NULL UNIQUE, digest text NOT NULL, output_json jsonb NOT NULL,
    proof_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE TRIGGER automation_task_completion_immutable BEFORE UPDATE ON automation_task_completions
    FOR EACH ROW EXECUTE FUNCTION automation_revision_immutable()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_task_completions`.execute(db);
}
