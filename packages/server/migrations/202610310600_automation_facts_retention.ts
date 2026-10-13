import { sql, type Kysely } from 'kysely';
/** Anti-join indexes for the bounded facts retention sweep (retention-worker.ts). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX automation_admission_source ON automation_admission_receipts(source_event_id);
    CREATE INDEX automation_batch_member_source ON automation_batch_members(source_event_id);
    CREATE INDEX automation_effect_operation ON automation_effect_receipts(operation_id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_effect_operation; DROP INDEX automation_batch_member_source;
    DROP INDEX automation_admission_source`.execute(db);
}
