import { sql, type Kysely, type Migration } from 'kysely';

/**
 * R15 global evidence/proof maintenance index.
 *
 * The maintenance worker sweeps expired pull-cursor evidence across all replicas
 * with a candidate CTE ordered by cursor_expires_at. The existing scope tuple
 * index is lead by replica_id, so it cannot bound an expiry-first cleanup scan.
 * This expand migration adds a cleanup index lead by cursor_expires_at so the
 * worker's candidate scan stays bounded and the oldest-expired gauge is a pure
 * index-order probe.
 *
 * Kysely runs PostgreSQL migrations in one transaction, so CONCURRENTLY index
 * creation is not available (the table is append-maintained by Pull).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX sync_pull_cursor_evidence_cleanup_idx
    ON sync_pull_cursor_evidence(cursor_expires_at, replica_id)`.execute(db);
}

/**
 * R15 is a pure additive index: down drops only this index and must not touch
 * the evidence/proof tables or their retention triggers.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS sync_pull_cursor_evidence_cleanup_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
