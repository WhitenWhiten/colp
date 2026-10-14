import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Null preserves unknown historical/external costs; zero is an explicit report.
  await sql`ALTER TABLE automation_job_attempts ADD COLUMN reported_cost_micros bigint
    CHECK(reported_cost_micros>=0)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_job_attempts DROP COLUMN reported_cost_micros`.execute(db);
}
