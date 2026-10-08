import { sql, type Kysely } from 'kysely';

/**
 * E5: one-way client revocation. The MCP verifier's isRevoked check treats a
 * matching client digest as revoked without bumping the global epoch, so
 * disconnecting one agent does not retire the owner's other clients.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE mcp_oauth_client_revocations (
      client_id_digest text PRIMARY KEY
        CHECK (length(client_id_digest) = 43),
      revoked_at timestamptz NOT NULL DEFAULT current_timestamp
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mcp_oauth_client_revocations`.execute(db);
}
