/**
 * FIX-L-049 trusted-ingress, key codec, and in-memory adapter contracts.
 * Redis and raw-HTTP host suites live in companion files.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DELIVERY_REQUEST_LIMIT_IP_MAX_DEFAULT,
  DELIVERY_REQUEST_LIMIT_IP_WINDOW_MS_DEFAULT,
  DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT,
  DELIVERY_REQUEST_LIMIT_TOKEN_WINDOW_MS_DEFAULT,
} from '../../../src/modules/attachments/index.js';
import {
  buildDeliveryRateLimitKey,
  createMemoryDeliveryRequestLimiter,
  deliveryRateLimitSubjectHmac,
  parseDeliveryRateLimitKey,
} from '../../../src/infrastructure/rate-limit/index.js';
import { loadDeliveryProcessConfig } from '../../../src/bootstrap/delivery-main.js';
import {
  ENVIRONMENT,
  KEY_PREFIX,
  KEY_SECRET,
  NOW_MS,
  TOKEN_A,
  TOKEN_B,
  WINDOW_MS,
  WINDOW_START,
  assertFailed,
  deliveryProcessEnv,
  keyFor,
} from '../../support/phase4a-l049-delivery-rate-limit.js';

describe('delivery trusted-ingress configuration', () => {
  test('production requires an explicit declaration and accepts empty peer-only mode', () => {
    assert.throws(
      () => loadDeliveryProcessConfig(deliveryProcessEnv({ NODE_ENV: 'production' })),
      /ATTACHMENTS_DELIVERY_TRUSTED_INGRESS.*explicitly declared/u,
    );

    const direct = loadDeliveryProcessConfig(deliveryProcessEnv({
      NODE_ENV: 'production',
      ATTACHMENTS_DELIVERY_TRUSTED_INGRESS: '',
    }));
    assert.equal(direct.trustedIngressDeclared, true);
    assert.deepEqual(direct.trustedIngress, []);
  });

  test('parses exact addresses/CIDRs and rejects malformed allowlist entries', () => {
    const proxied = loadDeliveryProcessConfig(deliveryProcessEnv({
      NODE_ENV: 'production',
      ATTACHMENTS_DELIVERY_TRUSTED_INGRESS: '10.0.0.0/8, 2001:db8::1, ::ffff:192.0.2.0/120',
    }));
    assert.deepEqual(proxied.trustedIngress, ['10.0.0.0/8', '2001:db8::1', '192.0.2.0/24']);

    assert.throws(
      () => loadDeliveryProcessConfig(deliveryProcessEnv({
        ATTACHMENTS_DELIVERY_TRUSTED_INGRESS: '10.0.0.0/33',
      })),
      /ATTACHMENTS_DELIVERY_TRUSTED_INGRESS/u,
    );
  });
});

describe('FIX-L-049 delivery request-limit key codec', () => {
  test('keys are canonical per-policy namespaces whose subject is a hash-tagged {dlv:<hmac>} digest', () => {
    for (const policy of ['ip', 'token'] as const) {
      const facts = policy === 'ip' ? '203.0.113.7' : TOKEN_A;
      const key = keyFor(policy, facts);
      const parsed = parseDeliveryRateLimitKey(key);
      assert.equal(parsed.kind, 'ok');
      if (parsed.kind !== 'ok') continue;
      assert.equal(parsed.parts.keyPrefix, KEY_PREFIX);
      assert.equal(parsed.parts.environment, ENVIRONMENT);
      assert.equal(parsed.parts.schemaVersion, 1);
      assert.equal(parsed.parts.policy, policy);
      assert.equal(parsed.parts.subjectHmac, deliveryRateLimitSubjectHmac(KEY_SECRET, policy, facts));
      assert.equal(parsed.parts.windowStartEpochMs, WINDOW_START);
      // Raw IPs and raw capability tokens (bearer secrets) never reach the key text.
      assert.equal(key.includes(facts), false, 'raw facts never reach the key text');
      assert.equal(key.includes('203.0.113.7'), false);
      assert.equal(key.includes('blob-1'), false);
      assert.equal(key.includes('sig-a'), false);
      assert.equal(key.includes(KEY_SECRET.toString('utf8')), false);
      assert.match(key, /^l049-unit:test:ratelimit:v1:\{dlv:[A-Za-z0-9_-]{32}\}:(ip|token):\d+$/u);
    }
    // The ip policy caps facts at 64 chars (IPs are <= 45), so namespace
    // separation is proven with a short fact valid under BOTH policies:
    // identical facts must still yield different keys per policy.
    const keys = new Set(['ip', 'token'].map((policy) => keyFor(policy, '203.0.113.7')));
    assert.equal(keys.size, 2, 'ip and token budgets are separate key namespaces');
  });

  test('the same subject+window is stable; a different window seed changes the key', () => {
    const facts = '198.51.100.4';
    assert.equal(keyFor('ip', facts), keyFor('ip', facts));
    assert.notEqual(keyFor('ip', facts), keyFor('ip', facts, WINDOW_START + WINDOW_MS));
    assert.notEqual(keyFor('ip', facts), keyFor('token', facts), 'policy is part of the namespace');
  });

  test('fail-closed subject validation: unknown policy, empty/oversized/control-character facts', () => {
    assert.throws(
      () => buildDeliveryRateLimitKey({
        keyPrefix: KEY_PREFIX, environment: ENVIRONMENT, keySecret: KEY_SECRET,
        policy: 'admin' as never, facts: '203.0.113.7', windowStartEpochMs: WINDOW_START,
      }),
      /policy/u,
    );
    assert.throws(() => deliveryRateLimitSubjectHmac(KEY_SECRET, 'token', ''), /facts/u);
    assert.throws(() => deliveryRateLimitSubjectHmac(KEY_SECRET, 'ip', 'x'.repeat(65)), /facts/u);
    assert.throws(() => deliveryRateLimitSubjectHmac(KEY_SECRET, 'ip', '203.0.113.7\n'), /control/u);
    assert.throws(() => keyFor('ip', '203.0.113.7', -1), /window/u);
    // I10 tokens are ~600 chars; the token ceiling admits them but stays bounded.
    assert.equal(deliveryRateLimitSubjectHmac(KEY_SECRET, 'token', 't'.repeat(1024)).length, 32);
    assert.throws(() => deliveryRateLimitSubjectHmac(KEY_SECRET, 'token', 't'.repeat(1025)), /facts/u);
  });

  test('the parser rejects non-canonical keys (raw facts can never pass as the subject segment)', () => {
    assert.equal(parseDeliveryRateLimitKey(keyFor('ip', '203.0.113.7')).kind, 'ok');
    assert.equal(parseDeliveryRateLimitKey(keyFor('ip', '203.0.113.7').replace('{dlv:', '{att:')).kind, 'rejected');
    assert.equal(parseDeliveryRateLimitKey(
      `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{dlv:${'a'.repeat(32)}}:admin:${WINDOW_START}`,
    ).kind, 'rejected', 'unknown policy token');
    assert.equal(parseDeliveryRateLimitKey(
      `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{dlv:203.0.113.7}:ip:${WINDOW_START}`,
    ).kind, 'rejected', 'raw facts in the subject segment are non-canonical');
    assert.equal(parseDeliveryRateLimitKey('').kind, 'rejected');
  });
});

// ---------------------------------------------------------------------------
// In-memory adapter (single-instance default)
// ---------------------------------------------------------------------------

describe('FIX-L-049 in-memory adapter', () => {
  function clock(): { readonly now: () => number; advance(ms: number): void } {
    let value = NOW_MS;
    return {
      now: () => value,
      advance(ms: number) {
        value += ms;
      },
    };
  }

  test('per-IP budget: allowed up to the cap, then denied with retry-after; distinct IPs are isolated; windows roll over', async () => {
    const c = clock();
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 2, windowMs: WINDOW_MS },
      token: { maxRequests: 10, windowMs: WINDOW_MS },
      now: c.now,
    });
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.10' })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.10' })).kind, 'allowed');
    const third = await limiter.consume({ policy: 'ip', facts: '198.51.100.10' });
    assert.equal(third.kind, 'denied');
    if (third.kind === 'denied') assert.ok(third.decision.retryAfterSeconds >= 1);
    // A different IP keeps its own budget.
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.11' })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.11' })).kind, 'allowed');
    // Window rollover resets the budget.
    c.advance(WINDOW_MS + 1);
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.10' })).kind, 'allowed');
  });

  test('per-token budget: one budget per token digest — method/Range never open extra buckets', async () => {
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 100, windowMs: WINDOW_MS },
      token: { maxRequests: 2, windowMs: WINDOW_MS },
    });
    // The route keys the token bucket on the token ONLY (GET/HEAD share the
    // budget and Range is never a separate subject), so three attempts of the
    // same token exhaust the shared budget regardless of any method/range.
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'denied');
    // A different token has its own budget.
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_B })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_B })).kind, 'allowed');
  });

  test('ip and token budgets never share counters', async () => {
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 1, windowMs: WINDOW_MS },
      token: { maxRequests: 10, windowMs: WINDOW_MS },
    });
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.20' })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.20' })).kind, 'denied');
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'allowed');
  });

  test('an unconfigured policy fails closed instead of allowing', async () => {
    const limiter = createMemoryDeliveryRequestLimiter({ ip: { maxRequests: 2, windowMs: WINDOW_MS } });
    assertFailed(await limiter.consume({ policy: 'token', facts: TOKEN_A }), 'internal', 'rate_limit_policy_unconfigured');
  });

  test('invalid subjects fail closed with an internal failure', async () => {
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 2, windowMs: WINDOW_MS },
      token: { maxRequests: 2, windowMs: WINDOW_MS },
    });
    assertFailed(await limiter.consume({ policy: 'token', facts: '' }), 'internal', 'rate_limit_invalid_input');
    assertFailed(await limiter.consume({ policy: 'token', facts: 'x'.repeat(1025) }), 'internal', 'rate_limit_invalid_input');
  });

  test('bounded buckets: at capacity a NEW subject is denied while live budgets are preserved', async () => {
    const limiter = createMemoryDeliveryRequestLimiter({
      ip: { maxRequests: 1, windowMs: 3_600_000 },
      token: { maxRequests: 1, windowMs: 3_600_000 },
      maxBuckets: 1,
      sweepIntervalMs: 60_000,
      now: () => NOW_MS,
    });
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.30' })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: '198.51.100.30' })).kind, 'denied', 'the live bucket keeps its exhausted budget');
    const overloaded = await limiter.consume({ policy: 'ip', facts: '198.51.100.31' });
    assert.equal(overloaded.kind, 'denied', 'a new key at capacity is denied, never evicting a live bucket');
    if (overloaded.kind === 'denied') assert.ok(overloaded.decision.retryAfterSeconds >= 1);
    // The token namespace is a separate bounded map.
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'denied');
  });

  test('the default budgets are generous enough for legitimate short-term downloads', async () => {
    assert.equal(DELIVERY_REQUEST_LIMIT_IP_MAX_DEFAULT, 600);
    assert.equal(DELIVERY_REQUEST_LIMIT_IP_WINDOW_MS_DEFAULT, 60_000);
    assert.equal(DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT, 120);
    assert.equal(DELIVERY_REQUEST_LIMIT_TOKEN_WINDOW_MS_DEFAULT, 60_000);
    const limiter = createMemoryDeliveryRequestLimiter();
    for (let i = 0; i < DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT; i += 1) {
      assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'allowed', `attempt ${i + 1}`);
    }
    assert.equal((await limiter.consume({ policy: 'token', facts: TOKEN_A })).kind, 'denied');
  });
});

