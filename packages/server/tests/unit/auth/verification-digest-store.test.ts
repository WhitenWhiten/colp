import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createVerificationDigestStore } from '../../../src/infrastructure/auth/verification-digest-store.js';
import {
  otpIdentifierDigest,
  otpValueDigest,
  resetIdentifierDigest,
} from '../../../src/modules/auth/index.js';

function stubDb(result: Record<string, unknown> | undefined) {
  const builder = {
    selectFrom: () => builder,
    select: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    executeTakeFirst: async () => result,
  };
  return builder;
}

const EMAIL = 'actor@example.test';
const OTP = '847291';
const TOKEN = 'reset-token-value';

describe('verification digest store (digest-only contract)', () => {
  test('findOtpRow / findResetRow map digest identifiers onto the kysely lookup', async () => {
    const otpRow = {
      id: 'otp-1',
      identifier: otpIdentifierDigest('sign-in', EMAIL),
      value: otpValueDigest(OTP, 1),
      expiresAt: new Date('2026-11-30T00:00:00.000Z'),
      createdAt: new Date('2026-11-29T00:00:00.000Z'),
      updatedAt: new Date('2026-11-29T00:00:00.000Z'),
    };
    const store = createVerificationDigestStore(stubDb(otpRow) as never);
    assert.deepEqual(await store.findOtpRow('sign-in', EMAIL), otpRow);
    assert.equal(await store.findResetRow(TOKEN), otpRow);
  });

  test('findOtpRow returns null when no row exists', async () => {
    const store = createVerificationDigestStore(stubDb(undefined) as never);
    assert.equal(await store.findOtpRow('sign-in', EMAIL), null);
  });

  test('assertOtpRowDigestOnly accepts a digest-only OTP row and rejects leaks', () => {
    const store = createVerificationDigestStore(stubDb(undefined) as never);
    const valid = {
      id: 'otp-1',
      identifier: otpIdentifierDigest('sign-in', EMAIL),
      value: otpValueDigest(OTP, 2),
      expiresAt: new Date('2026-11-30T00:00:00.000Z'),
      createdAt: new Date('2026-11-29T00:00:00.000Z'),
      updatedAt: new Date('2026-11-29T00:00:00.000Z'),
    };
    assert.doesNotThrow(() => store.assertOtpRowDigestOnly(valid, {
      type: 'sign-in',
      email: EMAIL,
      sentOtp: OTP,
    }));

    assert.throws(
      () => store.assertOtpRowDigestOnly({ ...valid, identifier: 'not-a-digest' }, {
        type: 'sign-in',
        email: EMAIL,
        sentOtp: OTP,
      }),
      /purpose digest/i,
    );
    assert.throws(
      () => store.assertOtpRowDigestOnly({ ...valid, value: 'no-counter' }, {
        type: 'sign-in',
        email: EMAIL,
        sentOtp: OTP,
      }),
      /attempts/i,
    );
    assert.throws(
      () => store.assertOtpRowDigestOnly({ ...valid, value: `${otpValueDigest(OTP, 2).split(':')[0]}:x` }, {
        type: 'sign-in',
        email: EMAIL,
        sentOtp: OTP,
      }),
      /integer/i,
    );
    assert.throws(
      () => store.assertOtpRowDigestOnly({ ...valid, value: otpValueDigest('000000', 2) }, {
        type: 'sign-in',
        email: EMAIL,
        sentOtp: OTP,
      }),
      /sha256 digest/i,
    );
  });

  test('assertResetRowDigestOnly accepts a digest-only reset row and rejects the raw token', () => {
    const store = createVerificationDigestStore(stubDb(undefined) as never);
    const valid = {
      id: 'reset-1',
      identifier: resetIdentifierDigest(TOKEN),
      value: 'user-id-1',
      expiresAt: new Date('2026-11-30T00:00:00.000Z'),
      createdAt: new Date('2026-11-29T00:00:00.000Z'),
      updatedAt: new Date('2026-11-29T00:00:00.000Z'),
    };
    assert.doesNotThrow(() => store.assertResetRowDigestOnly(valid, TOKEN));

    assert.throws(
      () => store.assertResetRowDigestOnly({ ...valid, identifier: 'not-digest' }, TOKEN),
      /token digest/i,
    );
    assert.throws(
      () => store.assertResetRowDigestOnly({ ...valid, value: TOKEN }, TOKEN),
      /raw token/i,
    );
    assert.throws(
      () => store.assertResetRowDigestOnly({ ...valid, value: '' }, TOKEN),
      /user id/i,
    );
  });
});
