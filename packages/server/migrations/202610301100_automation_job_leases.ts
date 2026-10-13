import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs
    ADD COLUMN revision bigint NOT NULL DEFAULT 1,
    ADD COLUMN task_json jsonb,
    ADD COLUMN input_json jsonb,
    ADD COLUMN input_revision text,
    ADD COLUMN authority_digest text,
    ADD COLUMN allowed_folders jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN delivery_handle text,
    ADD COLUMN max_calls integer NOT NULL DEFAULT 1 CHECK(max_calls BETWEEN 0 AND 100),
    ADD COLUMN explanation text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
    CREATE UNIQUE INDEX automation_job_handle ON automation_jobs(delivery_handle);
    ALTER TABLE automation_jobs DROP CONSTRAINT automation_jobs_state_check;
    ALTER TABLE automation_jobs ADD CONSTRAINT automation_jobs_state_check CHECK(state IN
      ('pending','ready','leased','committing','succeeded','awaitingApproval','uncertain','blocked','failed','stale','review','cancelled'));`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs DROP COLUMN revision,DROP COLUMN task_json,DROP COLUMN input_json,
    DROP COLUMN input_revision,DROP COLUMN authority_digest,DROP COLUMN allowed_folders,DROP COLUMN delivery_handle,
    DROP COLUMN max_calls,DROP COLUMN explanation,DROP COLUMN created_at`.execute(db);
}
