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
    bucket: 'publisher:general-write',
    cost: 3,
    credentialId: 'key-42',
    ipAddress: '203.0.113.7',
    instanceId: 'instance-1',
    ceilings: {
      credential: { policy: 'write:credential', limit: 10, windowSeconds: 60 },
      ip: { policy: 'write:ip', limit: 100, windowSeconds: 60 },
      instance: { policy: 'write:instance', limit: 1_000, windowSeconds: 300 },
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
) {
  const charge = vi.fn(
    async (input: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> => respond(input),
  );
  return { charge } satisfies AtomicRateLimitPort;
}

/** Typed first-call capture — avoids untyped mock.calls indexing. */
function firstCharge(port: ReturnType<typeof portWith>): AtomicRateLimitCharge {
  const charge = port.charge.mock.calls[0]?.[0];
  if (charge === undefined) {
    throw new Error('expected enforceRateLimit to invoke charge at least once');
  }
  return charge;
}

describe('[evidence:security.rate-limit] SEC-0004 composite rate limiting', () => {
  it('[evidence:security.rate-limit] charges authenticated credential, IP, and instance ceilings once and atomically', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { remaining: 4, resetSeconds: 9 },
        ip: { remaining: 50, resetSeconds: 12 },
        instance: { remaining: 500, resetSeconds: 18 },
      }),
    }));

    const decision = await enforceRateLimit(port, request());

    expect(port.charge).toHaveBeenCalledOnce();
    expect(port.charge).toHaveBeenCalledWith({
      bucket: 'publisher:general-write',
      cost: 3,
      ceilings: [
        {
          dimension: 'credential',
          key: 'credential:id:key-42',
          policy: 'write:credential',
          limit: 10,
          windowSeconds: 60,
        },
        {
          dimension: 'ip',
          key: 'ip:203.0.113.7',
          policy: 'write:ip',
          limit: 100,
          windowSeconds: 60,
        },
        {
          dimension: 'instance',
          key: 'instance:instance-1',
          policy: 'write:instance',
          limit: 1_000,
          windowSeconds: 300,
        },
      ],
    });
    expect(decision).toMatchObject({
      allowed: true,
      reason: 'allowed',
      governing: {
        dimension: 'credential',
        key: 'credential:id:key-42',
        policy: 'write:credential',
        limit: 10,
        windowSeconds: 60,
        remaining: 4,
        resetSeconds: 9,
      },
    });
  });

  it('[evidence:security.rate-limit] uses the synthetic public credential key only for anonymous requests', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const { credentialId: _credentialId, ...anonymous } = request();

    await enforceRateLimit(port, anonymous);

    const charge = firstCharge(port);
    expect(charge.ceilings[0].key).toBe(PUBLIC_RATE_LIMIT_CREDENTIAL_KEY);
    expect(charge.ceilings.map(({ dimension }) => dimension)).toEqual(['credential', 'ip', 'instance']);

    const authenticated = portWith((respond) => ({ ceilings: resultsFor(respond) }));
    await enforceRateLimit(authenticated, request({ credentialId: PUBLIC_RATE_LIMIT_CREDENTIAL_KEY }));
    expect(firstCharge(authenticated).ceilings[0].key).toBe(
      `credential:id:${PUBLIC_RATE_LIMIT_CREDENTIAL_KEY}`,
    );
  });

  it.each(['credential', 'ip', 'instance'] as const)(
    '[evidence:security.rate-limit] denies when the %s ceiling alone rejects',
    async (limitedDimension) => {
      const port = portWith((charge) => ({
        ceilings: resultsFor(charge, {
          [limitedDimension]: { allowed: false, remaining: 0, resetSeconds: 27 },
        }),
      }));

      const decision = await enforceRateLimit(port, request());

      expect(port.charge).toHaveBeenCalledOnce();
      expect(decision).toMatchObject({
        allowed: false,
        reason: 'limited',
        governing: { dimension: limitedDimension, allowed: false, remaining: 0, resetSeconds: 27 },
        retryAfterSeconds: 27,
      });
    },
  );

  it('[evidence:security.rate-limit] fails closed on missing, duplicate, unknown, unordered, or malformed port results', async () => {
    const valid = (await portWith((charge) => ({ ceilings: resultsFor(charge) })).charge({
      bucket: 'publisher:general-write',
      cost: 3,
      ceilings: [
        { dimension: 'credential', key: 'credential:id:key-42', policy: 'write:credential', limit: 10, windowSeconds: 60 },
        { dimension: 'ip', key: 'ip:203.0.113.7', policy: 'write:ip', limit: 100, windowSeconds: 60 },
        { dimension: 'instance', key: 'instance:instance-1', policy: 'write:instance', limit: 1_000, windowSeconds: 300 },
      ],
    })).ceilings;
    const malformedResults: readonly unknown[] = [
      { ceilings: valid.slice(0, 2) },
      { ceilings: [valid[0], valid[0], valid[2]] },
      { ceilings: [valid[0], { ...valid[1], dimension: 'network' }, valid[2]] },
      { ceilings: [valid[1], valid[0], valid[2]] },
      { ceilings: [valid[0], { ...valid[1], allowed: 'yes' }, valid[2]] },
      { ceilings: [valid[0], { ...valid[1], key: 'ip:other' }, valid[2]] },
      { ceilings: [valid[0], { ...valid[1], remaining: Number.NaN }, valid[2]] },
    ];

    for (const rawResult of malformedResults) {
      const port = {
        charge: vi.fn(async () => rawResult as AtomicRateLimitResult),
      } satisfies AtomicRateLimitPort;
      const decision = await enforceRateLimit(port, request());

      expect(decision).toEqual({ allowed: false, reason: 'invalid_result', ceilings: [] });
      expect(decision).not.toHaveProperty('headers');
    }
  });

  it('[evidence:security.rate-limit] never reports allowed when the atomic port throws or rejects', async () => {
    const throwing = {
      charge(): Promise<AtomicRateLimitResult> {
        throw new Error('storage unavailable');
      },
    } satisfies AtomicRateLimitPort;
    const rejecting = {
      charge: vi.fn(() => Promise.reject(new Error('transaction aborted'))),
    } satisfies AtomicRateLimitPort;

    for (const port of [throwing, rejecting]) {
      const decision = await enforceRateLimit(port, request());
      expect(decision).toEqual({ allowed: false, reason: 'invalid_result', ceilings: [] });
      expect(decision).not.toHaveProperty('headers');
    }
  });

  it('[evidence:security.rate-limit] snapshots the atomic input and output and fails closed on accessor or sparse results', async () => {
    let captured: AtomicRateLimitCharge | undefined;
    const validPort = portWith((charge) => {
      captured = charge;
      return { ceilings: resultsFor(charge) };
    });
    const decision = await enforceRateLimit(validPort, request());
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.ceilings)).toBe(true);
    expect(captured?.ceilings.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.ceilings)).toBe(true);
    expect(decision.ceilings.every(Object.isFrozen)).toBe(true);
    if (decision.reason !== 'invalid_result') {
      expect(Object.isFrozen(decision.governing)).toBe(true);
      expect(Object.isFrozen(decision.headers)).toBe(true);
      expect(JSON.stringify(decision.headers)).not.toMatch(/key-42|203\.0\.113\.7|instance-1/u);
    }

    const accessorResult = Object.defineProperty({}, 'ceilings', {
      get: vi.fn(() => resultsFor(captured!)),
    });
    const sparse = new Array(3) as AtomicRateLimitCeilingResult[];
    sparse[0] = resultsFor(captured!)[0]!;
    sparse[2] = resultsFor(captured!)[2]!;
    const dynamic = resultsFor(captured!).slice() as AtomicRateLimitCeilingResult[];
    Object.defineProperty(dynamic, '1', { get: vi.fn(() => resultsFor(captured!)[1]), configurable: true });
    const hostileProxy = new Proxy(
      { ceilings: resultsFor(captured!) },
      {
        getOwnPropertyDescriptor() {
          throw new Error('dynamic result');
        },
      },
    );

    for (const rawResult of [accessorResult, { ceilings: sparse }, { ceilings: dynamic }, hostileProxy]) {
      const port = { charge: vi.fn(async () => rawResult as AtomicRateLimitResult) } satisfies AtomicRateLimitPort;
      await expect(enforceRateLimit(port, request())).resolves.toEqual({
        allowed: false,
        reason: 'invalid_result',
        ceilings: [],
      });
    }
  });

  it('[evidence:security.rate-limit] snapshots request descriptors without invoking input accessors or proxy traps', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const credentialGetter = vi.fn(() => 'stolen-key');
    const accessorRequest = Object.defineProperty(request(), 'credentialId', {
      get: credentialGetter,
    }) as AtomicRateLimitRequest;

    await expect(enforceRateLimit(port, accessorRequest)).rejects.toThrow(/own data property/u);
    expect(credentialGetter).not.toHaveBeenCalled();

    const policyGetter = vi.fn(() => 'write:credential');
    const accessorConfiguration = Object.defineProperty({}, 'policy', {
      get: policyGetter,
    });
    await expect(
      enforceRateLimit(
        port,
        request({
          ceilings: {
            ...request().ceilings,
            credential: accessorConfiguration as AtomicRateLimitRequest['ceilings']['credential'],
          },
        }),
      ),
    ).rejects.toThrow(/own data property/u);
    expect(policyGetter).not.toHaveBeenCalled();

    const descriptorTrap = vi.fn(() => {
      throw new Error('descriptor trap failed');
    });
    const getTrap = vi.fn((_target: AtomicRateLimitRequest, key: PropertyKey) => {
      if (key === 'bucket') return 'publisher:general-write';
      if (key === 'cost') return 1;
      return Reflect.get(request(), key);
    });
    const hostileRequest = new Proxy(request(), {
      get: getTrap,
      getOwnPropertyDescriptor: descriptorTrap,
    });
    await expect(enforceRateLimit(port, hostileRequest)).rejects.toThrow(/plain object/u);
    expect(getTrap).not.toHaveBeenCalled();
    expect(descriptorTrap).not.toHaveBeenCalled();
    expect(port.charge).toHaveBeenCalledTimes(0);
  });

  it('[evidence:security.rate-limit] uses the longest reset among rejecting ceilings for retry', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { allowed: false, remaining: 0, resetSeconds: 7 },
        ip: { allowed: false, remaining: 0, resetSeconds: 31 },
        instance: { allowed: true, remaining: 0, resetSeconds: 90 },
      }),
    }));

    await expect(enforceRateLimit(port, request())).resolves.toMatchObject({
      allowed: false,
      reason: 'limited',
      governing: { dimension: 'ip' },
      retryAfterSeconds: 31,
    });
  });

  it('[evidence:security.rate-limit] accepts only positive safe-integer operation costs at both boundaries', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    for (const cost of [1, Number.MAX_SAFE_INTEGER]) {
      await expect(enforceRateLimit(port, request({ cost }))).resolves.toMatchObject({ allowed: true });
    }
    expect(port.charge).toHaveBeenCalledTimes(2);

    for (const cost of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, -Infinity]) {
      await expect(enforceRateLimit(port, request({ cost }))).rejects.toThrow(/positive safe integer/u);
    }
    expect(port.charge).toHaveBeenCalledTimes(2);
  });

  it('[evidence:security.rate-limit] chooses the most restrictive policy across otherwise allowed ceilings', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { remaining: 7, resetSeconds: 10 },
        ip: { remaining: 20, resetSeconds: 11 },
        instance: { remaining: 300, resetSeconds: 12 },
      }),
    }));

    const decision = await enforceRateLimit(port, request());

    expect(decision).toMatchObject({
      allowed: true,
      governing: { dimension: 'ip', policy: 'write:ip', limit: 100, remaining: 20 },
      headers: {
        RateLimit: '"write:ip";r=20;t=11',
        'RateLimit-Policy': '"write:ip";q=100;w=60',
      },
    });
  });

  it('[evidence:security.rate-limit] compares near-equal safe-integer ratios without floating-point loss', async () => {
    const maximum = 999_999_999_999_999;
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { remaining: maximum - 1, resetSeconds: 10 },
        ip: { remaining: maximum - 2, resetSeconds: 10 },
        instance: { remaining: maximum - 3, resetSeconds: 10 },
      }),
    }));

    const decision = await enforceRateLimit(
      port,
      request({
        ceilings: {
          credential: { policy: 'credential', limit: maximum, windowSeconds: 60 },
          ip: { policy: 'ip', limit: maximum - 1, windowSeconds: 60 },
          instance: { policy: 'instance', limit: maximum - 2, windowSeconds: 60 },
        },
      }),
    );

    expect(decision).toMatchObject({ allowed: true, governing: { dimension: 'instance' } });
  });

  it('[evidence:security.rate-limit] prefers the longest reset when all three ceilings deny', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { allowed: false, remaining: 0, resetSeconds: 5 },
        ip: { allowed: false, remaining: 0, resetSeconds: 40 },
        instance: { allowed: false, remaining: 0, resetSeconds: 12 },
      }),
    }));

    await expect(enforceRateLimit(port, request())).resolves.toMatchObject({
      allowed: false,
      reason: 'limited',
      governing: { dimension: 'ip' },
      retryAfterSeconds: 40,
    });
  });

  it('[evidence:security.rate-limit] breaks equal-reset denials by remaining-to-limit ratio', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { allowed: false, remaining: 1, resetSeconds: 15 },
        ip: { allowed: false, remaining: 20, resetSeconds: 15 },
        instance: { allowed: false, remaining: 300, resetSeconds: 15 },
      }),
    }));

    await expect(enforceRateLimit(port, request())).resolves.toMatchObject({
      allowed: false,
      governing: { dimension: 'credential', remaining: 1 },
      retryAfterSeconds: 15,
    });
  });

  it('[evidence:security.rate-limit] uses dimension ordinal only after equal ratio and reset ties', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { allowed: false, remaining: 1, resetSeconds: 15 },
        ip: { allowed: false, remaining: 10, resetSeconds: 15 },
        instance: { allowed: false, remaining: 100, resetSeconds: 15 },
      }),
    }));

    await expect(enforceRateLimit(port, request({
      ceilings: {
        credential: { policy: 'credential', limit: 10, windowSeconds: 60 },
        ip: { policy: 'ip', limit: 100, windowSeconds: 60 },
        instance: { policy: 'instance', limit: 1_000, windowSeconds: 60 },
      },
    }))).resolves.toMatchObject({
      allowed: false,
      governing: { dimension: 'credential', remaining: 1 },
      retryAfterSeconds: 15,
    });
  });

  it('[evidence:security.rate-limit] keeps denial precedence over allowed ceilings with longer resets', async () => {
    const port = portWith((charge) => ({
      ceilings: resultsFor(charge, {
        credential: { allowed: true, remaining: 1, resetSeconds: 120 },
        ip: { allowed: false, remaining: 0, resetSeconds: 9 },
        instance: { allowed: true, remaining: 900, resetSeconds: 300 },
      }),
    }));

    await expect(enforceRateLimit(port, request())).resolves.toMatchObject({
      allowed: false,
      governing: { dimension: 'ip' },
      retryAfterSeconds: 9,
    });
  });
});

describe('[evidence:security.rate-limit] SEC-0004 RFC 9651 fields', () => {
  it('[evidence:security.rate-limit] emits the exact RFC 9651 fields and no legacy headers', () => {
    const headers = serializeRateLimitFields({
      policy: 'feed:anonymous',
      limit: 120,
      remaining: 83,
      resetSeconds: 27,
      windowSeconds: 60,
    });

    expect(headers).toEqual({
      RateLimit: '"feed:anonymous";r=83;t=27',
      'RateLimit-Policy': '"feed:anonymous";q=120;w=60',
    });
    expect(Object.keys(headers)).toEqual(['RateLimit', 'RateLimit-Policy']);
    expect(headers).not.toHaveProperty('RateLimit-Limit');
    expect(headers).not.toHaveProperty('RateLimit-Remaining');
    expect(headers).not.toHaveProperty('RateLimit-Reset');
    expect(headers).not.toHaveProperty('X-RateLimit-Limit');
  });

  it('[evidence:security.rate-limit] escapes quotes and backslashes in the policy identifier', () => {
    expect(
      serializeRateLimitFields({
        policy: 'feed:"quoted"\\tier',
        limit: 10,
        remaining: 8,
        resetSeconds: 2,
        windowSeconds: 60,
      }),
    ).toEqual({
      RateLimit: '"feed:\\"quoted\\"\\\\tier";r=8;t=2',
      'RateLimit-Policy': '"feed:\\"quoted\\"\\\\tier";q=10;w=60',
    });
  });

  it('[evidence:security.rate-limit] rejects CRLF, controls, non-ASCII, and invalid structured-field policies', () => {
    for (const policy of ['feed\r\nInjected: yes', 'feed\u0000x', 'feed\u001fx', 'feed\u007fx', '\u653f\u7b56']) {
      expect(() =>
        serializeRateLimitFields({ policy, limit: 10, remaining: 8, resetSeconds: 2, windowSeconds: 60 }),
      ).toThrow(/structured field string/u);
    }
  });

  it('[evidence:security.rate-limit] rejects non-finite, negative, fractional, unsafe, and inconsistent numeric fields', () => {
    const valid: RateLimitFields = {
      policy: 'feed',
      limit: 10,
      remaining: 8,
      resetSeconds: 2,
      windowSeconds: 60,
    };
    const invalid: readonly [keyof RateLimitFields, number][] = [
      ['limit', 0],
      ['limit', -1],
      ['limit', 1.5],
      ['limit', Number.NaN],
      ['limit', Infinity],
      ['limit', Number.MAX_SAFE_INTEGER + 1],
      ['limit', 1_000_000_000_000_000],
      ['remaining', -1],
      ['remaining', 1.5],
      ['remaining', Number.NaN],
      ['remaining', -Infinity],
      ['remaining', 11],
      ['resetSeconds', -1],
      ['resetSeconds', 1.5],
      ['resetSeconds', Infinity],
      ['resetSeconds', 1_000_000_000_000_000],
      ['windowSeconds', 0],
      ['windowSeconds', -1],
      ['windowSeconds', 1.5],
      ['windowSeconds', Number.NaN],
      ['windowSeconds', 1_000_000_000_000_000],
    ];

    for (const [field, value] of invalid) {
      expect(() => serializeRateLimitFields({ ...valid, [field]: value })).toThrow(TypeError);
    }
  });
});
