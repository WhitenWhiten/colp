import { describe, expect, it, vi } from 'vitest';

import {
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
  RateLimitDimension,
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

describe('[evidence:security.rate-limit] SEC-0004 Proxy/accessor fail-closed snapshots', () => {
  it('[evidence:security.rate-limit] rejects Proxy get traps as a legal bucket or cost without charging', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const getTrap = vi.fn((target: AtomicRateLimitRequest, key: PropertyKey) => {
      if (key === 'bucket') return 'publisher:admin-key-management';
      if (key === 'cost') return 1;
      return Reflect.get(target, key);
    });
    const proxied = new Proxy(request(), { get: getTrap });

    await expect(enforceRateLimit(port, proxied)).rejects.toThrow(/plain object/u);
    expect(getTrap).not.toHaveBeenCalled();
    expect(port.charge).toHaveBeenCalledTimes(0);

    const { proxy, revoke } = Proxy.revocable(request(), { get: getTrap });
    revoke();
    await expect(enforceRateLimit(port, proxy)).rejects.toThrow(/plain object/u);
    expect(getTrap).not.toHaveBeenCalled();
    expect(port.charge).toHaveBeenCalledTimes(0);
  });

  it('[evidence:security.rate-limit] fails closed on malformed ceilings without calling port.charge', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const valid = request().ceilings;

    await expect(
      enforceRateLimit(
        port,
        request({
          ceilings: {
            credential: { policy: 12 as unknown as string, limit: 10, windowSeconds: 60 },
            ip: valid.ip,
            instance: valid.instance,
          },
        }),
      ),
    ).rejects.toThrow(/credential policy must be a string/u);
    expect(port.charge).toHaveBeenCalledTimes(0);

    const ceilingGet = vi.fn(() => valid.credential);
    await expect(
      enforceRateLimit(
        port,
        request({
          ceilings: new Proxy(valid, { get: ceilingGet }) as AtomicRateLimitRequest['ceilings'],
        }),
      ),
    ).rejects.toThrow(/plain object/u);
    expect(ceilingGet).not.toHaveBeenCalled();
    expect(port.charge).toHaveBeenCalledTimes(0);
  });

  it('[evidence:security.rate-limit] ForOperation rejects Proxy input without charging', async () => {
    const port = portWith((charge) => ({ ceilings: resultsFor(charge) }));
    const operationInput: EnforceRateLimitForOperationInput = {
      authentication: 'authenticated',
      operation: 'write',
      cost: 3,
      credentialId: 'key-42',
      ipAddress: '203.0.113.7',
      instanceId: 'instance-1',
      ceilings: request().ceilings,
    };
    const getTrap = vi.fn((target: EnforceRateLimitForOperationInput, key: PropertyKey) => {
      if (key === 'operation') return 'admin';
      return Reflect.get(target, key);
    });
    const proxied = new Proxy(operationInput, { get: getTrap });

    await expect(enforceRateLimitForOperation(port, proxied)).resolves.toEqual({
      allowed: false,
      reason: 'invalid_classification',
    });
    expect(getTrap).not.toHaveBeenCalled();
    expect(port.charge).toHaveBeenCalledTimes(0);
  });
});
