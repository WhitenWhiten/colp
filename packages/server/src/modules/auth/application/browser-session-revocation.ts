/**
 * Session revocation helpers shared by `BrowserSessionAuthority` (A3).
 *
 * Logout must end the whole rotation lineage a cookie belongs to: a stale tab
 * can present a rotated-away predecessor, whose metadata row is already
 * revoked while the live successor still authenticates. `revokeLogoutLineage`
 * follows the successor links to the live leaf.
 * `revokeOtherSessionsKeepingCurrent` is the password/email-change path: one
 * committed epoch bump, every other browser/legacy session revoked, and the
 * requesting session realigned to that epoch.
 */
import type {
  BrowserSessionAuthorityPorts,
  BrowserSessionMetadataStore,
} from './ports.js';
import type { BrowserSessionRevokeAllResult } from './browser-session-authority.js';

/**
 * Record the product revoke fact for the cookie's lineage, then return the
 * successor cookie whose BA session must be revoked as well.
 *
 * A live session is revoked directly. When the presented metadata is already
 * revoked (rotated away), walk the predecessor links to the live leaf and
 * revoke it; otherwise a stale tab would end a session it no longer carries
 * while the real session stays signed in. Returns null when there is nothing
 * further to revoke (unknown cookie, or the lineage ends).
 */
export async function revokeLogoutLineage(input: {
  readonly store: BrowserSessionMetadataStore;
  readonly tokenHash: string;
  readonly now: Date;
}): Promise<string | null> {
  const metadata = await input.store.findByTokenHash(input.tokenHash);
  if (!metadata) return null;
  if (metadata.revokedAt === null) {
    await input.store.markRevoked(metadata.authSessionId, input.now);
    return null;
  }
  // A sleeping browser can miss several rotations; bounded like the bootstrap
  // successor resolution. Revoked leaves keep failing closed.
  const seen = new Set<string>();
  let predecessorId = metadata.authSessionId;
  for (;;) {
    if (seen.has(predecessorId) || seen.size >= 4096) return null;
    seen.add(predecessorId);
    const successor = await input.store.findByPredecessor(predecessorId);
    if (!successor) return null;
    if (successor.revokedAt === null) {
      await input.store.markRevoked(successor.authSessionId, input.now);
      const minted = await input.store.findSuccessorCookie(predecessorId);
      return minted?.rawCookieValue ?? null;
    }
    predecessorId = successor.authSessionId;
  }
}

/**
 * Password/email change: revoke every OTHER browser and legacy session of the
 * account while keeping `currentAuthSessionId` usable.
 *
 * `securityEpoch` is optional: callers that already committed a bump in their
 * own transaction (email change) pass it so the epoch is not raised twice;
 * callers without one raise it here first.
 */
export async function revokeOtherSessionsKeepingCurrent(
  ports: BrowserSessionAuthorityPorts,
  input: {
    readonly accountId: string;
    readonly currentAuthSessionId: string;
    readonly securityEpoch?: bigint;
  },
): Promise<BrowserSessionRevokeAllResult> {
  const now = await ports.clock.now();
  const securityEpoch = input.securityEpoch ?? await ports.accounts.bumpSecurityEpoch(input.accountId);
  await ports.revokeOAuthRefreshTokensForAccount(input.accountId);
  await ports.store.revokeOthersForAccount(input.accountId, input.currentAuthSessionId, now);
  await ports.store.alignMetadataEpoch(input.currentAuthSessionId, securityEpoch);
  const revokedAuthSessions = await ports.store.deleteAuthSessionsForAccountExcept(
    input.accountId,
    input.currentAuthSessionId,
  );
  const revokedLegacySessions = await ports.sessions.revokeAllForAccount(input.accountId, now);
  await ports.store.deleteTrustDeviceStateForAccount(input.accountId);
  return { securityEpoch, revokedAuthSessions, revokedLegacySessions };
}
