/**
 * Task C4: security epoch bridge (plan §9 Task C4 step 3).
 *
 * Account-level security events — password reset, email change, provider
 * link, MFA disable and account disable — MUST raise the account
 * `security_epoch`. The A3 `BrowserSessionAuthority.revokeAll` is the single
 * revoke-all mechanism: it atomically bumps the account epoch, deletes every
 * Better Auth browser session row of the account and revokes every legacy
 * product session (the epoch bump is the durable revoke fact).
 *
 * Propagation semantics:
 * - product sessions: revoked inline by `revokeAll` (BA rows deleted, so the
 *   signed cookies die immediately; the A3 facade additionally refuses any
 *   session whose metadata epoch no longer matches the account);
 * - Sync sessions: bound credentials snapshot the account epoch at bind
 *   time and compare it on EVERY verify; never-bound compact JWS compare
 *   signed `iat` to `accounts.security_epoch_bumped_at` (stamped by the
 *   bump). No extra Sync-side credential write is needed;
 * - MCP OAuth: `revokeAll` commits `accounts.security_epoch` and
 *   `security_epoch_bumped_at` in the same transaction. The production
 *   verifier reads that account fact. Propagation runs after commit and may
 *   only notify. It must not throw (the caller would retry and double-bump)
 *   and must not move the global incident epoch.
 *
 * Rollback contract (plan §9 C4): rolling back the bridge code must never
 * lower an existing epoch — the bridge only ever calls `bumpSecurityEpoch`.
 */
import type { BrowserSessionAuthority, BrowserSessionRevokeAllResult } from './browser-session-authority.js';

/** Account security events that raise the account security epoch. */
export type AccountSecurityEvent =
  | 'password_reset'
  | 'email_change'
  | 'provider_link'
  | 'mfa_disable'
  | 'account_disable'
  | 'oauth_occupancy_adopt';

/**
 * Downstream notification after revokeAll commits. Sync already follows the
 * account epoch. This port must not throw and must not repeat the revoke.
 */
export interface AccountSecurityEventPropagationPort {
  propagate(input: { readonly accountId: string; readonly event: AccountSecurityEvent }): Promise<void>;
}

export interface SecurityEpochBridgePorts {
  /** A3 revoke-all: epoch bump + product browser/legacy session revocation. */
  readonly authority: BrowserSessionAuthority;
  /** Optional downstream propagation (MCP OAuth revocation store etc.). */
  readonly propagation?: AccountSecurityEventPropagationPort;
}

export interface SecurityEpochBridge {
  /**
   * Raise one account security event: bump the account epoch and revoke
   * every product session via the A3 revoke-all mechanism, then propagate
   * the event to downstream surfaces. Throws
   * `BrowserSessionAuthenticationError('account_not_found')` for unknown
   * accounts (fail closed, nothing is written).
   */
  raiseAccountSecurityEvent(
    event: AccountSecurityEvent,
    accountId: string,
  ): Promise<BrowserSessionRevokeAllResult>;
}

/** Notify after the account boundary commit. Does not bump any epoch. */
export function createAccountSecurityEventNotification(
  logger: {
    warn(bindings: object, message: string): void;
    info?(bindings: object, message: string): void;
  },
): AccountSecurityEventPropagationPort {
  const write = logger.info === undefined ? logger.warn.bind(logger) : logger.info.bind(logger);
  return {
    async propagate(input) {
      write(
        { accountId: input.accountId, event: input.event },
        'account security boundary committed; MCP revocation reads that account fact',
      );
    },
  };
}

export function createSecurityEpochBridge(ports: SecurityEpochBridgePorts): SecurityEpochBridge {
  return {
    async raiseAccountSecurityEvent(event, accountId) {
      // revokeAll is the single durable revoke mechanism (A3): epoch bump +
      // BA session rows deleted + legacy sessions revoked. Unknown accounts
      // fail closed before any write.
      const result = await ports.authority.revokeAll(accountId);
      if (ports.propagation !== undefined) {
        try {
          await ports.propagation.propagate({ accountId, event });
        } catch {
          // revokeAll already committed. Throwing would retry the business
          // revoke and bump this account's epoch again.
        }
      }
      return result;
    },
  };
}
