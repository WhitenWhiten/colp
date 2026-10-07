/**
 * Task C3: account recovery facade (plan §9 Task C3 step 6).
 *
 * Recovery contract:
 * - an account is recovered ONLY through a verified-email OTP proof
 *   (`recoverWithVerifiedEmailOtp`, backed by the digest-only email-OTP
 *   plugin) or a password-reset token (`requestPasswordRecovery`, backed by
 *   the C2 reset flow); both paths go through the Better Auth server API, so
 *   the endpoints stay gated by the auth-route manifest (C2 pending entries);
 * - `requestPasswordRecovery` is NON-ENUMERATING: the same success shape is
 *   returned whether or not the email exists; delivery only happens for
 *   existing users (BA contract, spike §3.3);
 * - a provider OAuth email claim is NEVER a recovery proof
 *   (`assertAcceptableRecoveryProof` rejects 'provider-email-claim'): the
 *   same-email provider callback is refused by `disableImplicitLinking`
 *   (account_not_linked) and the A2 mapping surface never adopts an existing
 *   account from a bare provider claim (G1 ADR §11; plan §4.3.4).
 *
 * The port is implemented in the test/composition over the real
 * `auth.api` (`requestPasswordReset` / `resetPasswordEmailOTP`); the
 * resetPasswordEmailOTP route itself revokes every session
 * (revokeSessionsOnPasswordReset, C2) and marks the email verified
 * (verified-email proof).
 */

export type AccountRecoveryErrorCode =
  | 'email_delivery_unavailable'
  | 'invalid_credentials'
  | 'invalid_request';

export class AccountRecoveryError extends Error {
  readonly code: AccountRecoveryErrorCode;

  constructor(code: AccountRecoveryErrorCode, message: string) {
    super(message);
    this.name = 'AccountRecoveryError';
    this.code = code;
  }
}

/**
 * The only proof kinds that may recover a Know-N account. A provider email
 * claim is deliberately NOT among them — a provider callback's bare email
 * claim must never take over an existing local/legacy account (plan §4.3.4
 * item 4; G1 ADR §11).
 */
export type RecoveryProofKind = 'password-reset-token' | 'verified-email-otp' | 'provider-email-claim';

/** Acceptable recovery proofs (password reset token / verified-email OTP). */
const ACCEPTABLE_RECOVERY_PROOFS: readonly RecoveryProofKind[] = Object.freeze([
  'password-reset-token',
  'verified-email-otp',
]);

/**
 * Recovery policy gate: rejects provider-email-claim proofs with the stable
 * non-enumerating invalid_credentials error. Every recovery entry point in
 * this facade runs through this gate so the "provider claim cannot recover"
 * invariant is enforced at the application boundary, not only by the OAuth
 * callback behavior.
 */
export function assertAcceptableRecoveryProof(kind: RecoveryProofKind): void {
  if (!ACCEPTABLE_RECOVERY_PROOFS.includes(kind)) {
    throw new AccountRecoveryError(
      'invalid_credentials',
      'this proof cannot recover an account',
    );
  }
}

/**
 * Better Auth server API for the recovery flows (infrastructure/test
 * implement this over the real `auth.api`; never over the HTTP mount, so the
 * recovery surface stays inside the product route contract).
 */
export interface RecoveryServerPort {
  /** BA `requestPasswordReset` — non-enumerating, delivery only when the user exists. */
  requestPasswordReset(input: { readonly email: string }): Promise<void>;
  /** BA emailOTP `resetPasswordEmailOTP` — verified-email OTP proof, consumes the OTP, revokes sessions. */
  resetPasswordWithEmailOtp(input: { readonly email: string; readonly otp: string; readonly newPassword: string }): Promise<void>;
}

export interface AccountRecoveryService {
  /**
   * Request a password-reset delivery. Always resolves with the same success
   * shape (no email enumeration); delivery is skipped for unknown emails.
   */
  requestPasswordRecovery(input: { readonly email: string }): Promise<{ readonly status: true }>;
  /**
   * Reset the password with a forget-password OTP delivered to the verified
   * email. The OTP is consumed by the plugin; every existing session is
   * revoked; the email becomes verified (a forget-password OTP is a
   * verified-email proof).
   */
  recoverWithVerifiedEmailOtp(input: {
    readonly email: string;
    readonly otp: string;
    readonly newPassword: string;
  }): Promise<{ readonly status: true }>;
}

/** Map known BA server API failures onto the stable recovery errors. */
function mapRecoveryServerError(error: unknown): AccountRecoveryError {
  // BA 1.6.29 server API errors carry the stable code on `body.code`
  // (APIError.from(status, {message, code}) — the top-level `code`
  // fallback covers port implementations that re-shape the error.
  const record = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown; readonly body?: unknown })
    : null;
  const body = record !== null && typeof record.body === 'object' && record.body !== null
    ? (record.body as { readonly code?: unknown })
    : null;
  const code = body !== null && typeof body.code === 'string'
    ? body.code
    : record !== null && typeof record.code === 'string'
      ? record.code
      : null;
  if (code === 'RESET_PASSWORD_DISABLED' || code === 'VERIFICATION_EMAIL_NOT_ENABLED') {
    return new AccountRecoveryError(
      'email_delivery_unavailable',
      'Email delivery is temporarily unavailable. Please try again later.',
    );
  }
  if (
    code === 'INVALID_OTP'
    || code === 'OTP_EXPIRED'
    || code === 'TOO_MANY_ATTEMPTS'
    || code === 'USER_NOT_FOUND'
    || code === 'INVALID_EMAIL_OR_PASSWORD'
  ) {
    return new AccountRecoveryError(
      'invalid_credentials',
      'The email or password is incorrect.',
    );
  }
  if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG' || code === 'INVALID_EMAIL') {
    return new AccountRecoveryError('invalid_request', 'The request is invalid.');
  }
  throw error;
}

export function createAccountRecoveryService(server: RecoveryServerPort): AccountRecoveryService {
  return {
    async requestPasswordRecovery({ email }) {
      assertAcceptableRecoveryProof('password-reset-token');
      try {
        await server.requestPasswordReset({ email });
      } catch (error) {
        throw mapRecoveryServerError(error);
      }
      return { status: true };
    },
    async recoverWithVerifiedEmailOtp({ email, otp, newPassword }) {
      assertAcceptableRecoveryProof('verified-email-otp');
      try {
        await server.resetPasswordWithEmailOtp({ email, otp, newPassword });
      } catch (error) {
        throw mapRecoveryServerError(error);
      }
      return { status: true };
    },
  };
}
