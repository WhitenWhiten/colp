import { sql, type Kysely, type Migration } from 'kysely';

/** P3-38: Sync tombstone eligibility is deployment-configured; the default remains 30 days. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_node_tombstones
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_check,
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_purge_after_check,
    ADD CONSTRAINT sync_node_tombstones_purge_after_check
      CHECK (purge_after >= deleted_at)`.execute(db);
}

/** Developer-only rollback; restore the original protocol minimum before re-enabling the old writer. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_node_tombstones
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_check,
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_purge_after_check,
    ADD CONSTRAINT sync_node_tombstones_purge_after_check
      CHECK (purge_after >= deleted_at + interval '30 days')`.execute(db);
}

export const migration: Migration = { up, down };
