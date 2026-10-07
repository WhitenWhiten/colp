import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Expand-only Collection Collaboration invite authority (SC-01).
 *
 * Adds `collection_invites` and the shared-list membership index used by SC-03.
 * Does not create `collection_invite_deliveries` (SC-04). N-1 binaries ignore
 * both objects. Application rollback leaves them installed. The `down` path
 * drops only this table and index and is developer-only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE collection_invites (
      id                      text PRIMARY KEY,
      collection_id           text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
      role                    text NOT NULL CHECK (role IN ('editor','viewer')),
      email_normalized        text NOT NULL CHECK (
                                char_length(email_normalized) BETWEEN 3 AND 254
                                AND email_normalized = lower(email_normalized)
                              ),
      invited_subject_id      text NULL,
      invited_by_subject_id   text NOT NULL,
      status                  text NOT NULL CHECK (
                                status IN ('pending','accepted','declined','revoked','expired')
                              ),
      expires_at              timestamptz NOT NULL,
      created_at              timestamptz NOT NULL DEFAULT now(),
      resolved_at             timestamptz NULL,
      accepted_subject_id     text NULL
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX collection_invites_pending_email_unique
      ON collection_invites (collection_id, email_normalized)
      WHERE status = 'pending'
  `.execute(db);
  await sql`
    CREATE INDEX collection_invites_subject_pending_idx
      ON collection_invites (invited_subject_id, expires_at)
      WHERE status = 'pending' AND invited_subject_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX collection_members_shared_list_idx
      ON collection_members (subject_id, collection_id)
      WHERE role IN ('editor', 'viewer')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS collection_members_shared_list_idx`.execute(db);
  await sql`DROP TABLE IF EXISTS collection_invites`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
