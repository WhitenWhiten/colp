import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_proposals (
    job_id text PRIMARY KEY REFERENCES automation_jobs(id) ON DELETE CASCADE,
    result_id text NOT NULL UNIQUE REFERENCES automation_results(id),
    plan_id text NOT NULL UNIQUE, command_id text NOT NULL UNIQUE,
    binding_json jsonb NOT NULL, operations_json jsonb NOT NULL,
    base_revisions_json jsonb NOT NULL, allow_automatic_writes boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  ); ALTER TABLE automation_effect_receipts ADD COLUMN version_id text;`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_effect_receipts DROP COLUMN version_id; DROP TABLE automation_proposals`.execute(db);
}
