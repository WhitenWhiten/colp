import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createArgon2idPasswordHasher } from '../../../src/infrastructure/auth/argon2id-password-hasher.js';
import {
  ARGON2ID_HASH_PREFIX,
  PASSWORD_HASH_ARGON2ID_PARAMS,
  type PasswordHasher,
} from '../../../src/modules/auth/index.js';

/**
 * Task C2 Argon2id password hasher contract (G1 §2 / spike §4.4):
 * - the better-auth default scrypt MUST NOT be used; the hash hook is
 *   Argon2id with frozen parameters m=19456, t=2, p=1;
 * - output format `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` — the salt is
 *   random per call, verification is a REAL Argon2id verify (never a
 *   string compare);
 * - the port shape matches the better-auth emailAndPassword.password contract
 *   (`hash(password)` / `verify({ hash, password })`).
 */

const PASSWORD = 'correct-horse-battery-staple'; // secret-scan: allow 'correct-horse-battery-staple'

describe('Argon2id password hasher (real @node-rs/argon2)', () => {
  test('hash output carries the frozen Argon2id parameters in the PHC string', async () => {
    const hasher = createArgon2idPasswordHasher();
    const hash = await hasher.hash(PASSWORD);
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u, 'PHC string must embed m=19456,t=2,p=1');
    assert.ok(hash.length > '$argon2id$v=19$m=19456,t=2,p=1$'.length, 'hash must include salt and digest');
    assert.equal(hash.includes(PASSWORD), false, 'the plaintext password must never appear in the hash');
  });

  test('the frozen parameter contract matches the spike-verified values', () => {
    assert.deepEqual(PASSWORD_HASH_ARGON2ID_PARAMS, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    assert.equal(Object.isFrozen(PASSWORD_HASH_ARGON2ID_PARAMS), true);
    assert.equal(ARGON2ID_HASH_PREFIX, '$argon2id$');
    // The hasher must never be able to drift to scrypt/argon2i by accident:
    // the PHC prefix must not be the argon2i prefix (a plain `includes`
    // check would false-positive on '$argon2id$', which contains 'argon2i').
    assert.equal(ARGON2ID_HASH_PREFIX.startsWith('$argon2i$'), false);
  });

  test('real verify round-trips and rejects wrong passwords', async () => {
    const hasher = createArgon2idPasswordHasher();
    const hash = await hasher.hash(PASSWORD);
    assert.equal(await hasher.verify({ hash, password: PASSWORD }), true);
    assert.equal(await hasher.verify({ hash, password: 'wrong-password' }), false); // secret-scan: allow 'wrong-password'
  });

  test('each hash uses a fresh random salt', async () => {
    const hasher = createArgon2idPasswordHasher();
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);
    assert.notEqual(first, second, 'two hashes of the same password must differ (unique salt)');
    assert.equal(await hasher.verify({ hash: first, password: PASSWORD }), true);
    assert.equal(await hasher.verify({ hash: second, password: PASSWORD }), true);
  });

  test('verifying a malformed hash returns false instead of throwing', async () => {
    const hasher = createArgon2idPasswordHasher();
    for (const garbage of ['not-a-hash', '', '$argon2id$v=19$m=19456,t=2,p=1$broken']) {
      assert.equal(await hasher.verify({ hash: garbage, password: PASSWORD }), false, garbage);
    }
  });

  test('the port shape matches the better-auth password hook contract', async () => {
    const hasher: PasswordHasher = createArgon2idPasswordHasher();
    const hash = await hasher.hash('port-shape-password');
    const verifyResult = await hasher.verify({ hash, password: 'port-shape-password' }); // secret-scan: allow 'port-shape-password'
    assert.equal(verifyResult, true);
  });
});
