/**
 * FIX-L-042: PostgreSQL-backed shared MCP OAuth revocation store.
 *
 * Production API replicas are separate processes, so revocation facts and the
 * security epoch must live in the shared database: every instance answers the
 * same revocation rows and the same epoch boundary. The schema
 * (`mcp_oauth_revocations`, `mcp_oauth_security_epoch`) is created by
 * `202609010100_mcp_oauth_revocation_store`; this adapter only ever reads and
 * writes one-way SHA-256 digests of issuer/subject/client/jti/credential and
 * never the raw token or raw identity values.
 *
 * Fail closed: any query that cannot prove the credential is not revoked (DB
 * error, missing epoch row) throws; the OAuth verifier converts every thrown
 * error into a `revoked` verdict, so an outage can never widen access.
 */
import { sql, type Kysely } from 'kysely';
import {
  digestMcpOauthRevocationField,
  type McpAccountSecurityBoundary,
  type McpOauthRevocationQuery,
  type McpOauthRevocationStore,
  type McpOauthRevocationTarget,
  type McpOauthSecurityEpoch,
} from '../../modules/mcp/index.js';
import type { DatabaseSchema } from './runtime.js';

export interface PostgresMcpOauthRevocationStoreOptions {
  readonly db: Kysely<DatabaseSchema>;
}

export function createPostgresMcpOauthRevocationStore(
  options: PostgresMcpOauthRevocationStoreOptions,
): McpOauthRevocationStore {
  if (typeof options !== 'object' || options === null || options.db === undefined) {
    throw new TypeError('PostgreSQL MCP OAuth revocation store requires a database handle.');
  }
  const db = options.db;

  return Object.freeze({
    async revoke(target: McpOauthRevocationTarget): Promise<void> {
      const issuerDigest = digestMcpOauthRevocationField(target.issuer);
      const subjectDigest = digestMcpOauthRevocationField(target.subject);
      const clientIdDigest = digestMcpOauthRevocationField(target.clientId);
      const tokenIdDigest = digestMcpOauthRevocationField(target.tokenId);
      // credentialDigest is already the one-way SHA-256 digest of the verified
      // credential (computed by the OAuth verifier); store it as-is so the row
      // holds the digest of the verified value, never a nested digest.
      const credentialDigest = target.credentialDigest;
      await sql`
        INSERT INTO mcp_oauth_revocations (
          issuer_digest, subject_digest, client_id_digest, token_id_digest,
          credential_digest, revoked_at
        ) VALUES (
          ${issuerDigest}, ${subjectDigest}, ${clientIdDigest},
          ${tokenIdDigest}, ${credentialDigest}, current_timestamp
        )
        ON CONFLICT DO NOTHING
      `.execute(db);
    },

    async revokeClient(clientId: string): Promise<void> {
      const clientIdDigest = digestMcpOauthRevocationField(clientId);
      await sql`
        INSERT INTO mcp_oauth_client_revocations (client_id_digest, revoked_at)
        VALUES (${clientIdDigest}, current_timestamp)
        ON CONFLICT (client_id_digest) DO NOTHING
      `.execute(db);
    },

    async isRevoked(query: McpOauthRevocationQuery): Promise<boolean> {
      const issuerDigest = digestMcpOauthRevocationField(query.issuer);
      const subjectDigest = digestMcpOauthRevocationField(query.subject);
      const clientIdDigest = digestMcpOauthRevocationField(query.clientId);
      const tokenIdDigest = digestMcpOauthRevocationField(query.tokenId);
      // credentialDigest is already the one-way SHA-256 digest of the verified
      // credential (computed by the OAuth verifier); compare it as-is.
      const credentialDigest = query.credentialDigest;
      const result = await sql<{
        readonly revoked: boolean;
        readonly epoch_present: boolean;
        readonly effective_at: Date | null;
        readonly epoch: string | null;
      }>`
        SELECT
          (
            EXISTS (
              SELECT 1 FROM mcp_oauth_revocations
              WHERE issuer_digest = ${issuerDigest}
                AND subject_digest = ${subjectDigest}
                AND client_id_digest = ${clientIdDigest}
                AND token_id_digest = ${tokenIdDigest}
                AND credential_digest = ${credentialDigest}
            )
            OR EXISTS (
              SELECT 1 FROM mcp_oauth_client_revocations
              WHERE client_id_digest = ${clientIdDigest}
            )
            OR EXISTS (
              SELECT 1 FROM mcp_oauth_subject_revocations
              WHERE client_id_digest = ${clientIdDigest}
                AND subject_digest = ${subjectDigest}
            )
          ) AS revoked,
          EXISTS (SELECT 1 FROM mcp_oauth_security_epoch WHERE id = 1) AS epoch_present,
          (SELECT effective_at FROM mcp_oauth_security_epoch WHERE id = 1) AS effective_at,
          (SELECT epoch FROM mcp_oauth_security_epoch WHERE id = 1) AS epoch
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined || row.epoch_present !== true || !(row.effective_at instanceof Date)) {
        // Fail closed: without an authoritative epoch boundary the credential
        // cannot be proven acceptable.
        throw new Error('MCP OAuth security epoch is not provisioned');
      }
      const effectiveAtSeconds = Math.floor(row.effective_at.getTime() / 1_000);
      // Incident floor only. Reject equality as well: JWT iat has second
      // precision while the durable effective_at boundary has milliseconds.
      // Account events use readAccountSecurityBoundary on the resolved account.
      return row.revoked === true || (query.issuedSecurityEpoch === undefined
        ? query.issuedAtSeconds <= effectiveAtSeconds
        : query.issuedSecurityEpoch !== row.epoch || query.issuedAtSeconds < effectiveAtSeconds);
    },

    async readAccountSecurityBoundary(accountId: string): Promise<McpAccountSecurityBoundary | null> {
      if (typeof accountId !== 'string' || accountId.trim() === '') {
        throw new Error('MCP account security boundary requires an account id');
      }
      const result = await sql<{
        readonly status: string;
        readonly security_epoch: string | bigint;
        readonly security_epoch_bumped_at: Date | string | null;
      }>`
        SELECT status, security_epoch, security_epoch_bumped_at
        FROM accounts
        WHERE id = ${accountId}
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) return null;
      const bumpedAt = row.security_epoch_bumped_at;
      return {
        status: row.status,
        securityEpoch: BigInt(row.security_epoch).toString(10),
        bumpedAt: bumpedAt instanceof Date ? bumpedAt : bumpedAt === null ? null : new Date(bumpedAt),
      };
    },

    async securityEpoch(): Promise<string> {
      const result = await sql<{ readonly epoch: string | null }>`
        SELECT epoch FROM mcp_oauth_security_epoch WHERE id = 1
      `.execute(db);
      const epoch = result.rows[0]?.epoch;
      if (typeof epoch !== 'string' || epoch.trim() === '') {
        throw new Error('MCP OAuth security epoch is not provisioned');
      }
      return epoch;
    },

    async bumpSecurityEpoch(value: string): Promise<McpOauthSecurityEpoch> {
      if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
        throw new TypeError('MCP OAuth security epoch must be a non-empty string of at most 128 characters');
      }
      const result = await sql<{ readonly epoch: string; readonly effective_at: Date }>`
        INSERT INTO mcp_oauth_security_epoch (id, epoch, effective_at, updated_at)
        VALUES (1, ${value}, current_timestamp, current_timestamp)
        ON CONFLICT (id) DO UPDATE
          SET epoch = EXCLUDED.epoch,
              effective_at = GREATEST(mcp_oauth_security_epoch.effective_at, current_timestamp),
              updated_at = current_timestamp
        RETURNING epoch, effective_at
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined || !(row.effective_at instanceof Date)) {
        throw new Error('MCP OAuth security epoch bump failed');
      }
      return Object.freeze({ value: row.epoch, effectiveAt: row.effective_at });
    },
  });
}
