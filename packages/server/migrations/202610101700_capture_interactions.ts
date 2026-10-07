import { sql, type Kysely, type Migration } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE bookmark_capture_decisions ADD COLUMN current_result_json jsonb`.execute(db);
  await sql`CREATE TABLE bookmark_capture_edits (
    account_id text NOT NULL REFERENCES accounts(id), command_id text NOT NULL,
    decision_id text NOT NULL REFERENCES bookmark_capture_decisions(id), fingerprint text NOT NULL,
    result_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(account_id, command_id)
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE bookmark_capture_edits`.execute(db);
  await sql`ALTER TABLE bookmark_capture_decisions DROP COLUMN current_result_json`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
