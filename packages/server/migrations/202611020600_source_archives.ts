import { sql, type Kysely } from 'kysely';
/** Private source authority and durable results, never part of public node payloads. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE source_archive_accounts (
    account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    state_json jsonb NOT NULL CHECK(jsonb_typeof(state_json)='object'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> { await sql`DROP TABLE source_archive_accounts`.execute(db); }
