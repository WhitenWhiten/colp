import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-L-034 (SYNC-R18 Partial): restores the protocol-mandated thirty-day
 * tombstone retention floor that 202607310100_sync_tombstone_retention_config
 * removed. The CHECK is added NOT VALID so deployments that previously ran a
 * shorter configured retention keep their existing rows (this migration never
 * purges or rewrites them); the floor binds every new insert from the moment
 * the migration applies, and the deployment configuration rejects values below
 * 2592000 seconds before the writer can produce a new short tombstone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_node_tombstones
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_check,
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_purge_after_check,
    ADD CONSTRAINT sync_node_tombstones_purge_after_check
      CHECK (purge_after >= deleted_at + interval '30 days') NOT VALID`.execute(db);
}

/** Developer-only rollback; restore the deployment-configured (weak) guard. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_node_tombstones
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_check,
    DROP CONSTRAINT IF EXISTS sync_node_tombstones_purge_after_check,
    ADD CONSTRAINT sync_node_tombstones_purge_after_check
      CHECK (purge_after >= deleted_at)`.execute(db);
}

export const migration: Migration = { up, down };
