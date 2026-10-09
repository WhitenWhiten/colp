import { sql, type Kysely, type Migration } from 'kysely';

/**
 * E5: revoke a consenting user's bearer without revoking the registration
 * owner's credentials. `mcp_oauth_client_revocations` is intentionally
 * client-wide, so consent removal needs a subject-scoped companion table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE mcp_oauth_subject_revocations (
      client_id_digest text NOT NULL
        CHECK (length(client_id_digest) = 43),
      subject_digest text NOT NULL
        CHECK (length(subject_digest) = 43),
      revoked_at timestamptz NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (client_id_digest, subject_digest)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mcp_oauth_subject_revocations`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
