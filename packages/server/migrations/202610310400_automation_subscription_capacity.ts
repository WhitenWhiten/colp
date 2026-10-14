import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX automation_subscription_capacity ON automation_event_subscriptions(owner_id,refresh_before)
    WHERE state IN ('active','verifying')`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_subscription_capacity`.execute(db);
}
