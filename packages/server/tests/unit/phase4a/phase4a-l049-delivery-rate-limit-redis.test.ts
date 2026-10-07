/**
 * FIX-L-049 Redis adapter (shared multi-replica) over a scripted client.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseDeliveryRateLimitKey } from '../../../src/infrastructure/rate-limit/index.js';
import {
  TOKEN_A,
  WINDOW_START,
  FakeRateLimitClient,
  assertFailed,
  makeRedisStore,
  replyError,
} from '../../support/phase4a-l049-delivery-rate-limit.js';

describe('FIX-L-049 Redis adapter (shared multi-replica)', () => {
  test('allowed/denied decisions map from the frozen Lua reply with per-policy budgets and codec keys', async () => {
    const fake = new FakeRateLimitClient();
    const store = makeRedisStore(fake, { ipMax: 2, tokenMax: 5 });
    const ipOutcome = await store.consume({ policy: 'ip', facts: '198.51.100.40' });
    assert.equal(ipOutcome.kind, 'allowed');
    const tokenOutcome = await store.consume({ policy: 'token', facts: TOKEN_A });
    assert.equal(tokenOutcome.kind, 'allowed');

    const evalshaCalls = fake.calls.filter((call) => call.kind === 'evalsha');
    assert.equal(evalshaCalls.length, 2);
    // KEYS[1] is the codec key: per-policy namespace, HMAC subject, seeded window.
    const ipKey = String(evalshaCalls[0]!.args[2]);
    const tokenKey = String(evalshaCalls[1]!.args[2]);
    assert.equal(parseDeliveryRateLimitKey(ipKey).kind, 'ok');
    assert.equal(parseDeliveryRateLimitKey(tokenKey).kind, 'ok');
    assert.equal(ipKey.includes('198.51.100.40'), false, 'the raw IP never reaches the Redis key');
    assert.equal(tokenKey.includes(TOKEN_A), false, 'the raw token never reaches the Redis key');
    // Per-policy budgets flow as ARGV[1] (key is KEYS[1]).
    assert.equal(evalshaCalls[0]!.args[3], 2);
    assert.equal(evalshaCalls[1]!.args[3], 5);

    // A denied reply passes the retry-after through as a quota decision (never a failure).
    fake.evalshaImpl = async (_sha, args) => {
      const rateMax = Number(args[1]);
      return [0, rateMax + 1, 0, 37, WINDOW_START];
    };
    const denied = await store.consume({ policy: 'ip', facts: '198.51.100.40' });
    assert.equal(denied.kind, 'denied');
    if (denied.kind === 'denied') assert.equal(denied.decision.retryAfterSeconds, 37);
  });

  test('Redis failures map to stable failure classes and the circuit opens after the threshold', async () => {
    const fake = new FakeRateLimitClient();
    fake.evalshaImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    };
    const store = makeRedisStore(fake, { failureThreshold: 1, cooldownMs: 60_000 });
    assertFailed(await store.consume({ policy: 'ip', facts: '198.51.100.41' }), 'unavailable', 'rate_limit_unavailable');
    assertFailed(await store.consume({ policy: 'ip', facts: '198.51.100.41' }), 'unavailable', 'rate_limit_circuit_open');
  });

  test('a malformed script reply is protocol corruption: failed malformed, never a decision', async () => {
    const fake = new FakeRateLimitClient();
    fake.evalshaImpl = async () => [1, 1, 9_999, 60, WINDOW_START];
    const store = makeRedisStore(fake);
    assertFailed(await store.consume({ policy: 'ip', facts: '198.51.100.42' }), 'malformed', 'rate_limit_malformed_reply');
  });

  test('NOSCRIPT reloads the frozen script exactly once and retries exactly once', async () => {
    const fake = new FakeRateLimitClient();
    let evalshaCalls = 0;
    fake.evalshaImpl = async (_sha, args) => {
      evalshaCalls += 1;
      if (evalshaCalls === 1) throw replyError('NOSCRIPT No matching script. Please use EVAL.');
      const rateMax = Number(args[1]);
      return [1, 1, Math.max(0, rateMax - 1), 60, WINDOW_START];
    };
    const store = makeRedisStore(fake);
    assert.equal((await store.consume({ policy: 'ip', facts: '198.51.100.43' })).kind, 'allowed');
    assert.equal(evalshaCalls, 2, 'the retry is issued exactly once');
    assert.equal(fake.calls.filter((call) => call.kind === 'script_load').length, 2, 'the script is reloaded once');
  });

  test('close is idempotent and a closed store fails closed', async () => {
    const fake = new FakeRateLimitClient();
    const store = makeRedisStore(fake);
    await store.close();
    await store.close();
    assertFailed(await store.consume({ policy: 'ip', facts: '198.51.100.44' }), 'unavailable', 'rate_limit_store_closed');
  });
});

