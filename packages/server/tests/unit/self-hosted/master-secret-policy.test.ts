import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applySelfHostedPreset, SECRET_NAMES } from '../../../src/bootstrap/self-hosted-preset.js';

describe('master secret admission before key derivation', () => {
  test.each([
    'a'.repeat(43), Buffer.alloc(48).toString('base64'), Buffer.alloc(48, 9).toString('base64'),
    Buffer.from('password'.repeat(8)).toString('base64'), '0123456789abcdef'.repeat(4),
    Buffer.from(Array.from({ length: 48 }, (_, index) => index)).toString('base64'),
    'example-master-key!'.repeat(4),
  ])('rejects predictable decoded or UTF-8 material without logging it', secret => {
    const env = { COLP_SERVER_ORIGIN: 'https://colp.test', COLP_SERVER_SECRET: secret };
    let failure: unknown;
    try { applySelfHostedPreset(env); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/cryptographically random.*openssl rand/u);
    expect((failure as Error).message).not.toContain(secret);
    for (const name of SECRET_NAMES) expect(env).not.toHaveProperty(name);
  });

  test.each([32, 48, 64])('accepts generated %i-byte material and keeps derived keys stable', length => {
    const secret = randomBytes(length).toString('base64');
    const left: NodeJS.ProcessEnv = { COLP_SERVER_ORIGIN: 'https://colp.test', COLP_SERVER_SECRET: secret };
    const right = { ...left }; applySelfHostedPreset(left); applySelfHostedPreset(right);
    for (const name of SECRET_NAMES) expect(left[name]).toEqual(right[name]);
  });
});
