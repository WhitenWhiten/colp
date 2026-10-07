/**
 * FIX-L-042: shared MCP OAuth revocation store and rotatable security epoch.
 *
 * Production OAuth surface must be able to fail a signed credential before
 * its `exp` (AS revocation or a local security event) and to retire every
 * credential issued before a security epoch bump. This module owns the port:
 * `revoke(target)` records a one-way identity digest row, `isRevoked(query)`
 * answers against revocation rows AND the current epoch boundary (tokens
 * issued before the epoch became effective are revoked), `securityEpoch()`
 * returns the rotatable epoch value for evidence, and `bumpSecurityEpoch()`
 * rotates it with a fresh effective time.
 *
 * The store never retains raw credentials or raw identity fields: every
 * stored/compared field is a SHA-256 digest of the verified value. Query
 * failures fail closed: implementations must throw instead of returning
 * `false`, and the OAuth verifier converts any thrown error into a `revoked`
 * verdict. Multi-instance consistency comes from the shared PostgreSQL store
 * (`createPostgresMcpOauthRevocationStore`); the in-memory store here is for
 * tests and single-process compositions only.
 */
import { createHash } from 'node:crypto';
import type { McpAccountSecurityBoundary } from './account-security-boundary.js';

/** Default security epoch seeded by the migration and used by the dev/test provider. */
export const MCP_OAUTH_DEFAULT_SECURITY_EPOCH = 'known.mcp.oauth.v1' as const;

/** Identity facts of one issued credential; raw values never enter storage. */
export interface McpOauthRevocationTarget {
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly credentialDigest: string;
}

/** Revocation query: the verified credential facts plus its signed `iat`. */
export interface McpOauthRevocationQuery extends McpOauthRevocationTarget {
  /** Signed token `iat` in epoch seconds; compared against the epoch boundary. */
  readonly issuedAtSeconds: number;
}

export interface McpOauthSecurityEpoch {
  readonly value: string;
  /** Time the epoch took effect; tokens issued before it are treated as revoked. */
  readonly effectiveAt: Date;
}

export interface McpOauthRevocationStore {
  /**
   * Records a revocation. Idempotent: revoking the same credential twice is a
   * no-op. Raw values are digested before any storage.
   */
  revoke(target: McpOauthRevocationTarget): Promise<void>;
  /**
   * True when the credential is revoked or was issued before the current
   * epoch boundary. Fail closed: implementations throw on query failure so
   * the verifier can never accept a credential it could not check.
   */
  isRevoked(query: McpOauthRevocationQuery): Promise<boolean>;
  /** Current rotatable security epoch value; throws when not provisioned. */
  securityEpoch(): Promise<string>;
  /**
   * Rotates the incident epoch. `effectiveAt` moves forward only; a bump must
   * not lower an existing floor.
   */
  bumpSecurityEpoch(epoch: string): Promise<McpOauthSecurityEpoch>;
  /**
   * Account row for the verifier's resolved account. Stores without this
   * method do not revoke external credentials.
   */
  readAccountSecurityBoundary?(
    accountId: string,
  ): Promise<McpAccountSecurityBoundary | null>;
}

/** One-way SHA-256 digest (base64url) of a revocation identity field. */
export function digestMcpOauthRevocationField(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('MCP OAuth revocation identity fields must be non-empty strings');
  }
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function revocationRowKey(target: McpOauthRevocationTarget): string {
  return [
    digestMcpOauthRevocationField(target.issuer),
    digestMcpOauthRevocationField(target.subject),
    digestMcpOauthRevocationField(target.clientId),
    digestMcpOauthRevocationField(target.tokenId),
    // credentialDigest is already the one-way SHA-256 digest of the verified
    // credential (computed by the OAuth verifier); it is stored as-is so the
    // row holds the digest of the verified value, never a nested digest.
    target.credentialDigest,
  ].join('\u0000');
}

export interface InMemoryMcpOauthRevocationStoreOptions {
  /** Injectable epoch-millisecond clock; defaults to new Date(). */
  readonly now?: () => Date;
  /** Initial epoch value; defaults to MCP_OAUTH_DEFAULT_SECURITY_EPOCH. */
  readonly securityEpoch?: string;
}

/**
 * Process-local revocation store for tests and single-instance compositions.
 * Shares the exact digest and epoch-boundary semantics of the PostgreSQL
 * store; never persists and never fails its own queries.
 */
export function createInMemoryMcpOauthRevocationStore(
  options: InMemoryMcpOauthRevocationStoreOptions = {},
): McpOauthRevocationStore {
  const now = options.now ?? (() => new Date());
  let epoch: McpOauthSecurityEpoch = Object.freeze({
    value: options.securityEpoch ?? MCP_OAUTH_DEFAULT_SECURITY_EPOCH,
    effectiveAt: now(),
  });
  const revokedRows = new Map<string, true>();

  return Object.freeze({
    async revoke(target: McpOauthRevocationTarget): Promise<void> {
      revokedRows.set(revocationRowKey(target), true);
    },
    async isRevoked(query: McpOauthRevocationQuery): Promise<boolean> {
      const effectiveAtSeconds = Math.floor(epoch.effectiveAt.getTime() / 1_000);
      return revokedRows.has(revocationRowKey(query)) || query.issuedAtSeconds < effectiveAtSeconds;
    },
    async securityEpoch(): Promise<string> {
      return epoch.value;
    },
    async bumpSecurityEpoch(value: string): Promise<McpOauthSecurityEpoch> {
      if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
        throw new TypeError('MCP OAuth security epoch must be a non-empty string of at most 128 characters');
      }
      const bumpedAt = now();
      const effectiveAt = bumpedAt.getTime() > epoch.effectiveAt.getTime()
        ? bumpedAt
        : epoch.effectiveAt;
      epoch = Object.freeze({ value, effectiveAt });
      return epoch;
    },
  });
}
