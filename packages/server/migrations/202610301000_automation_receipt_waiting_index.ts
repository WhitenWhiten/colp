import { sql, type Kysely } from 'kysely';

/** Bounded Owner receipt reclamation must not scan the retained receipt history. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX automation_intake_waiting_owner
    ON automation_intake_receipts(owner_id,id) WHERE state='waitingForSync'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_intake_waiting_owner`.execute(db);
}
