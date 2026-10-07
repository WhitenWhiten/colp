import { describe, expect, test } from 'vitest';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createProductBurstRateLimiter } from '../../../src/transport/product-burst-rate-limit.js';
import { compareCreditInstants, validCreditInstant } from '../../../src/transport/product/credit-ledger-time.js';
import { createCreditLedgerCursorCodec } from '../../../src/modules/identity/index.js';

describe('credit read boundaries', () => {
  test('shared bucket storage cannot double count sustained and burst at aligned windows', async () => {
    const storage = createFixedWindowRateLimiter({ maxRequests: 10, windowMs: 60_000 });
    const limiter = createProductBurstRateLimiter(storage, storage, 'credits-read');
    for (let index = 0; index < 10; index++) expect((await limiter.consume('account')).kind).toBe('allowed');
    expect((await limiter.consume('account')).kind).toBe('denied');
  });

  test('validates calendar dates and compares fractions without dropping microseconds', () => {
    expect(validCreditInstant('2024-02-29T23:59:59.123456+09:00')).toBe(true);
    expect(validCreditInstant('2026-02-29T00:00:00Z')).toBe(false);
    expect(compareCreditInstants('2026-01-01T09:00:00.123456+09:00', '2026-01-01T00:00:00.123457Z')).toBe(-1);
    expect(compareCreditInstants('2026-01-01T00:00:00.1Z', '2026-01-01T00:00:00.100000Z')).toBe(0);
  });

  test('rejects signed impossible snapshots before they can reach SQL', () => {
    const codec = createCreditLedgerCursorCodec({ active: { id: 'test', secret: Buffer.alloc(32, 8).toString('base64') }, retained: [] });
    const payload = { version: 1 as const, accountId: 'account', filters: { kind: null, from: null, to: null, chargeId: null, runId: null }, limit: 20,
      asOf: '2026-09-19T00:00:00.000Z', highSequence: '2', beforeSequence: '1',
      balance: { available: 1, reserved: 0, expiringPoints: 0, nextExpiryAt: null },
      issuedAt: '2026-09-19T00:00:00.000Z', expiresAt: '2026-09-20T00:00:00.000Z' };
    for (const invalid of [{ ...payload, beforeSequence: '3' }, { ...payload, highSequence: '9223372036854775808' },
      { ...payload, asOf: '2026-02-30T00:00:00.000Z' }, { ...payload, balance: { ...payload.balance, available: 2147483648 } }]) {
      expect(() => codec.verify(codec.sign(invalid), new Date())).toThrow('invalid_cursor');
    }
  });
});
