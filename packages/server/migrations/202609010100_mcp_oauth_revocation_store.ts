import { sql, type Kysely, type Migration } from 'kysely';
import { MCP_OAUTH_DEFAULT_SECURITY_EPOCH } from '../src/modules/mcp/oauth-revocation-store.js';

/**
 * FIX-L-042 expand: shared MCP OAuth revocation store and rotatable security
 * epoch.
 *
 * `mcp_oauth_revocations` holds only one-way SHA-256 digests
 * (issuer/subject/client/jti/credential) — never raw tokens or raw identity
 * values — plus the revocation timestamp. The unique index makes repeated
 * revocations idempotent (`ON CONFLICT DO NOTHING`).
 *
 * `mcp_oauth_security_epoch` is the singleton rotatable epoch: `epoch` feeds
 * token-free evidence/bindings, and `effective_at` is the boundary — every
 * token issued (`iat`) before it is treated as revoked, so a bump retires old
 * credentials on every replica that reads this table. The seed row uses the
 * default epoch so a fresh deployment is immediately consistent with the
 * dev/test provider value.
 *
 * Expand-only: both tables are new and never referenced by N-1 binaries, so
 * applying this migration cannot break a currently deployed reader.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE mcp_oauth_revocations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issuer_digest text NOT NULL,
    subject_digest text NOT NULL,
    client_id_digest text NOT NULL,
    token_id_digest text NOT NULL,
    credential_digest text NOT NULL,
    revoked_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT mcp_oauth_revocations_digest_length_check CHECK (
      length(issuer_digest) = 43
      AND length(subject_digest) = 43
      AND length(client_id_digest) = 43
      AND length(token_id_digest) = 43
      AND length(credential_digest) = 43
    )
  )`.execute(db);

  await sql`CREATE UNIQUE INDEX mcp_oauth_revocations_identity_uq
    ON mcp_oauth_revocations
      (issuer_digest, subject_digest, client_id_digest, token_id_digest, credential_digest)`.execute(db);

  await sql`CREATE TABLE mcp_oauth_security_epoch (
    id integer PRIMARY KEY DEFAULT 1
      CONSTRAINT mcp_oauth_security_epoch_singleton_check CHECK (id = 1),
    epoch text NOT NULL,
    effective_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`.execute(db);

  await sql`INSERT INTO mcp_oauth_security_epoch (id, epoch, effective_at, updated_at)
    VALUES (1, ${MCP_OAUTH_DEFAULT_SECURITY_EPOCH}, current_timestamp, current_timestamp)`.execute(db);
}

/** Developer-only rollback; both tables are new in this migration. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mcp_oauth_security_epoch`.execute(db);
  await sql`DROP TABLE IF EXISTS mcp_oauth_revocations`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
