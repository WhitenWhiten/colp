/**
 * Task C4: MFA policy facade (plan §9 Task C4 steps 1-2, 5).
 *
 * Product gate for the Better Auth 1.7.1 two-factor plugin. Every MFA
 * surface requires the CURRENT session + Origin/CSRF (transport) + a re-auth
 * proof, with one deliberate exception: `verifyTotp`/`recover` complete the
 * SIGN-IN challenge, where the authorization is the single-use pending 2FA
 * challenge (the password sign-in that created it IS the re-auth) — the
 * pending session is the only "session" that exists at that point, and the
 * A3 facade never treats it as a full business session.
 *
 * Security contract:
 * - enroll / get-totp-uri / disable / regenerate-backup-codes require a full
 *   A3 session (`requireMutationActor`) AND a valid password re-auth proof;
 *   a failed proof never reaches the server port;
 * - verify / recovery require the pending challenge (or a full session, for
 *   already-authenticated re-verification); the server port enforces the
 *   single-use challenge and the atomic single-use backup codes (BA 1.7.1
 *   CAS-removes the used code, G0/G1 contract);
 * - backup codes are shown ONCE: the enroll/regenerate responses are the
 *   only delivery; BA stores them encrypted (`storeBackupCodes: 'encrypted'`)
 *   and the server-only `view-backup-codes` endpoint is never mounted;
 * - TOTP secrets are encrypted at rest with the BA secret (library contract,
 *   spike/G0); the policy never sees or returns the raw secret;
 * - MFA disable raises the account security epoch through the
 *   `SecurityEpochBridge` (`mfa_disable`): disabling 2FA without revoking
 *   every existing session would be a security regression, so the epoch bump
 *   is part of the disable transaction (fail closed — a bump failure fails
 *   the disable).
 *
 * Error taxonomy: stable `MfaPolicyError` codes; the server port
 * implementations map BA API errors onto them (infrastructure/tests).
 */
import {
  hasBrowserSessionMfaChallenge,
  type BrowserSessionAuthority,
} from './browser-session-authority.js';
import type { ReauthVerifier } from './account-linking.js';
import type { SecurityEpochBridge } from './security-epoch-bridge.js';

export type MfaPolicyErrorCode =
  | 'reauth_failed'
  | 'challenge_required'
  | 'challenge_invalid'
  | 'invalid_code'
  | 'too_many_attempts'
  | 'account_locked'
  | 'mfa_not_enabled'
  | 'mfa_unavailable';

export class MfaPolicyError extends Error {
  readonly code: MfaPolicyErrorCode;

  constructor(code: MfaPolicyErrorCode, message: string) {
    super(message);
    this.name = 'MfaPolicyError';
    this.code = code;
  }
}

/**
 * Better Auth two-factor server API (infrastructure/tests implement this over
 * the REAL `auth.api`: enableTwoFactor / getTOTPURI / disableTwoFactor /
 * verifyTOTP / verifyBackupCode / generateBackupCodes — never over the HTTP
 * mount). Implementations map BA error codes to `MfaPolicyError`.
 */
export interface MfaServerPort {
  /** BA `/two-factor/enable`; returns the TOTP URI and the backup codes shown ONCE. */
  enableTwoFactor(input: {
    readonly cookie: string | undefined;
    readonly password: string;
  }): Promise<{ readonly totpUri: string; readonly backupCodes: readonly string[] }>;
  /** BA `/two-factor/get-totp-uri` (session + password re-auth inside BA too). */
  getTotpUri(input: { readonly cookie: string | undefined; readonly password: string }): Promise<string>;
  /** BA `/two-factor/disable` (session + password re-auth inside BA too). */
  disableTwoFactor(input: { readonly cookie: string | undefined; readonly password: string }): Promise<void>;
  /** BA `/two-factor/verify-totp`: completes the pending challenge or re-verifies a session. */
  verifyTotp(input: {
    readonly cookie: string | undefined;
    readonly code: string;
    readonly trustDevice?: boolean;
  }): Promise<void>;
  /** BA `/two-factor/verify-backup-code`: single-use recovery code verification. */
  verifyBackupCode(input: {
    readonly cookie: string | undefined;
    readonly code: string;
    readonly trustDevice?: boolean;
  }): Promise<void>;
  /** BA `/two-factor/generate-backup-codes`: replaces the whole recovery set (old codes die). */
  generateBackupCodes(input: {
    readonly cookie: string | undefined;
    readonly password: string;
  }): Promise<{ readonly backupCodes: readonly string[] }>;
}

export interface MfaPolicyPorts {
  /** A3 current-session gate (enroll/disable/regeneration) and pending-challenge gate (verify/recovery). */
  readonly authority: BrowserSessionAuthority;
  /** Password re-auth proof verification (the BA plugin contract requires the password). */
  readonly reauth: ReauthVerifier;
  /** BA two-factor server API. */
  readonly server: MfaServerPort;
  /** Epoch bridge: `mfa_disable` raises the account security epoch. */
  readonly bridge: SecurityEpochBridge;
}

export interface MfaPolicyService {
  /** Enroll TOTP: session + re-auth; returns the TOTP URI and backup codes (shown once). */
  enroll(input: { readonly cookie?: string; readonly password: string }): Promise<{
    readonly totpUri: string;
    readonly backupCodes: readonly string[];
  }>;
  /** Re-display the TOTP URI: session + re-auth. */
  getTotpUri(input: { readonly cookie?: string; readonly password: string }): Promise<string>;
  /** Disable TOTP: session + re-auth, then raises the mfa_disable security epoch. */
  disable(input: { readonly cookie?: string; readonly password: string }): Promise<void>;
  /** Complete the pending 2FA challenge with a TOTP code (sign-in flow / re-verification). */
  verifyTotp(input: { readonly cookie?: string; readonly code: string; readonly trustDevice?: boolean }): Promise<void>;
  /** Complete the pending 2FA challenge with a single-use backup code. */
  recover(input: { readonly cookie?: string; readonly code: string }): Promise<void>;
  /** Replace the recovery code set: session + re-auth. */
  regenerateBackupCodes(input: { readonly cookie?: string; readonly password: string }): Promise<{
    readonly backupCodes: readonly string[];
  }>;
}

async function requireReauth(
  ports: MfaPolicyPorts,
  cookie: string | undefined,
  password: string,
): Promise<void> {
  const ok = await ports.reauth.verifyPassword({ cookie, password });
  if (!ok) {
    throw new MfaPolicyError('reauth_failed', 'the re-authentication proof is invalid');
  }
}

export function createMfaPolicyService(ports: MfaPolicyPorts): MfaPolicyService {
  return {
    async enroll({ cookie, password }) {
      // Current session (A3) — throws BrowserSessionAuthenticationError when absent.
      await ports.authority.requireMutationActor({ cookie }, { touch: true });
      await requireReauth(ports, cookie, password);
      // The response is the ONLY delivery of the backup codes; the server
      // stores secret + codes encrypted at rest (library contract).
      return ports.server.enableTwoFactor({ cookie, password });
    },
    async getTotpUri({ cookie, password }) {
      await ports.authority.requireMutationActor({ cookie }, { touch: true });
      await requireReauth(ports, cookie, password);
      return ports.server.getTotpUri({ cookie, password });
    },
    async disable({ cookie, password }) {
      const actor = await ports.authority.requireMutationActor({ cookie }, { touch: true });
      await requireReauth(ports, cookie, password);
      await ports.server.disableTwoFactor({ cookie, password });
      // Fail closed: disabling MFA without revoking every existing session is
      // a security regression — the epoch bump is part of the disable.
      await ports.bridge.raiseAccountSecurityEvent('mfa_disable', actor.account.id);
    },
    async verifyTotp({ cookie, code, trustDevice }) {
      // The pending challenge (or an existing session) is the authorization
      // for this step: without either, the server port must not be reached.
      const actor = await ports.authority.authenticate({ cookie }, { touch: false });
      if (actor === null && !hasBrowserSessionMfaChallenge(cookie)) {
        throw new MfaPolicyError('challenge_required', 'a two-factor challenge is required');
      }
      await ports.server.verifyTotp({ cookie, code, trustDevice });
    },
    async recover({ cookie, code }) {
      const actor = await ports.authority.authenticate({ cookie }, { touch: false });
      if (actor === null && !hasBrowserSessionMfaChallenge(cookie)) {
        throw new MfaPolicyError('challenge_required', 'a two-factor challenge is required');
      }
      // Single-use enforcement is the server contract: BA CAS-removes the
      // used code atomically, so a replayed code is indistinguishable from an
      // invalid one (non-enumerating).
      await ports.server.verifyBackupCode({ cookie, code });
    },
    async regenerateBackupCodes({ cookie, password }) {
      await ports.authority.requireMutationActor({ cookie }, { touch: true });
      await requireReauth(ports, cookie, password);
      // BA replaces the stored set: every previously shown code dies.
      return ports.server.generateBackupCodes({ cookie, password });
    },
  };
}
