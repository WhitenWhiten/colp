import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P-11 expand-only partial index for expired-lease claimDue recovery.
 * BitmapOr/Index Scan of due_idx ∪ leased_until_idx for claimDue; N-1 ignores it.
 * Keep collection_invite_deliveries_due_idx (expand-only; do not drop it).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX collection_invite_deliveries_leased_until_idx
      ON collection_invite_deliveries (leased_until)
      WHERE state = 'leased'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collection_invite_deliveries_leased_until_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
