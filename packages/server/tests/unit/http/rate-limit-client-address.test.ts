import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { test } from 'vitest';
import { createMemoryAuthRateLimiter, rateLimitClientKey } from '../../../src/transport/http-security.js';
import { authRateLimitSubjectHmac } from '../../../src/infrastructure/rate-limit/auth-rate-limit-key-codec.js';
import { rateLimitClientIp } from '../../../src/infrastructure/rate-limit/index.js';

test('rotating IPv6 host addresses cannot bypass auth quotas or fill the memory key cap', async () => {
  const limiter = createMemoryAuthRateLimiter({ maxRequests: 1, windowMs: 60_000, maxBuckets: 2 });
  for (let host = 1; host <= 256; host += 1) {
    const outcome = await limiter.consume({ routeFamily: 'sign-in', clientIp: `2001:db8:1234:5678::${host.toString(16)}` });
    assert.equal(outcome.kind, host === 1 ? 'allowed' : 'denied');
  }
  assert.equal(limiter.size(), 1);
  assert.equal(limiter.capacityRejections(), 0);
  assert.equal((await limiter.consume({ routeFamily: 'sign-in', clientIp: '198.51.100.10' })).kind, 'allowed');
});

test('HTTP and Redis auth subjects use the same IPv6 prefix and IPv4-mapped identity', () => {
  const key = (ip: string) => rateLimitClientKey({ ip } as FastifyRequest, '/auth');
  const secret = Buffer.alloc(32, 1);
  const variants = ['2001:db8:1234:5678::1', '2001:0DB8:1234:5678:0000:0000:0000:ffff'];
  assert.equal(key(variants[0]!), key(variants[1]!));
  assert.equal(authRateLimitSubjectHmac(secret, variants[0]!), authRateLimitSubjectHmac(secret, variants[1]!));
  assert.notEqual(key(variants[0]!), key('2001:db8:1234:5679::1'));
  assert.equal(key('::ffff:192.0.2.1'), key('192.0.2.1'));
  assert.equal(key('::ffff:c000:201'), key('192.0.2.1'));
  assert.equal(authRateLimitSubjectHmac(secret, '::ffff:c000:201'), authRateLimitSubjectHmac(secret, '192.0.2.1'));
  assert.notEqual(key('192.0.2.1'), key('192.0.2.2'));
});

test('client prefix keys are idempotent across zero compression, brackets and interface zones', () => {
  for (const address of ['::1', '0:0:0:0:0:0:0:1', '2001:db8::ffff', '[2001:db8::1]', 'fe80::1%eth0']) {
    const key = rateLimitClientIp(address);
    assert.equal(rateLimitClientIp(key), key);
  }
  assert.equal(rateLimitClientIp('[2001:db8::1]'), rateLimitClientIp('2001:0db8:0:0::ffff'));
  assert.equal(rateLimitClientIp(undefined), 'unknown');
});
