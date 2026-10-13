import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE UNIQUE INDEX automation_facts_operation ON automation_event_facts(operation_id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_facts_operation`.execute(db);
}
