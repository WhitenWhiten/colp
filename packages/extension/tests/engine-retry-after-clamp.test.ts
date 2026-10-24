import assert from 'node:assert/strict';
import { test } from 'vitest';
import { retryAfterMilliseconds } from '../src/durable-sync-engine-errors.js';

/**
 * W2B-P3-7: the Session route may ask a client to wait up to an hour. The engine used to drop a wait longer than five
 * minutes and fall back to its own short backoff, so a rate-limited server was asked again every few seconds.
 */
const asking = (retryAfterMilliseconds: unknown) => ({ code: 'rate_limited', retryAfterMilliseconds });

test('a wait of up to five minutes is honoured as asked', () => {
  assert.equal(retryAfterMilliseconds(asking(1_000)), 1_000);
  assert.equal(retryAfterMilliseconds(asking(90_000)), 90_000);
  assert.equal(retryAfterMilliseconds(asking(300_000)), 300_000);
});

test('a longer wait is honoured as five minutes instead of being dropped', () => {
  assert.equal(retryAfterMilliseconds(asking(301_000)), 300_000);
  assert.equal(retryAfterMilliseconds(asking(3_600_000)), 300_000);
});

test('no usable wait is no wait', () => {
  for (const value of [undefined, 0, 999, -5, 1_500.5, Number.NaN, '60000', null]) {
    assert.equal(retryAfterMilliseconds(asking(value)), undefined, String(value));
  }
  assert.equal(retryAfterMilliseconds(new Error('rate_limited')), undefined);
});
