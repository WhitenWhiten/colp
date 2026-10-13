import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_event_subscriptions
    ADD COLUMN verification_generation bigint NOT NULL DEFAULT 0,
    ADD COLUMN verification_refresh_before timestamptz`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_event_subscriptions DROP COLUMN verification_generation,
    DROP COLUMN verification_refresh_before`.execute(db);
}
