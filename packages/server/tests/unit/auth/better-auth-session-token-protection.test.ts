import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  BetterAuthSessionTokenProtectionError,
  createBetterAuthSessionTokenProtector,
} from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { parseBetterAuthSessionTokenKeys } from '../../../src/bootstrap/config-http-security.js';
import { loadConfig } from '../../support/test-config.js';
import { betterAuthProductionEnv } from '../../support/better-auth-config-test-helpers.js';

const TOKEN = 'AbCdEf0123456789AbCdEf0123456789'; // secret-scan: allow 'AbCdEf0123456789AbCdEf0123456789'
const KEY_V1 = Buffer.alloc(32, 11);
const KEY_V2 = Buffer.alloc(32, 22);

function protector(input: {
  readonly keys?: readonly { readonly version: number; readonly key: Buffer }[];
  readonly legacyPlaintextReadUntil?: Date | null;
  readonly now?: Date;
} = {}) {
  const current = input.now ?? new Date('2026-08-30T00:00:00.000Z');
  return createBetterAuthSessionTokenProtector({
    keys: input.keys ?? [{ version: 2, key: KEY_V2 }, { version: 1, key: KEY_V1 }],
    legacyPlaintextReadUntil: input.legacyPlaintextReadUntil ?? null,
    now: () => new Date(current),
  });
}

describe('Better Auth session token at-rest protection', () => {
  test('uses randomized authenticated ciphertext and stable keyed lookups', () => {
    const codec = protector();
    const first = codec.protect(TOKEN);
    const second = codec.protect(TOKEN);
    assert.match(first.ciphertext, /^knst1\.2\./u);
    assert.notEqual(first.ciphertext, TOKEN);
    assert.notEqual(first.ciphertext, second.ciphertext, 'AES-GCM IV must be random');
    assert.equal(first.lookupHash, second.lookupHash);
    assert.match(first.lookupHash, /^knsh1\.2\.[A-Za-z0-9_-]{43}$/u);
    assert.equal(codec.reveal(first.ciphertext), TOKEN);
    assert.deepEqual(codec.lookupHashes(TOKEN), [
      first.lookupHash,
      protector({ keys: [{ version: 1, key: KEY_V1 }] }).protect(TOKEN).lookupHash,
    ]);
  });

  test('retained keys decrypt old envelopes while new writes use only the active key', () => {
    const old = protector({ keys: [{ version: 1, key: KEY_V1 }] }).protect(TOKEN);
    const rotated = protector();
    assert.equal(rotated.reveal(old.ciphertext), TOKEN);
    assert.match(rotated.protect(TOKEN).ciphertext, /^knst1\.2\./u);
    assert.throws(
      () => protector({ keys: [{ version: 2, key: KEY_V2 }] }).reveal(old.ciphertext),
      /key version is unavailable/u,
    );
  });

  test('tampering, malformed envelopes, and plaintext outside the bridge fail closed', () => {
    const codec = protector();
    const protectedToken = codec.protect(TOKEN);
    const parts = protectedToken.ciphertext.split('.');
    const tag = Buffer.from(parts[4]!, 'base64url');
    tag[0] ^= 0x01;
    const tampered = [...parts.slice(0, 4), tag.toString('base64url')].join('.');
    assert.throws(() => codec.reveal(tampered), /authentication failed/u);
    assert.throws(() => codec.reveal('knst1.2.bad'), /envelope is malformed/u);
    assert.throws(() => codec.reveal(TOKEN), /plaintext session token is not accepted/u);
    assert.throws(() => codec.protect('token with spaces'), /token format is invalid/u);
  });

  test('legacy plaintext is accepted only before an explicit deadline', () => {
    const before = protector({
      legacyPlaintextReadUntil: new Date('2026-08-31T00:00:00.000Z'),
    });
    assert.equal(before.reveal(TOKEN), TOKEN);
    assert.equal(before.legacyLookupValue(TOKEN), TOKEN);
    assert.equal(before.legacyLookupValue(before.protect(TOKEN).ciphertext), null);

    const expired = protector({
      legacyPlaintextReadUntil: new Date('2026-08-29T00:00:00.000Z'),
    });
    assert.throws(() => expired.reveal(TOKEN), BetterAuthSessionTokenProtectionError);
    assert.equal(expired.legacyLookupValue(TOKEN), null);
  });

  test('key env parser accepts an ordered keyring and rejects ambiguous material', () => {
    const parsed = parseBetterAuthSessionTokenKeys(
      `2:${KEY_V2.toString('base64')},1:${KEY_V1.toString('base64')}`,
    );
    assert.deepEqual(parsed.map((entry) => entry.version), [2, 1]);
    assert.ok(parsed[0]!.key.equals(KEY_V2));
    assert.throws(
      () => parseBetterAuthSessionTokenKeys(`1:${KEY_V1.toString('base64')},1:${KEY_V2.toString('base64')}`),
      /versions must be unique/u,
    );
    assert.throws(
      () => parseBetterAuthSessionTokenKeys(`2:${KEY_V1.toString('base64')},1:${KEY_V1.toString('base64')}`),
      /key material must be unique/u,
    );
    assert.throws(() => parseBetterAuthSessionTokenKeys('1:not-base64'), /canonical base64/u);
    const canonical = KEY_V1.toString('base64');
    const nonCanonicalPadding = `${canonical.slice(0, -2)}t=`;
    assert.throws(
      () => parseBetterAuthSessionTokenKeys(`1:${nonCanonicalPadding}`),
      /decode to 32 bytes/u,
    );
  });

  test('production requires independent key material and an explicit bounded legacy bridge', () => {
    const reused = KEY_V1.toString('base64');
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({
        BETTER_AUTH_ENABLED: 'true',
        BETTER_AUTH_SECRET: 'independent-production-secret-0123456789',
        BETTER_AUTH_SESSION_TOKEN_KEYS: `2:${KEY_V2.toString('base64')},1:${Buffer.alloc(32, 0x5a).toString('base64')}`,
      })),
      /must not use the test default/u,
    );
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({
        BETTER_AUTH_ENABLED: 'true',
        BETTER_AUTH_SECRET: reused,
        BETTER_AUTH_SESSION_TOKEN_KEYS: `1:${reused}`,
      })),
      /must be independent/u,
    );
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({
        BETTER_AUTH_ENABLED: 'true',
        BETTER_AUTH_SECRET: 'independent-production-secret-0123456789',
        BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL: '2020-01-01T00:00:00.000Z',
      })),
      /must be in the future/u,
    );
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({
        BETTER_AUTH_ENABLED: 'true',
        BETTER_AUTH_SECRET: 'independent-production-secret-0123456789',
        BETTER_AUTH_SESSION_TOKEN_LEGACY_READ_UNTIL: new Date(
          Date.now() + 32 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })),
      /at most 31 days/u,
    );
  });
});
