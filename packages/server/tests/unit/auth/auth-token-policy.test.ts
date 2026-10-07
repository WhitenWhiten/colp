import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'vitest';
import {
  AUTH_EMAIL_SUBJECT_MAX_CHARS,
  AUTH_OTP_LENGTH,
  AUTH_OTP_MAX_ATTEMPTS,
  AUTH_OTP_MAX_ATTEMPTS_MAX,
  AUTH_OTP_TTL_MAX_SECONDS,
  AUTH_OTP_TTL_MIN_SECONDS,
  AUTH_OTP_TTL_SECONDS,
  AUTH_OTP_TYPES,
  assertAuthOtpPolicy,
  authEmailIdempotencyKey,
  isValidOtpCode,
  otpEmailPurpose,
  otpIdentifierDigest,
  otpValueDigest,
  renderAuthEmailTemplate,
  resetIdentifierDigest,
  sha256Base64Url,
  type AuthEmailPurpose,
  type AuthOtpType,
} from '../../../src/modules/auth/index.js';

/**
 * Task C2 token policy contract (G1 §8 / spike §4.3):
 * - OTP length 6, TTL 300s, max 3 attempts, single-use, per-purpose digests;
 * - purpose separation: the Better Auth OTP type enters the digest input
 *   (`${type}-otp-${email}`), the email idempotency key is digest-only;
 * - digest format matches the frozen `sha256 base64url` (no padding) contract
 *   the spike verified against the real PostgreSQL rows.
 */

function referenceSha256Base64Url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

describe('AUTH token policy frozen constants (G1 §8)', () => {
  test('OTP contract defaults are exactly 6 digits / 300s / 3 attempts', () => {
    assert.equal(AUTH_OTP_LENGTH, 6);
    assert.equal(AUTH_OTP_TTL_SECONDS, 300);
    assert.equal(AUTH_OTP_MAX_ATTEMPTS, 3);
  });

  test('policy bounds match the startup validation surface (config.ts)', () => {
    assert.equal(AUTH_OTP_TTL_MIN_SECONDS, 60);
    assert.equal(AUTH_OTP_TTL_MAX_SECONDS, 3600);
    assert.equal(AUTH_OTP_MAX_ATTEMPTS_MAX, 10);
    assert.ok(AUTH_OTP_TTL_MIN_SECONDS <= AUTH_OTP_TTL_SECONDS);
    assert.ok(AUTH_OTP_TTL_SECONDS <= AUTH_OTP_TTL_MAX_SECONDS);
    assert.ok(AUTH_OTP_MAX_ATTEMPTS <= AUTH_OTP_MAX_ATTEMPTS_MAX);
  });

  test('the four Better Auth OTP purposes are frozen and purpose-separated', () => {
    assert.deepEqual([...AUTH_OTP_TYPES], ['sign-in', 'email-verification', 'forget-password', 'change-email']);
    assert.equal(Object.isFrozen(AUTH_OTP_TYPES), true);
    // Each type must be distinct — the digest input depends on it.
    assert.equal(new Set(AUTH_OTP_TYPES).size, AUTH_OTP_TYPES.length);
  });
});

describe('sha256Base64Url digest primitive (spike §4.3 format)', () => {
  test('matches an independent sha256 base64url (no padding) computation', () => {
    for (const input of ['', '123456', 'sign-in-otp-user@example.com', 'reset-password:abc123']) {
      assert.equal(sha256Base64Url(input), referenceSha256Base64Url(input), input);
    }
  });

  test('output is base64url without padding and deterministic', () => {
    const digest = sha256Base64Url('123456');
    assert.match(digest, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(digest.includes('='), false);
    assert.equal(digest, sha256Base64Url('123456'));
  });
});

describe('OTP purpose-separated digests', () => {
  test('the identifier digest equals sha256 of `${type}-otp-${email}` (BA storage contract)', () => {
    for (const type of AUTH_OTP_TYPES) {
      const email = 'Owner@Example.test';
      assert.equal(
        otpIdentifierDigest(type, email),
        referenceSha256Base64Url(`${type}-otp-owner@example.test`),
        type,
      );
    }
  });

  test('the email is normalized to lowercase before entering the digest', () => {
    assert.equal(
      otpIdentifierDigest('sign-in', 'Owner@Example.test'),
      otpIdentifierDigest('sign-in', 'owner@example.test'),
    );
  });

  test('different purposes never collide in the digest space', () => {
    const email = 'user@example.test';
    const digests = new Set(AUTH_OTP_TYPES.map((type) => otpIdentifierDigest(type, email)));
    assert.equal(digests.size, AUTH_OTP_TYPES.length, 'purpose separation must enter the digest input');
  });

  test('the identifier digest never contains the raw purpose+email identifier', () => {
    const raw = 'sign-in-otp-user@example.test';
    const digest = otpIdentifierDigest('sign-in', 'user@example.test');
    assert.notEqual(digest, raw);
    assert.equal(digest.includes('user@example.test'), false);
  });

  test('the value digest is sha256(otp) plus the attempt counter', () => {
    assert.equal(otpValueDigest('123456', 0), `${referenceSha256Base64Url('123456')}:0`);
    assert.equal(otpValueDigest('123456', 3), `${referenceSha256Base64Url('123456')}:3`);
  });

  test('the value digest never contains the plaintext OTP', () => {
    const value = otpValueDigest('123456', 0);
    assert.equal(value.includes('123456'), false);
  });

  test('reset token identifier digest equals sha256 of `reset-password:<token>`', () => {
    const token = 'reset-token-abc';
    assert.equal(resetIdentifierDigest(token), referenceSha256Base64Url(`reset-password:${token}`));
    assert.notEqual(resetIdentifierDigest(token), `reset-password:${token}`);
    assert.equal(resetIdentifierDigest(token).includes(token), false);
  });
});

describe('auth email idempotency keys (digest-only, stable, scoped)', () => {
  test('the key is a stable digest of scope + recipient and stays inside the port budget', () => {
    const key = authEmailIdempotencyKey('otp:sign-in', 'user@example.test');
    assert.equal(key, authEmailIdempotencyKey('otp:sign-in', 'user@example.test'));
    assert.equal(key, authEmailIdempotencyKey('otp:sign-in', 'USER@example.test'), 'recipient is normalized');
    assert.ok(key.length >= 1 && key.length <= 128, 'idempotencyKey must satisfy the auth email port bounds');
  });

  test('different scopes (purpose separation) produce different keys', () => {
    const email = 'user@example.test';
    const keys = new Set([
      authEmailIdempotencyKey('otp:sign-in', email),
      authEmailIdempotencyKey('otp:email-verification', email),
      authEmailIdempotencyKey('otp:forget-password', email),
      authEmailIdempotencyKey('otp:change-email', email),
      authEmailIdempotencyKey('email-verification', email),
      authEmailIdempotencyKey('password-reset', email),
    ]);
    assert.equal(keys.size, 6, 'scope must enter the key input');
  });

  test('the key never contains the recipient or the scope in plaintext', () => {
    const key = authEmailIdempotencyKey('otp:sign-in', 'user@example.test');
    assert.equal(key.includes('user@example.test'), false);
    assert.equal(key.includes('otp:sign-in'), false);
  });
});

describe('assertAuthOtpPolicy (config-contract validation)', () => {
  test('accepts the frozen defaults and legal overrides', () => {
    assertAuthOtpPolicy({ otpLength: AUTH_OTP_LENGTH, expiresInSeconds: AUTH_OTP_TTL_SECONDS, maxAttempts: AUTH_OTP_MAX_ATTEMPTS });
    assertAuthOtpPolicy({ otpLength: 6, expiresInSeconds: 600, maxAttempts: 5 });
    assertAuthOtpPolicy({ otpLength: 6, expiresInSeconds: AUTH_OTP_TTL_MIN_SECONDS, maxAttempts: AUTH_OTP_MAX_ATTEMPTS_MAX });
  });

  test('rejects an OTP length other than the frozen 6', () => {
    for (const otpLength of [5, 7, 0, -1]) {
      assert.throws(
        () => assertAuthOtpPolicy({ otpLength, expiresInSeconds: 300, maxAttempts: 3 }),
        /otpLength must be 6/u,
      );
    }
  });

  test('rejects TTL outside the 60..3600s bounds', () => {
    for (const expiresInSeconds of [0, 30, 59, 3601, 7200, Number.NaN, 300.5]) {
      assert.throws(
        () => assertAuthOtpPolicy({ otpLength: 6, expiresInSeconds, maxAttempts: 3 }),
        /expiresInSeconds must be an integer between 60 and 3600/u,
      );
    }
  });

  test('rejects attempt caps outside the 1..10 bounds', () => {
    for (const maxAttempts of [0, 11, 20, Number.NaN, 2.5]) {
      assert.throws(
        () => assertAuthOtpPolicy({ otpLength: 6, expiresInSeconds: 300, maxAttempts }),
        /maxAttempts must be an integer between 1 and 10/u,
      );
    }
  });
});

describe('isValidOtpCode', () => {
  test('accepts exactly six digits', () => {
    assert.equal(isValidOtpCode('123456'), true);
    assert.equal(isValidOtpCode('000000'), true);
  });

  test('rejects wrong lengths, letters and empty input', () => {
    for (const value of ['12345', '1234567', '12345a', 'abcdef', '', ' 123456']) {
      assert.equal(isValidOtpCode(value), false, value);
    }
  });
});

/**
 * C-06: each Better Auth OTP type maps onto its own C1 template so mailbox
 * copy matches the action. Assertions call production `otpEmailPurpose` and
 * `renderAuthEmailTemplate` (no test-side purpose map used as a substitute).
 */
const OTP_FIXTURE = '123456';
const OTP_CANNOT_SIGN_IN_PHRASE = 'This code cannot be used to sign in or create an account';
const OTP_SIGN_IN_PHRASE = 'Your sign-in code is:';

const OTP_EMAIL_EXPECTATIONS: Record<AuthOtpType, {
  readonly purpose: AuthEmailPurpose;
  readonly subject: string;
  readonly phrase: string;
  readonly usableForSignIn: boolean;
}> = {
  'sign-in': {
    purpose: 'sign-in-otp',
    subject: 'Your Know-N sign-in code',
    phrase: OTP_SIGN_IN_PHRASE,
    usableForSignIn: true,
  },
  'email-verification': {
    purpose: 'email-verification-otp',
    subject: 'Your Know-N email verification code',
    phrase: 'Your email verification code is:',
    usableForSignIn: false,
  },
  'forget-password': {
    purpose: 'forget-password-otp',
    subject: 'Your Know-N password reset code',
    phrase: 'Your password reset code is:',
    usableForSignIn: false,
  },
  'change-email': {
    purpose: 'change-email-otp',
    subject: 'Your Know-N email change code',
    phrase: 'Your email change code is:',
    usableForSignIn: false,
  },
};

describe('C-06 otpEmailPurpose maps every AuthOtpType onto a distinct OTP template', () => {
  test('otpEmailPurpose covers every AUTH_OTP_TYPES entry', () => {
    for (const type of AUTH_OTP_TYPES) {
      assert.equal(otpEmailPurpose(type), OTP_EMAIL_EXPECTATIONS[type].purpose, type);
    }
  });

  test('each OTP type renders a unique subject and the matching mailbox phrase', () => {
    const subjects = new Set<string>();
    for (const type of AUTH_OTP_TYPES) {
      const expected = OTP_EMAIL_EXPECTATIONS[type];
      const purpose = otpEmailPurpose(type);
      const rendered = renderAuthEmailTemplate(purpose, { otp: OTP_FIXTURE });
      assert.equal(rendered.ok, true, type);
      if (!rendered.ok) continue;
      assert.equal(rendered.message.subject, expected.subject, type);
      assert.ok(rendered.message.subject.length <= AUTH_EMAIL_SUBJECT_MAX_CHARS, type);
      assert.doesNotMatch(rendered.message.subject, new RegExp(OTP_FIXTURE, 'u'), `${type} subject must not carry the OTP`);
      assert.match(rendered.message.textBody, new RegExp(expected.phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), type);
      assert.match(rendered.message.htmlBody, new RegExp(expected.phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), type);
      assert.match(rendered.message.textBody, /expires in 5 minutes/u, type);
      // The OTP renders inside the shared mono OTP block (email-inner-blocks),
      // as element text — never in an attribute.
      assert.match(rendered.message.htmlBody, new RegExp(`>${OTP_FIXTURE}</span>`, 'u'), `${type} html must carry the escaped code`);
      if (expected.usableForSignIn) {
        assert.match(rendered.message.textBody, new RegExp(OTP_SIGN_IN_PHRASE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), type);
        assert.doesNotMatch(rendered.message.textBody, new RegExp(OTP_CANNOT_SIGN_IN_PHRASE, 'u'), type);
        assert.doesNotMatch(rendered.message.htmlBody, new RegExp(OTP_CANNOT_SIGN_IN_PHRASE, 'u'), type);
      } else {
        assert.match(rendered.message.textBody, new RegExp(OTP_CANNOT_SIGN_IN_PHRASE, 'u'), type);
        assert.match(rendered.message.htmlBody, new RegExp(OTP_CANNOT_SIGN_IN_PHRASE, 'u'), type);
        assert.doesNotMatch(rendered.message.textBody, new RegExp(OTP_SIGN_IN_PHRASE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), type);
      }
      subjects.add(rendered.message.subject);
    }
    assert.equal(subjects.size, AUTH_OTP_TYPES.length, 'OTP purpose subjects must be unique');
    const forgetPassword = renderAuthEmailTemplate(otpEmailPurpose('forget-password'), { otp: OTP_FIXTURE });
    const changeEmail = renderAuthEmailTemplate(otpEmailPurpose('change-email'), { otp: OTP_FIXTURE });
    const emailVerification = renderAuthEmailTemplate(otpEmailPurpose('email-verification'), { otp: OTP_FIXTURE });
    assert.equal(forgetPassword.ok && changeEmail.ok && emailVerification.ok, true);
    if (forgetPassword.ok) {
      assert.doesNotMatch(forgetPassword.message.subject, /Reset your Know-N password/u);
    }
    if (changeEmail.ok) {
      assert.doesNotMatch(changeEmail.message.subject, /Confirm your new Know-N email/u);
    }
    if (emailVerification.ok) {
      assert.doesNotMatch(emailVerification.message.subject, /Verify your Know-N email/u);
    }
  });

  test('malformed OTP payloads fail for every otpEmailPurpose (6-digit contract)', () => {
    const invalid = ['', '12', 'abcdef', '12345', '1234567', '12345a'];
    for (const type of AUTH_OTP_TYPES) {
      const purpose = otpEmailPurpose(type);
      for (const otp of invalid) {
        const rendered = renderAuthEmailTemplate(purpose, { otp });
        assert.equal(rendered.ok, false, `${type} ${otp}`);
        if (!rendered.ok) {
          assert.match(rendered.reason, /otp must be a 6-digit code/u, `${type} ${otp}`);
        }
      }
    }
  });
});
