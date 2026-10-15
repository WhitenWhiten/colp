import { sql,type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs ADD COLUMN inputs_checked_at timestamptz;
    CREATE INDEX automation_ready_input_checks ON automation_jobs(inputs_checked_at NULLS FIRST,id) WHERE state='ready'`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_ready_input_checks; ALTER TABLE automation_jobs DROP COLUMN inputs_checked_at`.execute(db);
}
