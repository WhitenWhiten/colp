import { sql, type Kysely, type Migration } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE bookmark_capture_decisions (
    id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    owner_subject_id text NOT NULL, capture_id text NOT NULL, collection_id text NOT NULL,
    node_id text NOT NULL, command_id text NOT NULL, fingerprint text NOT NULL, input_json jsonb NOT NULL,
    original_parent_id text NOT NULL, original_tags jsonb NOT NULL,
    execution_command_id text NOT NULL, execution_id text, apply_command_id text,
    status text NOT NULL CHECK (status IN ('waiting', 'running', 'suggested', 'applied', 'manual')),
    reason text, revision integer NOT NULL DEFAULT 0, suggestion_json jsonb, result_json jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), applied_at timestamptz,
    undo_command_id text, undo_result_json jsonb, undone_at timestamptz,
    UNIQUE(account_id, capture_id), UNIQUE(account_id, command_id), UNIQUE(account_id, apply_command_id)
  )`.execute(db);
  await sql`CREATE INDEX bookmark_capture_history ON bookmark_capture_decisions(account_id, created_at DESC, id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE bookmark_capture_decisions`.execute(db);
}
export const migration: Migration = { up, down };
export default migration;
