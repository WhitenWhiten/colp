import { sql, type Kysely, type Migration } from 'kysely';

/** P3-36: owner-scoped Product Conflict keyset and Replica status read paths. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX sync_conflicts_replica_open_product_idx
    ON sync_conflicts (replica_id, created_at DESC, conflict_id DESC)
    WHERE status = 'open'`.execute(db);
}

/** Developer-only destructive rollback; production uses forward-compatible expansion. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS sync_conflicts_replica_open_product_idx`.execute(db);
}

export const migration: Migration = { up, down };
