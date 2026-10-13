import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs ADD COLUMN reason_code text;
    UPDATE automation_jobs SET reason_code='predecessor_failed'
    WHERE state='blocked' AND input_json IS NULL
      AND explanation='A predecessor did not succeed; no automatic retry or fallback.'`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_jobs DROP COLUMN reason_code`.execute(db);
}
