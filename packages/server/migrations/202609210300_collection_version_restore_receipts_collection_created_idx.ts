import { sql, type Kysely, type Migration } from 'kysely';

/**
 * ADR-0021 expand-only: FIFO trim of collection_version_restore_receipts is
 * per collection_id by created_at. N-1 binaries ignore the index. No RLS.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX collection_version_restore_receipts_collection_created_idx
      ON collection_version_restore_receipts (collection_id, created_at)
  `.execute(db);
}

/** Developer-only rollback; drain restore-receipt writers first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collection_version_restore_receipts_collection_created_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
