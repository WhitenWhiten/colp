import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE activity_items DROP CONSTRAINT activity_items_kind_check,
    ADD CONSTRAINT activity_items_kind_check CHECK (kind IN ('agent_bookmarks_added','agent_nodes_updated',
      'agent_nodes_moved','agent_nodes_deleted','run_completed','run_partial','run_failed','run_attention','approval_requested'));`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM activity_items WHERE kind IN ('agent_nodes_updated','agent_nodes_moved','agent_nodes_deleted');
    ALTER TABLE activity_items DROP CONSTRAINT activity_items_kind_check,
    ADD CONSTRAINT activity_items_kind_check CHECK (kind IN ('agent_bookmarks_added','run_completed','run_partial',
      'run_failed','run_attention','approval_requested'));`.execute(db);
}
