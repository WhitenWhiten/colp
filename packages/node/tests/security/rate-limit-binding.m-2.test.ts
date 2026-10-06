import { describe, expect, it, vi } from 'vitest';

import {
  RATE_LIMIT_BUCKET_IDS,
  enforceRateLimit,
  enforceRateLimitForOperation,
} from '../../src/security/index.js';
import type {
  AtomicRateLimitCeilingResult,
  AtomicRateLimitCharge,
  AtomicRateLimitPort,
  AtomicRateLimitRequest,
  AtomicRateLimitResult,
  EnforceRateLimitForOperationInput,
  RateLimitBucketId,
  RateLimitDimension,
} from '../../src/security/index.js';

const evidence = '[evidence:security.rate-limit-binding]';

/** Canonical SEC-0012 publisher rate-limit bucket identifiers (exactly seven). */
const CANONICAL_BUCKETS = [
  'publisher:anonymous-feed-read',
  'publisher:authenticated-read',
  'publisher:sync-pull',
  'publisher:sync-push',
  'publisher:general-write',
  'publisher:mcp-tool-call',
  'publisher:admin-key-management',
] as const satisfies readonly RateLimitBucketId[];

/** Free-form / non-canonical bucket strings that must never reach the atomic port. */
const FREE_FORM_BUCKETS = [
  'write:general',
  '',
  'publisher:evil',
  'admin',
  'publisher:general-write:extra',
  'publisher:authenticated_read',
  'Publisher:general-write',
  'feed:anonymous',
] as const;

const defaultCeilings = {
  credential: { policy: 'publisher:credential', limit: 10, windowSeconds: 60 },
  ip: { policy: 'publisher:ip', limit: 100, windowSeconds: 60 },
  instance: { policy: 'publisher:instance', limit: 1_000, windowSeconds: 300 },
} as const;

function chargeRequest(overrides: Record<string, unknown> = {}): AtomicRateLimitRequest {
  return {
    bucket: 'publisher:general-write',
    cost: 3,
    credentialId: 'key-42',
    ipAddress: '203.0.113.7',
    instanceId: 'instance-1',
    ceilings: defaultCeilings,
    ...overrides,
  } as AtomicRateLimitRequest;
}

function operationRequest(
  overrides: Record<string, unknown> = {},
): EnforceRateLimitForOperationInput {
  return {
    authentication: 'authenticated',
    operation: 'write',
    cost: 3,
    credentialId: 'key-42',
    ipAddress: '203.0.113.7',
    instanceId: 'instance-1',
    ceilings: defaultCeilings,
    ...overrides,
  } as EnforceRateLimitForOperationInput;
}

function anonymousOperationRequest(
  operation: EnforceRateLimitForOperationInput['operation'],
  overrides: Record<string, unknown> = {},
): EnforceRateLimitForOperationInput {
  return {
    authentication: 'anonymous',
    operation,
    cost: 1,
    ipAddress: '203.0.113.7',
    instanceId: 'instance-1',
    ceilings: defaultCeilings,
    ...overrides,
  } as EnforceRateLimitForOperationInput;
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
  respond: (charge: AtomicRateLimitCharge) => AtomicRateLimitResult | Promise<AtomicRateLimitResult> = (
    charge,
  ) => ({ ceilings: resultsFor(charge) }),
): AtomicRateLimitPort & { charge: ReturnType<typeof vi.fn> } {
  const charge = vi.fn(
    async (input: AtomicRateLimitCharge): Promise<AtomicRateLimitResult> => respond(input),
  );
  return { charge } satisfies AtomicRateLimitPort;
}

/**
 * Fail-closed without invoking the atomic port: either throw, or resolve to a
 * denied decision that does not carry success-path headers.
 */
async function expectRejectedWithoutCharge(
  port: AtomicRateLimitPort & { charge: ReturnType<typeof vi.fn> },
  invoke: () => Promise<unknown>,
): Promise<unknown> {
  const callsBefore = port.charge.mock.calls.length;
  let resolved: unknown;
  let threw = false;
  try {
    resolved = await invoke();
  } catch {
    threw = true;
  }

  expect(port.charge.mock.calls.length, 'atomic port must not be charged').toBe(callsBefore);

  if (!threw) {
    expect(resolved).toMatchObject({ allowed: false });
    expect(resolved).not.toHaveProperty('headers');
  }
  return threw ? undefined : resolved;
}

function chargedBucket(
  port: AtomicRateLimitPort & { charge: ReturnType<typeof vi.fn> },
  callIndex = 0,
): unknown {
  return (port.charge.mock.calls[callIndex]?.[0] as AtomicRateLimitCharge | undefined)?.bucket;
}

describe(`${evidence} M-2 rate-limit charge bound to SEC-0012 classifier`, () => {
  describe(`${evidence} enforceRateLimit charge path rejects free-form buckets`, () => {
    it.each(FREE_FORM_BUCKETS)(
      `${evidence} rejects free-form bucket %j without charging the atomic port`,
      async (bucket) => {
        const port = portWith();
        await expect(
          enforceRateLimit(port, chargeRequest({ bucket })),
        ).rejects.toThrow(/canonical RateLimitBucketId/u);
        expect(port.charge).not.toHaveBeenCalled();
      },
    );

    it(`${evidence} never forwards a free-form bucket string into AtomicRateLimitCharge`, async () => {
      const port = portWith();
      for (const bucket of FREE_FORM_BUCKETS) {
        await expect(
          enforceRateLimit(port, chargeRequest({ bucket })),
        ).rejects.toThrow(TypeError);
      }
      expect(port.charge).not.toHaveBeenCalled();
    });
  });

  describe(`${evidence} enforceRateLimit accepts only the seven canonical RateLimitBucketId values`, () => {
    it.each([...CANONICAL_BUCKETS])(
      `${evidence} charges canonical bucket %s exactly once`,
      async (bucket) => {
        const port = portWith();
        const decision = await enforceRateLimit(port, chargeRequest({ bucket }));

        expect(port.charge).toHaveBeenCalledOnce();
        expect(chargedBucket(port)).toBe(bucket);
        expect(decision).toMatchObject({ allowed: true, reason: 'allowed' });
      },
    );

    it(`${evidence} production RATE_LIMIT_BUCKET_IDS is exactly the seven canonical identifiers`, () => {
      expect(RATE_LIMIT_BUCKET_IDS.size).toBe(7);
      expect(new Set(CANONICAL_BUCKETS).size).toBe(7);
      for (const bucket of CANONICAL_BUCKETS) {
        expect(RATE_LIMIT_BUCKET_IDS.has(bucket)).toBe(true);
        expect(bucket.startsWith('publisher:')).toBe(true);
      }
      // No production identifier outside the canonical list under test.
      for (const bucket of RATE_LIMIT_BUCKET_IDS) {
        expect(CANONICAL_BUCKETS).toContain(bucket);
      }
    });
  });

  describe(`${evidence} enforceRateLimitForOperation classifies then charges`, () => {
    it(`${evidence} authenticated write charges publisher:general-write exactly`, async () => {
      const port = portWith();
      const decision = await enforceRateLimitForOperation(
        port,
        operationRequest({ authentication: 'authenticated', operation: 'write' }),
      );

      expect(port.charge).toHaveBeenCalledOnce();
      expect(chargedBucket(port)).toBe('publisher:general-write');
      expect(port.charge).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'publisher:general-write',
          cost: 3,
        }),
      );
      expect(decision).toMatchObject({ allowed: true, reason: 'allowed' });
    });

    it(`${evidence} authenticated admin charges publisher:admin-key-management exactly`, async () => {
      const port = portWith();
      const decision = await enforceRateLimitForOperation(
        port,
        operationRequest({ authentication: 'authenticated', operation: 'admin' }),
      );

      expect(port.charge).toHaveBeenCalledOnce();
      expect(chargedBucket(port)).toBe('publisher:admin-key-management');
      expect(decision).toMatchObject({ allowed: true, reason: 'allowed' });
    });

    it(`${evidence} authenticated key-management shares the admin-key-management bucket`, async () => {
      const port = portWith();
      await enforceRateLimitForOperation(
        port,
        operationRequest({ authentication: 'authenticated', operation: 'key-management' }),
      );

      expect(port.charge).toHaveBeenCalledOnce();
      expect(chargedBucket(port)).toBe('publisher:admin-key-management');
    });

    it.each([
      ['feed-read', 'anonymous', 'publisher:anonymous-feed-read'],
      ['feed-read', 'authenticated', 'publisher:authenticated-read'],
      ['read', 'authenticated', 'publisher:authenticated-read'],
      ['sync-pull', 'authenticated', 'publisher:sync-pull'],
      ['sync-push', 'authenticated', 'publisher:sync-push'],
      ['mcp-tool', 'authenticated', 'publisher:mcp-tool-call'],
    ] as const)(
      `${evidence} %s + %s charges %s`,
      async (operation, authentication, expectedBucket) => {
        const port = portWith();
        const request =
          authentication === 'anonymous'
            ? anonymousOperationRequest(operation)
            : operationRequest({ authentication, operation });

        const decision = await enforceRateLimitForOperation(port, request);

        expect(port.charge).toHaveBeenCalledOnce();
        expect(chargedBucket(port)).toBe(expectedBucket);
        expect(decision).toMatchObject({ allowed: true });
      },
    );

    it(`${evidence} anonymous non-feed-read fails closed without calling the atomic port`, async () => {
      for (const operation of [
        'read',
        'sync-pull',
        'sync-push',
        'write',
        'mcp-tool',
        'admin',
        'key-management',
      ] as const) {
        const port = portWith();
        const decision = await expectRejectedWithoutCharge(port, () =>
          enforceRateLimitForOperation(port, anonymousOperationRequest(operation)),
        );
        expect(decision).toEqual({ allowed: false, reason: 'invalid_classification' });
      }
    });

    it(`${evidence} invalid classification input does not invoke the atomic port`, async () => {
      // Classification rejects these even when required charge fields are present.
      const classificationRejects: readonly EnforceRateLimitForOperationInput[] = [
        operationRequest({ authentication: 'authenticated', operation: 'WRITE' }),
        operationRequest({ authentication: 'authenticated', operation: 'unknown' }),
        operationRequest({ authentication: 'Authenticated', operation: 'write' }),
        operationRequest({ authentication: 'authenticated', operation: '' }),
        operationRequest({ authentication: '', operation: 'write' }),
        operationRequest({ authentication: 'anonymous', operation: 'write' }),
      ];

      for (const input of classificationRejects) {
        const port = portWith();
        const decision = await expectRejectedWithoutCharge(port, () =>
          enforceRateLimitForOperation(port, input),
        );
        expect(decision).toEqual({ allowed: false, reason: 'invalid_classification' });
      }

      // Malformed / incomplete envelopes fail closed before (or without) a port charge.
      const malformed: readonly unknown[] = [
        undefined,
        null,
        {},
        [],
        { authentication: 'authenticated' },
        { operation: 'write' },
        { authentication: 'authenticated', operation: 'write' },
      ];

      for (const input of malformed) {
        const port = portWith();
        await expectRejectedWithoutCharge(port, () =>
          enforceRateLimitForOperation(port, input as EnforceRateLimitForOperationInput),
        );
      }
    });

    it(`${evidence} unexpected own keys (forged bucket/bucketId) fail closed without charging`, async () => {
      // Source enforces an exact own-key allow-list on ForOperation input; extra
      // keys must yield invalid_classification and never reach the atomic port.
      const hostileExtras: readonly Record<string, unknown>[] = [
        { bucket: 'publisher:admin-key-management' },
        { bucketId: 'publisher:admin-key-management' },
        { bucket: 'publisher:admin-key-management', bucketId: 'publisher:admin-key-management' },
        { principal: 'admin' },
        { category: 'general-write' },
      ];

      for (const extras of hostileExtras) {
        const port = portWith();
        const decision = await expectRejectedWithoutCharge(port, () =>
          enforceRateLimitForOperation(
            port,
            operationRequest({
              authentication: 'authenticated',
              operation: 'write',
              ...extras,
            }),
          ),
        );
        expect(decision).toEqual({ allowed: false, reason: 'invalid_classification' });
      }
    });

    it(`${evidence} forged bucket cannot force anonymous write into a charged path`, async () => {
      const port = portWith();
      const decision = await expectRejectedWithoutCharge(port, () =>
        enforceRateLimitForOperation(
          port,
          anonymousOperationRequest('write', {
            bucket: 'publisher:general-write',
            bucketId: 'publisher:general-write',
          }),
        ),
      );
      // Exact own-key set + classification both reject; never charge.
      expect(decision).toEqual({ allowed: false, reason: 'invalid_classification' });
    });

    it(`${evidence} operation-bound charge never emits free-form bucket identifiers`, async () => {
      const port = portWith();
      const cases: readonly {
        readonly authentication: 'anonymous' | 'authenticated';
        readonly operation: EnforceRateLimitForOperationInput['operation'];
      }[] = [
        { authentication: 'anonymous', operation: 'feed-read' },
        { authentication: 'authenticated', operation: 'read' },
        { authentication: 'authenticated', operation: 'write' },
        { authentication: 'authenticated', operation: 'admin' },
      ];

      for (const { authentication, operation } of cases) {
        const request =
          authentication === 'anonymous'
            ? anonymousOperationRequest(operation)
            : operationRequest({ authentication, operation, cost: 1 });
        await enforceRateLimitForOperation(port, request);
      }

      expect(port.charge.mock.calls.length).toBe(cases.length);
      for (const [charge] of port.charge.mock.calls as [AtomicRateLimitCharge][]) {
        expect(CANONICAL_BUCKETS).toContain(charge.bucket);
        expect(charge.bucket).not.toBe('write:general');
        expect(charge.bucket).not.toBe('admin');
      }
    });
  });
});
