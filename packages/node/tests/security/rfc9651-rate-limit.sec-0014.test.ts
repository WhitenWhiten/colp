import { describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_RATE_LIMIT_CREDENTIAL_KEY,
  enforceRateLimit,
  serializeRateLimitFields,
} from '../../src/security/index.js';
import type {
  AtomicRateLimitCeilingResult,
  AtomicRateLimitCharge,
  AtomicRateLimitPort,
  AtomicRateLimitRequest,
  AtomicRateLimitResult,
  RateLimitDimension,
  RateLimitFields,
} from '../../src/security/index.js';

function request(overrides: Partial<AtomicRateLimitRequest> = {}): AtomicRateLimitRequest {
  return {
    bucket: 'publisher:authenticated-read',
    cost: 1,
    credentialId: 'credential-42',
    ipAddress: '203.0.113.7',
    instanceId: 'instance-1',
    ceilings: {
      credential: { policy: 'publisher:authenticated-read', limit: 10, windowSeconds: 60 },
      ip: { policy: 'publisher:authenticated-read', limit: 100, windowSeconds: 60 },
      instance: { policy: 'publisher:authenticated-read', limit: 1000, windowSeconds: 300 },
    },
    ...overrides,
  };
}

function resultsFor(
  charge: AtomicRateLimitCharge,
  overrides: Partial<Record<RateLimitDimension, Partial<AtomicRateLimitCeilingResult>>> = {},
): readonly AtomicRateLimitCeilingResult[] {
  return charge.ceilings.map((ceiling) => ({
    dimension: ceiling.dimension,
    key: ceiling.key,
    allowed: true,
    remaining: ceiling.limit - 1,
    resetSeconds: 20,
    ...overrides[ceiling.dimension],
  }));
}

function portWith(
  respond: (charge: AtomicRateLimitCharge) => AtomicRateLimitResult | Promise<AtomicRateLimitResult>,
): AtomicRateLimitPort & { charge: ReturnType<typeof vi.fn> } {
  return { charge: vi.fn(async (input: AtomicRateLimitCharge) => respond(input)) };
}

function headersOf(decision: Awaited<ReturnType<typeof enforceRateLimit>>): Readonly<Record<string, string>> {
  if (!('headers' in decision)) throw new Error('expected serialized headers');
  return decision.headers;
}

describe('SEC-0014 RFC 9651 publisher rate-limit headers', () => {
  it('[evidence:security.rfc9651-rate-limit] emits strict RateLimit and RateLimit-Policy headers for success', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge, { credential: { remaining: 4, resetSeconds: 9 } }) }));
    const decision = await enforceRateLimit(port, request());
    expect(decision.allowed).toBe(true);
    expect(headersOf(decision)).toEqual({
      RateLimit: '"publisher:authenticated-read";r=4;t=9',
      'RateLimit-Policy': '"publisher:authenticated-read";q=10;w=60',
    });
  });

  it('[evidence:security.rfc9651-rate-limit] emits strict headers for limited responses and uses governing reset for retry', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { allowed: false, remaining: 0, resetSeconds: 7 },
        ip: { allowed: false, remaining: 2, resetSeconds: 31 },
      }),
    }));
    const decision = await enforceRateLimit(port, request());
    expect(decision).toMatchObject({ allowed: false, reason: 'limited', retryAfterSeconds: 31 });
    expect(headersOf(decision)).toEqual({
      RateLimit: '"publisher:authenticated-read";r=2;t=31',
      'RateLimit-Policy': '"publisher:authenticated-read";q=100;w=60',
    });
  });

  it('[evidence:security.rfc9651-rate-limit] quotes and escapes policy exactly as an RFC 9651 string', () => {
    expect(serializeRateLimitFields({ policy: 'publisher:"tier\\gold"', limit: 10, remaining: 8, resetSeconds: 2, windowSeconds: 60 })).toEqual({
      RateLimit: '"publisher:\\"tier\\\\gold\\\"";r=8;t=2',
      'RateLimit-Policy': '"publisher:\\"tier\\\\gold\\\"";q=10;w=60',
    });
  });

  it('[evidence:security.rfc9651-rate-limit] accepts positive q and w and non-negative r and t boundaries', () => {
    expect(serializeRateLimitFields({ policy: 'p', limit: 1, remaining: 0, resetSeconds: 0, windowSeconds: 1 })).toEqual({
      RateLimit: '"p";r=0;t=0',
      'RateLimit-Policy': '"p";q=1;w=1',
    });
    expect(serializeRateLimitFields({ policy: 'p', limit: 999_999_999_999_999, remaining: 999_999_999_999_999, resetSeconds: 999_999_999_999_999, windowSeconds: 999_999_999_999_999 })).toBeTruthy();
  });

  it('[evidence:security.rfc9651-rate-limit] rejects remaining greater than limit', () => {
    expect(() => serializeRateLimitFields({ policy: 'p', limit: 1, remaining: 2, resetSeconds: 0, windowSeconds: 1 })).toThrow(/remaining must not exceed limit/u);
  });

  it('[evidence:security.rfc9651-rate-limit] rejects CRLF, controls, and non-ASCII policy strings', () => {
    for (const policy of ['p\r\nX-Evil: yes', 'p\u0000', 'p\u007f', 'p\u00e9']) {
      expect(() => serializeRateLimitFields({ policy, limit: 1, remaining: 0, resetSeconds: 0, windowSeconds: 1 })).toThrow(TypeError);
    }
  });

  it('[evidence:security.rfc9651-rate-limit] rejects invalid structured-string quoting and header injection attempts', () => {
    for (const policy of ['"already-quoted"', 'p\nRateLimit: evil', 'p\tq=1']) {
      expect(() => serializeRateLimitFields({ policy, limit: 1, remaining: 0, resetSeconds: 0, windowSeconds: 1 })).toThrow(TypeError);
    }
  });

  it('[evidence:security.rfc9651-rate-limit] rejects NaN, Infinity, fractions, unsafe, and negative numeric fields', () => {
    const valid: RateLimitFields = { policy: 'p', limit: 1, remaining: 0, resetSeconds: 0, windowSeconds: 1 };
    for (const field of ['limit', 'remaining', 'resetSeconds', 'windowSeconds'] as const) {
      for (const value of [Number.NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
        expect(() => serializeRateLimitFields({ ...valid, [field]: value })).toThrow(TypeError);
      }
    }
  });

  it('[evidence:security.rfc9651-rate-limit] never emits legacy RateLimit-Limit, Remaining, Reset, or X-RateLimit headers', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const decision = await enforceRateLimit(port, request());
    expect(Object.keys(headersOf(decision))).toEqual(['RateLimit', 'RateLimit-Policy']);
    expect(Object.keys(headersOf(decision)).some((key) => /(?:^|X-)RateLimit-(?:Limit|Remaining|Reset)$/u.test(key))).toBe(false);
  });

  it('[evidence:security.rfc9651-rate-limit] freezes headers and the decision snapshot', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const decision = await enforceRateLimit(port, request());
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(headersOf(decision))).toBe(true);
    expect(() => ((headersOf(decision) as Record<string, string>).RateLimit = 'tampered')).toThrow(TypeError);
  });

  it('[evidence:security.rfc9651-rate-limit] excludes credentials, IPs, instance ids, and secret keys from headers', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const decision = await enforceRateLimit(port, request({ credentialId: 'secret-key-123' }));
    expect(JSON.stringify(headersOf(decision))).not.toMatch(/secret-key|203\.0\.113\.7|instance-1|credential:id/u);
  });

  it('[evidence:security.rfc9651-rate-limit] emits anonymous bucket names only in the structured policy', async () => {
    const { credentialId: _credentialId, ...anonymous } = request({ bucket: 'publisher:anonymous-feed-read', ceilings: {
      credential: { policy: 'publisher:anonymous-feed-read', limit: 10, windowSeconds: 60 },
      ip: { policy: 'publisher:anonymous-feed-read', limit: 100, windowSeconds: 60 },
      instance: { policy: 'publisher:anonymous-feed-read', limit: 1000, windowSeconds: 300 },
    } });
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const decision = await enforceRateLimit(port, anonymous);
    expect((port.charge.mock.calls[0]?.[0] as AtomicRateLimitCharge).ceilings[0]?.key).toBe(PUBLIC_RATE_LIMIT_CREDENTIAL_KEY);
    expect(headersOf(decision)['RateLimit-Policy']).toBe('"publisher:anonymous-feed-read";q=10;w=60');
  });

  it('[evidence:security.rfc9651-rate-limit] emits authenticated bucket names only in the structured policy', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const decision = await enforceRateLimit(port, request({ bucket: 'publisher:authenticated-read' }));
    expect(headersOf(decision)['RateLimit-Policy']).toBe('"publisher:authenticated-read";q=10;w=60');
    expect(headersOf(decision).RateLimit).not.toContain('credential:id:credential-42');
  });

  it('[evidence:security.rfc9651-rate-limit] returns invalid_result without success headers when the atomic port throws', async () => {
    const port = { charge: vi.fn(async () => { throw new Error('port down'); }) } satisfies AtomicRateLimitPort;
    const decision = await enforceRateLimit(port, request());
    expect(decision).toEqual({ allowed: false, reason: 'invalid_result', ceilings: [] });
    expect(decision).not.toHaveProperty('headers');
  });

  it('[evidence:security.rfc9651-rate-limit] returns invalid_result without headers for partial atomic results', async () => {
    const port = { charge: vi.fn(async () => ({ ceilings: [] } as unknown as AtomicRateLimitResult)) } satisfies AtomicRateLimitPort;
    const decision = await enforceRateLimit(port, request());
    expect(decision).toEqual({ allowed: false, reason: 'invalid_result', ceilings: [] });
    expect(decision).not.toHaveProperty('headers');
  });

  it('[evidence:security.rfc9651-rate-limit] rejects malformed numeric port results closed before serialization', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge, { credential: { remaining: Number.NaN } }) }));
    const decision = await enforceRateLimit(port, request());
    expect(decision).toEqual({ allowed: false, reason: 'invalid_result', ceilings: [] });
    expect(decision).not.toHaveProperty('headers');
  });

  it('[evidence:security.rfc9651-rate-limit] preserves governing reset and remaining in a limited response', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge, { instance: { allowed: false, remaining: 3, resetSeconds: 42 } }) }));
    const decision = await enforceRateLimit(port, request());
    expect(decision).toMatchObject({ allowed: false, reason: 'limited', governing: { dimension: 'instance', remaining: 3, resetSeconds: 42 }, retryAfterSeconds: 42 });
    expect(headersOf(decision)).toEqual({ RateLimit: '"publisher:authenticated-read";r=3;t=42', 'RateLimit-Policy': '"publisher:authenticated-read";q=1000;w=300' });
  });
});
