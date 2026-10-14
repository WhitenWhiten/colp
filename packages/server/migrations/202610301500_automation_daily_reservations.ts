import { sql,type Kysely } from 'kysely';

/** A retry on another UTC day must compete for that day's optional-work capacity. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_usage_reservations DROP CONSTRAINT automation_usage_reservations_pkey,
    ADD PRIMARY KEY(job_id,day)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  // Never silently discard historical day reservations during rollback.
  await sql`ALTER TABLE automation_usage_reservations DROP CONSTRAINT automation_usage_reservations_pkey,
    ADD PRIMARY KEY(job_id)`.execute(db);
}
