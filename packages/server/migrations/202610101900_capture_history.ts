import { sql, type Kysely, type Migration } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bookmark_capture_decisions ADD COLUMN original_url text`.execute(db);
  await sql`CREATE TABLE bookmark_capture_tasks (
    account_id text NOT NULL REFERENCES accounts(id), capture_id text NOT NULL, collection_id text NOT NULL,
    device_id text NOT NULL, revision integer NOT NULL, started_at timestamptz NOT NULL,
    report_json jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(account_id, capture_id)
  )`.execute(db);
  await sql`CREATE INDEX capture_task_history ON bookmark_capture_tasks(account_id, started_at DESC, capture_id DESC)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE bookmark_capture_tasks`.execute(db);
  await sql`ALTER TABLE bookmark_capture_decisions DROP COLUMN original_url`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
