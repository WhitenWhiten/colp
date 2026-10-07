import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only keyset/order indexes for small hot paths from the 2026-08-27
 * backend performance audit (IDX-07). N-1 binaries ignore them.
 *
 * - collaboration member list orders by (granted_at, subject_id COLLATE "C")
 *   per collection; the (collection_id, subject_id) PK filters but cannot
 *   serve the sort.
 * - per-collection pending invite list orders by (created_at, id COLLATE "C");
 *   the pending-email unique index filters but cannot serve the sort.
 * - the OTP verification store resolves the newest row per identifier
 *   (ORDER BY "createdAt" DESC LIMIT 1); the single-column identifier index
 *   still sorts. The old auth_verifications_identifier_idx is dropped by
 *   202609260500_drop_redundant_indexes (T-09) as a prefix duplicate.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX collection_members_granted_idx
      ON collection_members (collection_id, granted_at, (subject_id COLLATE "C"))
  `.execute(db);
  await sql`
    CREATE INDEX collection_invites_pending_page_idx
      ON collection_invites (collection_id, created_at, (id COLLATE "C"))
      WHERE status = 'pending'
  `.execute(db);
  await sql`
    CREATE INDEX "auth_verifications_identifier_created_idx"
      ON "auth_verifications" ("identifier", "createdAt" DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "auth_verifications_identifier_created_idx"`.execute(db);
  await sql`DROP INDEX IF EXISTS collection_invites_pending_page_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS collection_members_granted_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
