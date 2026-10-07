/**
 * FIX-L-049 delivery host request-level limiting over raw HTTP.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createMemoryDeliveryRequestLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { issueCapability, plainBytes } from '../../support/phase4a-i11-test-helpers.js';
import {
  objectWith,
  rawGet,
  startLimiterHarness,
  stopLimiterHarness,
} from '../../support/phase4a-l049-delivery-rate-limit.js';

describe('FIX-L-049 delivery host request-level limiting over raw HTTP', () => {
  test('a token over budget returns the FIXED zero-body 429 and DB/R2 call counts stop increasing', async () => {
    const object = objectWith('aa', plainBytes('l049 replay payload\n'));
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 100, windowMs: 60_000 },
      token: { maxRequests: 3, windowMs: 60_000 },
    });
    const harness = await startLimiterHarness({ limiter, objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const url = `${harness.origin}/d/${token}`;

      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(url);
        assert.equal(response.status, 200, `attempt ${i + 1} must be served`);
      }
      assert.equal(harness.resolveCalls(), 3);
      assert.equal(harness.store.headCalls, 3);
      assert.equal(harness.store.readCalls, 3);

      const denied = await fetch(url);
      assert.equal(denied.status, 429, 'over-budget replay is a fixed 429');
      assert.equal(await denied.text(), '', '429 is zero-body');
      assert.equal(denied.headers.get('cache-control'), 'private,no-store');
      assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(denied.headers.get('retry-after') !== null, '429 carries the standard Retry-After hint');
      assert.equal(denied.headers.get('set-cookie'), null);

      // The over-limit request must not have touched the DB resolver or R2.
      assert.equal(harness.resolveCalls(), 3, 'DB resolver calls must not increase after over-limit');
      assert.equal(harness.store.headCalls, 3, 'R2 HEAD calls must not increase after over-limit');
      assert.equal(harness.store.readCalls, 3, 'R2 GET calls must not increase after over-limit');

      // The fixed-class request log records the 429 with zero bytes and never the token.
      const limited = harness.host.requestLog.filter((entry) => entry.status === 429);
      assert.ok(limited.length >= 1, 'the request log records the 429');
      assert.ok(limited.every((entry) => entry.byteCount === 0));
      assert.ok(!JSON.stringify(harness.host.requestLog).includes(token), 'the capability token never appears in the log');
    } finally {
      await stopLimiterHarness(harness);
    }
  });

  test('HEAD and GET share one token budget; Range consumes the same bucket and never opens a new one', async () => {
    const object = objectWith('ab', plainBytes('0123456789'));
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 100, windowMs: 60_000 },
      token: { maxRequests: 3, windowMs: 60_000 },
    });
    const harness = await startLimiterHarness({ limiter, objects: [object] });
    try {
      const token = issueCapability(harness.signer, object);
      const base = `${harness.origin}/d/${token}`;
      assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(base, { headers: { range: 'bytes=0-3' } })).status, 206, 'Range stays inside the SAME token budget');
      const denied = await fetch(base);
      assert.equal(denied.status, 429, 'the shared budget is exhausted by HEAD+HEAD+Range');
      assert.equal(await denied.text(), '');
    } finally {
      await stopLimiterHarness(harness);
    }
  });

  test('different tokens are isolated: exhausting token A never affects token B', async () => {
    const objectA = objectWith('ac', plainBytes('l049 principal-a bytes\n'));
    const objectB = objectWith('ad', plainBytes('l049 principal-b bytes\n'));
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 100, windowMs: 60_000 },
      token: { maxRequests: 2, windowMs: 60_000 },
    });
    const harness = await startLimiterHarness({ limiter, objects: [objectA, objectB] });
    try {
      const tokenA = issueCapability(harness.signer, objectA);
      const tokenB = issueCapability(harness.signer, objectB);
      assert.equal((await fetch(`${harness.origin}/d/${tokenA}`)).status, 200);
      assert.equal((await fetch(`${harness.origin}/d/${tokenA}`)).status, 200);
      assert.equal((await fetch(`${harness.origin}/d/${tokenA}`)).status, 429, 'token A is exhausted');
      assert.equal((await fetch(`${harness.origin}/d/${tokenB}`)).status, 200, 'token B keeps its own budget');
      assert.equal((await fetch(`${harness.origin}/d/${tokenB}`)).status, 200);
    } finally {
      await stopLimiterHarness(harness);
    }
  });

  test('different client IPs are isolated: exhausting IP A never affects IP B (loopback source binding)', async () => {
    const object = objectWith('ae', plainBytes('l049 ip isolation payload\n'));
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 2, windowMs: 60_000 },
      token: { maxRequests: 20, windowMs: 60_000 },
    });
    const harness = await startLimiterHarness({ limiter, objects: [object], hostname: '127.0.0.1' });
    try {
      const token = issueCapability(harness.signer, object);
      const path = `/d/${token}`;

      const ipA = (): Promise<{ status: number; body: string }> => rawGet(harness.origin, path, '127.0.0.1');
      const ipB = (): Promise<{ status: number; body: string }> => rawGet(harness.origin, path, '127.0.0.3');

      assert.equal((await ipA()).status, 200);
      assert.equal((await ipA()).status, 200);
      assert.equal((await ipA()).status, 429, 'IP A is exhausted');
      assert.equal((await ipB()).status, 200, 'IP B keeps its own budget');
      assert.equal((await ipB()).status, 200);
      assert.equal((await ipB()).status, 429, 'IP B is exhausted after its own budget');
      assert.equal((await ipA()).status, 429, 'IP A stays exhausted');
    } finally {
      await stopLimiterHarness(harness);
    }
  });

  test('trusted CDN/LB peers key forwarded clients separately; untrusted peers cannot spoof fresh buckets', async () => {
    const object = objectWith('ag', plainBytes('l049 trusted ingress payload\n'));

    const trustedLimiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 1, windowMs: 60_000 },
      token: { maxRequests: 20, windowMs: 60_000 },
    });
    const trusted = await startLimiterHarness({
      limiter: trustedLimiter,
      objects: [object],
      hostname: '127.0.0.1',
      trustedIngress: ['127.0.0.0/8'],
    });
    try {
      const path = `/d/${issueCapability(trusted.signer, object)}`;
      const throughProxy = (clientIp: string) => rawGet(
        trusted.origin,
        path,
        '127.0.0.3',
        { 'x-forwarded-for': clientIp },
      );
      assert.equal((await throughProxy('203.0.113.10')).status, 200);
      assert.equal((await throughProxy('203.0.113.10')).status, 429, 'client A exhausts only its forwarded-IP bucket');
      assert.equal((await throughProxy('198.51.100.20')).status, 200, 'client B behind the same proxy has a distinct bucket');
    } finally {
      await stopLimiterHarness(trusted);
    }

    const untrustedLimiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 1, windowMs: 60_000 },
      token: { maxRequests: 20, windowMs: 60_000 },
    });
    const untrusted = await startLimiterHarness({
      limiter: untrustedLimiter,
      objects: [object],
      hostname: '127.0.0.1',
      trustedIngress: ['127.0.0.4'],
    });
    try {
      const path = `/d/${issueCapability(untrusted.signer, object)}`;
      const spoofed = (claimedIp: string) => rawGet(
        untrusted.origin,
        path,
        '127.0.0.3',
        { 'x-forwarded-for': claimedIp },
      );
      assert.equal((await spoofed('203.0.113.10')).status, 200);
      assert.equal(
        (await spoofed('198.51.100.20')).status,
        429,
        'different spoofed headers still share the untrusted socket peer bucket',
      );
    } finally {
      await stopLimiterHarness(untrusted);
    }
  });

  test('invalid/expired tokens keep zero-body 404 concealment while the IP bucket bounds the flood', async () => {
    const object = objectWith('af', plainBytes('l049 concealment payload\n'));
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 3, windowMs: 60_000 },
      token: { maxRequests: 100, windowMs: 60_000 },
    });
    const harness = await startLimiterHarness({ limiter, objects: [object] });
    try {
      const expired = issueCapability(harness.signer, object, {
        ttlSeconds: 60,
        now: new Date(Date.now() - 61_000),
      });
      for (const path of [`/d/${expired}`, '/d/v1.garbage', `/d/${expired}`]) {
        const response = await fetch(`${harness.origin}${path}`);
        assert.equal(response.status, 404, 'invalid/expired tokens keep the existence-hidden 404 while under the budget');
        assert.equal(await response.text(), '', '404 stays zero-body');
        assert.equal(response.headers.get('cache-control'), 'private,no-store');
      }
      assert.equal(harness.resolveCalls(), 0, 'invalid/expired floods never reach the DB resolver');
      assert.equal(harness.store.headCalls, 0, 'invalid/expired floods never reach R2');

      const overBudget = await fetch(`${harness.origin}/d/v1.also-garbage`);
      assert.equal(overBudget.status, 429, 'the IP flood is bounded by the fixed 429 once the IP budget is exhausted');
      assert.equal(await overBudget.text(), '');
      assert.equal(harness.resolveCalls(), 0);
      assert.equal(harness.store.headCalls, 0);
    } finally {
      await stopLimiterHarness(harness);
    }
  });
});
