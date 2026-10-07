import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  otpIdentifierDigest,
  otpValueDigest,
  resetIdentifierDigest,
  type AuthOtpType,
} from '../../modules/auth/index.js';

/**
 * Task C2 verification digest store (infrastructure layer).
 *
 * Spike conclusion (G0 record §3.3 / §4.3): with `verification.storeIdentifier:
 * 'hashed'` and emailOTP `storeOTP: 'hashed'`, the Better Auth storage ALREADY
 * satisfies the digest-only contract for OTP and password-reset rows, and the
 * default email-verification flow is JWT-based (never lands in
 * auth_verifications). Therefore NO additional migration or adapter table is
 * needed (plan §9 Task C2 file boundary; report to the reviewer if that
 * changes).
 *
 * This store is the production read/verification surface for that contract:
 * it computes the digest-only identifiers/values (same sha256 base64url
 * format the spike verified against real rows), reads `auth_verifications`
 * rows BY DIGEST, and asserts that stored rows never contain the plaintext
 * email, OTP or reset token. It is used by the integration evidence and by
 * downstream lanes (C3/A4 recovery flows) — it is NOT a test-only getter.
 *
 * Row contract (spike §4.3):
 * - OTP row:   identifier = sha256base64url(`${type}-otp-${email}`),
 *              value      = sha256base64url(otp) + ':<attempts>';
 * - reset row: identifier = sha256base64url(`reset-password:<token>`),
 *              value      = userId (not a secret; the token is the secret).
 */

export interface StoredVerificationRow {
  readonly id: string;
  readonly identifier: string;
  readonly value: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OtpRowAssertionInput {
  /** The purpose the OTP was issued for (enters the identifier digest). */
  readonly type: AuthOtpType;
  /** The recipient the OTP was sent to (enters the identifier digest). */
  readonly email: string;
  /** The plaintext OTP that was delivered to the recipient. */
  readonly sentOtp: string;
}

export interface VerificationDigestStore {
  /** Digest-only storage identifier for an OTP purpose + recipient. */
  readonly otpIdentifierDigest: (type: AuthOtpType, email: string) => string;
  /** Digest-only stored value for an OTP + attempt counter. */
  readonly otpValueDigest: (otp: string, attempts: number) => string;
  /** Digest-only storage identifier for a password-reset token. */
  readonly resetIdentifierDigest: (token: string) => string;
  /** Read the OTP row for a purpose + recipient by its digest identifier. */
  readonly findOtpRow: (type: AuthOtpType, email: string) => Promise<StoredVerificationRow | null>;
  /** Read the password-reset row for a token by its digest identifier. */
  readonly findResetRow: (token: string) => Promise<StoredVerificationRow | null>;
  /**
   * Assert a stored OTP row satisfies the digest-only contract for the
   * purpose/recipient/OTP that were actually used: the identifier equals the
   * purpose digest (plaintext email/OTP absent) and the value equals
   * `digest(otp):<attempts>` with an integer attempt counter. Throws on any
   * plaintext leak or format violation.
   */
  readonly assertOtpRowDigestOnly: (row: StoredVerificationRow, input: OtpRowAssertionInput) => void;
  /**
   * Assert a stored reset row satisfies the digest-only contract for the raw
   * token: the identifier is the token digest (the raw token is absent) and
   * the value is a non-empty user id (never the raw token).
   */
  readonly assertResetRowDigestOnly: (row: StoredVerificationRow, rawToken: string) => void;
}

export function createVerificationDigestStore(db: Kysely<DatabaseSchema>): VerificationDigestStore {
  async function findByIdentifier(identifier: string): Promise<StoredVerificationRow | null> {
    const row = await db
      .selectFrom('auth_verifications')
      .select(['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'])
      .where('identifier', '=', identifier)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  return Object.freeze({
    otpIdentifierDigest,
    otpValueDigest,
    resetIdentifierDigest,
    // Explicit parameter types: Object.freeze erases the return-position
    // contextual typing, so method shorthand parameters would otherwise be
    // implicit `any` under noImplicitAny.
    findOtpRow: (type: AuthOtpType, email: string) => findByIdentifier(otpIdentifierDigest(type, email)),
    findResetRow: (token: string) => findByIdentifier(resetIdentifierDigest(token)),
    assertOtpRowDigestOnly(row: StoredVerificationRow, input: OtpRowAssertionInput) {
      const expectedIdentifier = otpIdentifierDigest(input.type, input.email);
      if (row.identifier !== expectedIdentifier) {
        throw new Error('verification row identifier is not the purpose digest for the sent OTP');
      }
      // BA stores `value = sha256base64url(otp) + ':<attempts>'` (spike §4.3);
      // the digest is unpadded base64url and never contains ':'.
      const separator = row.value.lastIndexOf(':');
      if (separator <= 0 || separator === row.value.length - 1) {
        throw new Error('verification row value must carry the `:<attempts>` counter');
      }
      const attemptsPart = row.value.slice(separator + 1);
      if (!/^\d+$/u.test(attemptsPart)) {
        throw new Error('verification row value attempt counter must be an integer');
      }
      const expectedValue = otpValueDigest(input.sentOtp, Number(attemptsPart));
      if (row.value !== expectedValue) {
        throw new Error('verification row value is not the sha256 digest of the sent OTP');
      }
      if (row.identifier.includes(input.sentOtp) || row.value.includes(input.sentOtp)) {
        throw new Error('verification row must never contain the plaintext OTP');
      }
      if (row.identifier.includes(input.email.toLowerCase())) {
        throw new Error('verification row identifier must never contain the plaintext email');
      }
    },
    assertResetRowDigestOnly(row: StoredVerificationRow, rawToken: string) {
      const expectedIdentifier = resetIdentifierDigest(rawToken);
      if (row.identifier !== expectedIdentifier) {
        throw new Error('reset row identifier is not the token digest');
      }
      if (row.identifier.includes(rawToken) || row.value.includes(rawToken)) {
        throw new Error('reset row must never contain the raw token');
      }
      if (row.value.length === 0) {
        throw new Error('reset row value must carry the user id');
      }
    },
  });
}
