import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { generateBetterAuthSessionToken } from '../../../src/infrastructure/auth/better-auth-session-authority.js';

describe('Better Auth successor session token generation', () => {
  test('rejection-samples the incomplete byte range instead of introducing modulo bias', () => {
    const calls: number[] = [];
    const chunks = [
      Uint8Array.from([
        248, 249, 250, 251, 252, 253, 254, 255,
        ...Array.from({ length: 24 }, (_, index) => index),
      ]),
      Uint8Array.from(Array.from({ length: 8 }, (_, index) => index + 24)),
    ];

    const token = generateBetterAuthSessionToken((size) => {
      calls.push(size);
      const chunk = chunks.shift();
      assert.ok(chunk, 'the generator requested an unexpected extra random chunk');
      return chunk;
    });

    assert.equal(token, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
    assert.deepEqual(calls, [32, 8]);
  });

  test('accepts the last complete-range byte and keeps the Better Auth token shape', () => {
    let first = true;
    const token = generateBetterAuthSessionToken((size) => {
      if (first) {
        first = false;
        return Uint8Array.from([247, 248, ...Array.from({ length: size - 2 }, () => 0)]);
      }
      return Uint8Array.from(Array.from({ length: size }, () => 0));
    });

    assert.equal(token, `9${'A'.repeat(31)}`);
    assert.match(token, /^[A-Za-z0-9]{32}$/u);
  });

  test('fails closed if a random source makes no progress possible', () => {
    assert.throws(
      () => generateBetterAuthSessionToken(() => new Uint8Array()),
      /random source returned no bytes/u,
    );
  });
});
