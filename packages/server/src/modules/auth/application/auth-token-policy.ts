/**
 * Task C2 authentication token policy (application layer leaf).
 *
 * Frozen contract (G1 ADR §8; spike §4.3):
 * - OTP length 6, TTL 300s, max 3 attempts, single-use; every resend ROTATES
 *   the code (hashed storage makes better-auth's "reuse" impossible, so the
 *   rotation is pinned explicitly in the runtime);
 * - purpose separation: sign-in / email-verification / forget-password /
 *   change-email are separate purposes and the purpose ALWAYS enters the
 *   digest input (`${type}-otp-${email}` storage identifier and the
 *   digest-only auth-email idempotency key);
 * - digest-only storage: identifiers and OTP values are stored as
 *   `sha256 base64url` (no padding) digests — the plaintext email, OTP and
 *   reset token never appear in `auth_verifications` rows;
 * - email verification (default JWT flow) does not land in the verification
 *   table at all (spike §3.3), so the digest contract covers OTP + reset rows
 *   only.
 */
import { createHash } from 'node:crypto';
import type { AuthEmailPurpose } from './auth-email-templates.js';

/** Frozen OTP length (G1 §8; plan §3.1). */
export const AUTH_OTP_LENGTH = 6 as const;
/** Frozen OTP TTL in seconds (G1 §8; better-auth emailOTP default). */
export const AUTH_OTP_TTL_SECONDS = 300 as const;
/** Frozen OTP attempt cap; the 4th attempt is 403 TOO_MANY_ATTEMPTS (G1 §8). */
export const AUTH_OTP_MAX_ATTEMPTS = 3 as const;

/** Policy bounds mirrored from the startup validation (config.ts). */
export const AUTH_OTP_TTL_MIN_SECONDS = 60 as const;
export const AUTH_OTP_TTL_MAX_SECONDS = 3600 as const;
export const AUTH_OTP_MAX_ATTEMPTS_MAX = 10 as const;

/**
 * The four Better Auth emailOTP purposes (spike §4.3: the plugin stores the
 * OTP under the identifier `${type}-otp-${email}`, hashed with
 * storeIdentifier 'hashed').
 */
export const AUTH_OTP_TYPES = Object.freeze([
  'sign-in',
  'email-verification',
  'forget-password',
  'change-email',
] as const);

export type AuthOtpType = (typeof AUTH_OTP_TYPES)[number];

const OTP_PATTERN = /^\d{6}$/u;

/** sha256 digest encoded as unpadded base64url (spike §4.3 storage format). */
export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

/**
 * Digest-only storage identifier for an OTP purpose + recipient: the purpose
 * enters the digest input and the plaintext email never reaches the
 * verification table (spike §4.3: identifier = sha256base64url(`${type}-otp-${email}`)).
 */
export function otpIdentifierDigest(type: AuthOtpType, email: string): string {
  return sha256Base64Url(`${type}-otp-${email.toLowerCase()}`);
}

/**
 * Digest-only stored value for an OTP: sha256(otp) + the attempt counter,
 * matching the better-auth `value = sha256base64url(otp) + ':<attempts>'`
 * row contract (spike §4.3).
 */
export function otpValueDigest(otp: string, attempts: number): string {
  return `${sha256Base64Url(otp)}:${attempts}`;
}

/**
 * Digest-only storage identifier for a password-reset token
 * (spike §4.3: reset row identifier = sha256base64url(`reset-password:<token>`),
 * value = userId).
 */
export function resetIdentifierDigest(token: string): string {
  return sha256Base64Url(`reset-password:${token}`);
}

/**
 * Stable, digest-only auth-email idempotency key for a scope + recipient.
 * The scope (the C1 purpose, or `otp:<type>` for OTP deliveries) enters the
 * digest input so each purpose/recipient pair has its own provider key while
 * the raw recipient and scope never reach the provider tag (C1 contract:
 * idempotencyKey is forwarded verbatim as the DirectMail TagName).
 */
export function authEmailIdempotencyKey(scope: string, recipient: string): string {
  if (scope.length === 0 || scope.length > 64) {
    throw new TypeError('auth email idempotency scope must be 1..64 characters');
  }
  return sha256Base64Url(`auth-email:${scope}:${recipient.toLowerCase()}`);
}

export interface AuthOtpPolicyInput {
  readonly otpLength: number;
  readonly expiresInSeconds: number;
  readonly maxAttempts: number;
}

/**
 * Re-check the frozen OTP policy invariants (second line of defense after the
 * env parsing; same pattern as the frozen cookie-name check). The defaults
 * are G1 §8 values; legal overrides stay inside the bounded ranges.
 */
export function assertAuthOtpPolicy(policy: AuthOtpPolicyInput): void {
  if (policy.otpLength !== AUTH_OTP_LENGTH) {
    throw new Error(`otpLength must be ${AUTH_OTP_LENGTH} (frozen G1 §8 contract)`);
  }
  if (!Number.isInteger(policy.expiresInSeconds)
      || policy.expiresInSeconds < AUTH_OTP_TTL_MIN_SECONDS
      || policy.expiresInSeconds > AUTH_OTP_TTL_MAX_SECONDS) {
    throw new Error(
      `expiresInSeconds must be an integer between ${AUTH_OTP_TTL_MIN_SECONDS} and ${AUTH_OTP_TTL_MAX_SECONDS}`,
    );
  }
  if (!Number.isInteger(policy.maxAttempts)
      || policy.maxAttempts < 1
      || policy.maxAttempts > AUTH_OTP_MAX_ATTEMPTS_MAX) {
    throw new Error(`maxAttempts must be an integer between 1 and ${AUTH_OTP_MAX_ATTEMPTS_MAX}`);
  }
}

/** Validate a submitted OTP code against the frozen 6-digit format. */
export function isValidOtpCode(value: string): boolean {
  return OTP_PATTERN.test(value);
}

/**
 * Map a Better Auth OTP plugin type onto the C1 auth email purpose. Each OTP
 * type has its own template with a validated 6-digit `{ otp }` payload so the
 * mailbox copy matches the action (sign-in vs verification vs reset vs
 * change-email). The type still enters the digest-only idempotency key
 * (`otp:<type>`), so delivery dedupe and observability keep purpose
 * separation without leaking the code.
 */
export function otpEmailPurpose(type: AuthOtpType): AuthEmailPurpose {
  switch (type) {
    case 'sign-in':
      return 'sign-in-otp';
    case 'email-verification':
      return 'email-verification-otp';
    case 'forget-password':
      return 'forget-password-otp';
    case 'change-email':
      return 'change-email-otp';
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
