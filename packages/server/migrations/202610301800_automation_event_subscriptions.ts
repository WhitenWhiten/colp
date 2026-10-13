import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE automation_event_subscriptions (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    target_id text NOT NULL, profile_id text NOT NULL, identity_digest text NOT NULL UNIQUE,
    callback_url text NOT NULL, secret_ciphertext text, previous_secret_ciphertext text,
    previous_secret_until timestamptz, generation bigint NOT NULL DEFAULT 1,
    profile_revision bigint NOT NULL, pairing_generation bigint NOT NULL,
    state text NOT NULL CHECK(state IN ('verifying','active','revoked','expired','revalidation')),
    refresh_before timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(owner_id,target_id) REFERENCES automation_targets(owner_id,id),
    FOREIGN KEY(owner_id,profile_id) REFERENCES automation_connection_profiles(owner_id,id)
  ); CREATE INDEX automation_subscription_target ON automation_event_subscriptions(owner_id,target_id,state,refresh_before);`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE automation_event_subscriptions`.execute(db);
}
