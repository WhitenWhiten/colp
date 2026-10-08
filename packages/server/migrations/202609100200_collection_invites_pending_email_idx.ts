import { sql, type Kysely, type Migration } from 'kysely';

/**
 * P-06 expand-only index for global pending-invitee lookups
 * (`countPendingInvitesForInvitee` / invitee cap). Symmetric to
 * `collection_invites_subject_pending_idx`. N-1 binaries ignore it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX collection_invites_pending_email_idx
      ON collection_invites (email_normalized)
      WHERE status = 'pending'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collection_invites_pending_email_idx`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
