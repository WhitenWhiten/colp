import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE automation_effect_receipts ADD COLUMN collection_id text REFERENCES collections(id),
    ADD COLUMN node_id text, ADD COLUMN after_parent_id text, ADD COLUMN after_content_revision text,
    ADD COLUMN undone_operation_id text REFERENCES operations(operation_id), ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
    CREATE INDEX automation_effect_node_history ON automation_effect_receipts(collection_id,node_id,created_at DESC,id DESC)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX automation_effect_node_history; ALTER TABLE automation_effect_receipts DROP COLUMN collection_id,
    DROP COLUMN node_id, DROP COLUMN after_parent_id, DROP COLUMN after_content_revision, DROP COLUMN undone_operation_id,
    DROP COLUMN created_at`.execute(db);
}
