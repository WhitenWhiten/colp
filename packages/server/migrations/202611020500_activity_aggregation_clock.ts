import { sql, type Kysely } from 'kysely';

/** Source occurrence and first inbox delivery are distinct clocks during an outbox backlog. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE activity_items ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
    -- Preserve the window of existing aggregates rather than reopening expired ones on upgrade.
    UPDATE activity_items SET created_at=occurred_at;
    CREATE INDEX activity_agent_open_window ON activity_items(account_id,agent_client_id,collection_id,created_at)
      WHERE kind='agent_bookmarks_added' AND read_at IS NULL;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX activity_agent_open_window;
    ALTER TABLE activity_items DROP COLUMN created_at;`.execute(db);
}
