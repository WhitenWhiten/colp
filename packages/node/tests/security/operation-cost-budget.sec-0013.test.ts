import { describe, expect, it, vi } from 'vitest';

import * as security from '../../src/security/index.js';

const evidence = '[evidence:security.operation-cost-budget]';

type LeafOperation = {
  readonly kind: 'read' | 'write' | 'batch' | 'sync-push' | 'mcp-tool';
  readonly affectedObjects: number;
  readonly writeObjects: number;
};

type ExpandedOperationInput = readonly LeafOperation[];

type ExpandedOperationCost = {
  readonly calculated: true;
  readonly cost: number;
  readonly affectedObjects: number;
  readonly writeObjects: number;
  readonly operationCount: number;
};

type Ceiling = {
  readonly limit: number;
  readonly windowSeconds: number;
};

type OperationBudgetRequest = {
  readonly bucket: string;
  readonly identity: { readonly kind: 'subject' | 'credential'; readonly id: string };
  readonly ipAddress: string;
  readonly instanceId: string;
  readonly operations: ExpandedOperationInput;
  readonly ceilings: {
    readonly subjectCredential: Ceiling;
    readonly ip: Ceiling;
    readonly instance: Ceiling;
  };
  readonly grant: { readonly id: string; readonly maxWrites: number } | null;
};

type AtomicBudgetCharge = {
  readonly bucket: string;
  readonly cost: number;
  readonly affectedObjects: number;
  readonly ceilings: readonly [
    { readonly dimension: 'subject-credential'; readonly key: string; readonly limit: number; readonly windowSeconds: number },
    { readonly dimension: 'ip'; readonly key: string; readonly limit: number; readonly windowSeconds: number },
    { readonly dimension: 'instance'; readonly key: string; readonly limit: number; readonly windowSeconds: number },
  ];
  readonly grant: { readonly kind: 'none'; readonly writeDebit: 0 } | { readonly kind: 'grant'; readonly grantId: string; readonly maxWrites: number; readonly writeDebit: number };
};

type AtomicBudgetResult = {
  readonly committed: boolean;
  readonly ceilings: readonly {
    readonly dimension: 'subject-credential' | 'ip' | 'instance';
    readonly key: string;
    readonly allowed: boolean;
    readonly remaining: number;
  }[];
  readonly grant: unknown;
};

type OperationBudgetDecision =
  | { readonly allowed: true; readonly reason: 'allowed' }
  | { readonly allowed: false; readonly reason: string };

type SubscriptionLimits = {
  readonly connections: number;
  readonly resources: number;
  readonly queueBytes: number;
  readonly eventsPerSecond: number;
  readonly idleTimeoutSeconds: number;
  readonly maxLifetimeSeconds: number;
};

type SubscriptionUsage = SubscriptionLimits;

type Security0013Api = {
  readonly calculateExpandedOperationCost: (input: unknown) => ExpandedOperationCost;
  readonly enforcePublisherAdmission: (
    port: { checkAndConsume(input: AtomicBudgetCharge): Promise<AtomicBudgetResult> },
    input: OperationBudgetRequest,
  ) => Promise<OperationBudgetDecision>;
  readonly enforceSubscriptionLimits: (
    port: { checkAndReserve(input: unknown): Promise<unknown> },
    input: { readonly subscriberId: string; readonly subscriptionId: string; readonly requested: SubscriptionUsage; readonly limits: SubscriptionLimits },
  ) => Promise<OperationBudgetDecision>;
};

// Keep the behavior matrix type-checkable while the production SEC-0013 API is being landed.
// This adapter is replaced with its concrete exported names/signatures once that API exists.
const {
  calculateExpandedOperationCost,
  enforcePublisherAdmission,
  enforceSubscriptionLimits,
} = security as unknown as Security0013Api;

function leaf(kind: LeafOperation['kind'], affectedObjects: number, writeObjects = kind === 'write' || kind === 'sync-push' ? affectedObjects : 0): LeafOperation {
  return { kind, affectedObjects, writeObjects };
}

function expanded(
  kind: LeafOperation['kind'],
  operations: readonly LeafOperation[],
): ExpandedOperationInput {
  return operations.map((operation) => ({ ...operation, kind }));
}

function request(overrides: Partial<OperationBudgetRequest> = {}): OperationBudgetRequest {
  return {
    bucket: 'publisher:general-write',
    identity: { kind: 'credential', id: 'credential-secret-Aa9' },
    ipAddress: '203.0.113.7',
    instanceId: 'instance-secret-Bb8',
    operations: expanded('batch', [leaf('batch', 1, 1), leaf('batch', 4, 4)]),
    ceilings: {
      subjectCredential: { limit: 100, windowSeconds: 60 },
      ip: { limit: 200, windowSeconds: 60 },
      instance: { limit: 300, windowSeconds: 60 },
    },
    grant: { id: 'grant-secret-Cc7', maxWrites: 20 },
    ...overrides,
  };
}

function validResult(charge: AtomicBudgetCharge): AtomicBudgetResult {
  return {
    committed: true,
    ceilings: charge.ceilings.map((ceiling) => ({
      dimension: ceiling.dimension,
      key: ceiling.key,
      allowed: true,
      remaining: ceiling.limit - charge.cost,
      debitedCost: charge.cost,
    })),
    grant: charge.grant.kind === 'none'
      ? { kind: 'none', allowed: true, debitedWrites: 0 }
      : { kind: 'grant', grantId: charge.grant.grantId, allowed: true, remainingWrites: charge.grant.maxWrites - charge.grant.writeDebit, debitedWrites: charge.grant.writeDebit },
  };
}

function portWith(
  respond: (charge: AtomicBudgetCharge) => AtomicBudgetResult | Promise<AtomicBudgetResult> = validResult,
) {
  return { checkAndConsume: vi.fn(async (charge: AtomicBudgetCharge) => respond(charge)) };
}

const defaultSubscriptionLimits: SubscriptionLimits = {
  connections: 4,
  resources: 20,
  queueBytes: 65_536,
  eventsPerSecond: 100,
  idleTimeoutSeconds: 30,
  maxLifetimeSeconds: 3_600,
};

function subscription(
  usage: Partial<SubscriptionUsage> = {},
  limits: Partial<SubscriptionLimits> = {},
) {
  return {
    subscriberId: 'subscriber-secret-Dd8',
    subscriptionId: 'subscription-secret-Ee9',
    requested: { ...defaultSubscriptionLimits, ...usage },
    limits: { ...defaultSubscriptionLimits, ...limits },
  };
}

function subscriptionPort() {
  return {
    checkAndReserve: vi.fn(async (reservation: { limits: readonly { dimension: string; requested: number }[] }) => ({
      committed: true,
      snapshots: reservation.limits.map(({ dimension, requested }) => ({ dimension, allowed: true, observed: requested, applied: requested })),
    })),
  };
}

describe(`${evidence} SEC-0013 expanded operation cost`, () => {
  it(`${evidence} expands Batch operation cost and affected object count`, () => {
    expect(calculateExpandedOperationCost(expanded('batch', [leaf('batch', 3, 3), leaf('batch', 7, 7)]))).toEqual({ calculated: true, cost: 20, affectedObjects: 10, writeObjects: 10, operationCount: 2 });
  });
  it(`${evidence} expands Sync Push operation cost and affected object count`, () => {
    expect(calculateExpandedOperationCost(expanded('sync-push', [leaf('sync-push', 2), leaf('sync-push', 4)]))).toEqual({ calculated: true, cost: 18, affectedObjects: 6, writeObjects: 6, operationCount: 2 });
  });
  it(`${evidence} expands MCP Tool operation cost and affected object count`, () => {
    expect(calculateExpandedOperationCost(expanded('mcp-tool', [leaf('mcp-tool', 1), leaf('mcp-tool', 9)]))).toEqual({ calculated: true, cost: 40, affectedObjects: 10, writeObjects: 0, operationCount: 2 });
  });
  it(`${evidence} sums mixed operation kinds and object counts`, () => {
    expect(calculateExpandedOperationCost([leaf('read', 1), leaf('write', 2), leaf('batch', 3), leaf('mcp-tool', 4)])).toEqual({ calculated: true, cost: 27, affectedObjects: 10, writeObjects: 2, operationCount: 4 });
  });
  it(`${evidence} rejects zero, negative, fractional, non-finite, and unsafe affected counts`, () => {
    for (const value of [0, -1, 0.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(calculateExpandedOperationCost([leaf('batch', value)])).toEqual({ calculated: false, reason: 'invalid_input' });
    }
  });
  it(`${evidence} rejects inconsistent write counts and unknown operation kinds`, () => {
    expect(calculateExpandedOperationCost([{ kind: 'read', affectedObjects: 1, writeObjects: 1 }])).toEqual({ calculated: false, reason: 'invalid_input' });
    expect(calculateExpandedOperationCost([{ kind: 'unknown', affectedObjects: 1, writeObjects: 0 }])).toEqual({ calculated: false, reason: 'invalid_input' });
  });
  it(`${evidence} rejects aggregate cost, object, and operation overflow`, () => {
    expect(calculateExpandedOperationCost([leaf('mcp-tool', Number.MAX_SAFE_INTEGER)])).toEqual({ calculated: false, reason: 'invalid_input' });
    expect(calculateExpandedOperationCost([leaf('batch', Number.MAX_SAFE_INTEGER), leaf('batch', 1)])).toEqual({ calculated: false, reason: 'invalid_input' });
    expect(calculateExpandedOperationCost(new Array(100_001).fill(leaf('read', 1)))).toEqual({ calculated: false, reason: 'invalid_input' });
  });
  it(`${evidence} rejects empty, sparse, accessor-backed, and Proxy operation lists without invoking accessors`, () => {
    const getter = vi.fn(() => leaf('read', 1));
    const sparse = new Array<LeafOperation>(2); sparse[0] = leaf('read', 1);
    const dynamic = [leaf('read', 1)]; Object.defineProperty(dynamic, '0', { get: getter });
    const hostile = new Proxy([leaf('read', 1)], {});
    for (const input of [[], sparse, dynamic, hostile]) expect(calculateExpandedOperationCost(input)).toEqual({ calculated: false, reason: 'invalid_input' });
    expect(getter).not.toHaveBeenCalled();
  });
  it(`${evidence} ignores caller-forged totals, discounts, and extra fields`, () => {
    const forged = [{ kind: 'batch', affectedObjects: 2, writeObjects: 2, cost: 0, discount: Number.MAX_SAFE_INTEGER }];
    expect(calculateExpandedOperationCost(forged)).toEqual({ calculated: false, reason: 'invalid_input' });
  });
  it(`${evidence} handles 100k expanded leaves with exact safe-integer totals`, () => {
    const operations = Array.from({ length: 100_000 }, () => leaf('mcp-tool', 3));
    expect(calculateExpandedOperationCost(operations)).toEqual({ calculated: true, cost: 1_200_000, affectedObjects: 300_000, writeObjects: 0, operationCount: 100_000 });
  });
  it(`${evidence} preserves cost and object totals for every contiguous partition`, () => {
    const operations = [leaf('batch', 1), leaf('sync-push', 3), leaf('mcp-tool', 8), leaf('read', 21)];
    const whole = calculateExpandedOperationCost(operations); expect(whole.calculated).toBe(true);
    for (let split = 1; split < operations.length; split += 1) {
      const left = calculateExpandedOperationCost(operations.slice(0, split)); const right = calculateExpandedOperationCost(operations.slice(split));
      expect(left.calculated && right.calculated && whole.calculated).toBe(true);
      if (left.calculated && right.calculated && whole.calculated) { expect(left.cost + right.cost).toBe(whole.cost); expect(left.affectedObjects + right.affectedObjects).toBe(whole.affectedObjects); }
    }
  });
  it(`${evidence} preserves total cost across parallel single-item requests in any completion order`, async () => {
    const operations = [leaf('read', 1), leaf('write', 5), leaf('sync-push', 11), leaf('mcp-tool', 17)]; const whole = calculateExpandedOperationCost(operations);
    const parts = await Promise.all([2, 0, 3, 1].map(async (index) => calculateExpandedOperationCost([operations[index]!])))
    expect(parts.every((part) => part.calculated) && whole.calculated).toBe(true);
    if (whole.calculated && parts.every((part) => part.calculated)) expect(parts.reduce((sum, part) => sum + part.cost, 0)).toBe(whole.cost);
  });
  it(`${evidence} prevents split-one-item requests from reducing charged total cost`, async () => {
    const operations = Array.from({ length: 64 }, (_, index) => leaf('mcp-tool', (index % 5) + 1)); const whole = calculateExpandedOperationCost(operations);
    const singles = await Promise.all(operations.map(async (operation) => calculateExpandedOperationCost([operation])));
    expect(singles.every((part) => part.calculated) && whole.calculated).toBe(true);
    if (whole.calculated && singles.every((part) => part.calculated)) expect(singles.reduce((sum, part) => sum + part.cost, 0)).toBe(whole.cost);
  });
});

describe(`${evidence} SEC-0013 atomic ceilings and Grant debit`, () => {
  it(`${evidence} charges credential, IP, instance, and write Grant once in one port call`, async () => {
    const port = portWith();
    await expect(enforcePublisherAdmission(port, request())).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(port.checkAndConsume).toHaveBeenCalledOnce();
    expect(port.checkAndConsume).toHaveBeenCalledWith(expect.objectContaining({
      cost: 10,
      affectedObjects: 5,
      ceilings: [
        expect.objectContaining({ dimension: 'subject-credential', key: 'credential:credential-secret-Aa9' }),
        expect.objectContaining({ dimension: 'ip', key: 'ip:203.0.113.7' }),
        expect.objectContaining({ dimension: 'instance', key: 'instance:instance-secret-Bb8' }),
      ],
      grant: { kind: 'grant', grantId: 'grant-secret-Cc7', maxWrites: 20, writeDebit: 5 },
    }));
  });

  it(`${evidence} debits write Grant by the exact expanded write count`, async () => {
    const port = portWith();
    await enforcePublisherAdmission(port, request({ operations: expanded('write', [leaf('write', 1), leaf('write', 1), leaf('write', 1), leaf('write', 1)]) }));
    expect(port.checkAndConsume.mock.calls[0]?.[0].grant.writeDebit).toBe(4);
  });

  it(`${evidence} applies the explicit zero Grant debit policy to reads`, async () => {
    const port = portWith();
    await enforcePublisherAdmission(port, request({ operations: [leaf('read', 5)], grant: null }));
    expect(port.checkAndConsume).toHaveBeenCalledOnce();
    expect(port.checkAndConsume.mock.calls[0]?.[0].grant.writeDebit).toBe(0);
  });

  it(`${evidence} fails closed when credential, IP, or instance identity is absent`, async () => {
    for (const missing of ['identity', 'ipAddress', 'instanceId'] as const) {
      const port = portWith();
      const input = { ...request() } as Record<string, unknown>;
      delete input[missing];
      await expect(enforcePublisherAdmission(port, input as unknown as OperationBudgetRequest)).resolves.toMatchObject({ allowed: false });
      expect(port.checkAndConsume).not.toHaveBeenCalled();
    }
  });

  it(`${evidence} fails closed when any one of the three ceiling configurations is absent`, async () => {
    for (const missing of ['subjectCredential', 'ip', 'instance'] as const) {
      const port = portWith();
      const ceilings = { ...request().ceilings } as Record<string, unknown>;
      delete ceilings[missing];
      await expect(enforcePublisherAdmission(port, request({ ceilings: ceilings as OperationBudgetRequest['ceilings'] }))).resolves.toMatchObject({ allowed: false });
      expect(port.checkAndConsume).not.toHaveBeenCalled();
    }
  });

  it(`${evidence} denies when any individual ceiling rejects`, async () => {
    for (const limited of ['subject-credential', 'ip', 'instance'] as const) {
      const port = portWith((charge) => ({
        ...validResult(charge),
        ceilings: validResult(charge).ceilings.map((result) =>
          result.dimension === limited ? { ...result, allowed: false, remaining: 0 } : result),
      }));
      await expect(enforcePublisherAdmission(port, request())).resolves.toMatchObject({ allowed: false });
    }
  });

  it(`${evidence} denies when the atomic Grant check rejects or cannot debit all writes`, async () => {
    for (const grantResult of [
      { kind: 'grant', grantId: 'grant-secret-Cc7', allowed: false, remainingWrites: 0, debitedWrites: 0 },
      { kind: 'grant', grantId: 'grant-secret-Cc7', allowed: true, remainingWrites: 19, debitedWrites: 1 },
    ]) {
      const port = portWith((charge) => ({ ...validResult(charge), grant: grantResult }));
      await expect(enforcePublisherAdmission(port, request())).resolves.toMatchObject({ allowed: false });
    }
  });

  it(`${evidence} fails closed on partial, duplicate, unknown, unordered, or malformed results`, async () => {
    const seed = request();
    const capture = portWith();
    await enforcePublisherAdmission(capture, seed);
    const charge = capture.checkAndConsume.mock.calls[0]![0];
    const valid = validResult(charge);
    const malformed: readonly unknown[] = [
      { ...valid, ceilings: valid.ceilings.slice(0, 2) },
      { ...valid, ceilings: [valid.ceilings[0], valid.ceilings[0], valid.ceilings[2]] },
      { ...valid, ceilings: [valid.ceilings[0], { ...valid.ceilings[1], dimension: 'network' }, valid.ceilings[2]] },
      { ...valid, ceilings: [valid.ceilings[1], valid.ceilings[0], valid.ceilings[2]] },
      { ...valid, ceilings: [valid.ceilings[0], { ...valid.ceilings[1], allowed: 'yes' }, valid.ceilings[2]] },
      { ...valid, grant: undefined },
      { ...valid, grant: { kind: 'grant', grantId: 'grant-secret-Cc7', allowed: true, remainingWrites: 19, debitedWrites: Number.NaN } },
    ];
    for (const raw of malformed) {
      const port = portWith(() => raw as AtomicBudgetResult);
      await expect(enforcePublisherAdmission(port, seed)).resolves.toMatchObject({ allowed: false });
    }
  });

  it(`${evidence} fails closed when the port throws, rejects, returns a non-result, or returns a thenable`, async () => {
    const then = vi.fn(() => Promise.resolve({}));
    const ports = [
      { checkAndConsume: vi.fn(() => { throw new Error('unavailable'); }) },
      { checkAndConsume: vi.fn(() => Promise.reject(new Error('aborted'))) },
      { checkAndConsume: vi.fn(async () => true) },
      { checkAndConsume: vi.fn(() => ({ then })) },
    ];
    for (const port of ports) {
      await expect(enforcePublisherAdmission(port as never, request())).resolves.toMatchObject({ allowed: false });
    }
    expect(then).not.toHaveBeenCalled();
  });

  it(`${evidence} preserves receiver binding and snapshots the port method before await`, async () => {
    class BudgetPort {
      readonly marker = 'budget';
      readonly replacement = vi.fn(async () => ({ ceilings: [] }));
      async checkAndConsume(input: AtomicBudgetCharge): Promise<AtomicBudgetResult> {
        if (this.marker !== 'budget') throw new Error('lost receiver');
        Object.defineProperty(this, 'checkAndConsume', { value: this.replacement });
        return validResult(input);
      }
    }
    const port = new BudgetPort();
    await expect(enforcePublisherAdmission(port, request())).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(port.replacement).not.toHaveBeenCalled();
  });

  it(`${evidence} snapshots and freezes the atomic charge before await to prevent input TOCTOU`, async () => {
    let resolve!: (result: AtomicBudgetResult) => void;
    let captured!: AtomicBudgetCharge;
    const pending = new Promise<AtomicBudgetResult>((complete) => { resolve = complete; });
    const port = { checkAndConsume: vi.fn((charge: AtomicBudgetCharge) => { captured = charge; return pending; }) };
    const input = request();
    const decision = enforcePublisherAdmission(port, input);
    (input.operations as LeafOperation[])[0] = leaf('read', 1);
    (input.ceilings.subjectCredential as { limit: number }).limit = 1;
    resolve(validResult(captured));
    await expect(decision).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.ceilings)).toBe(true);
    expect(captured.ceilings.every(Object.isFrozen)).toBe(true);
    expect(captured.cost).toBe(10);
  });
});

describe(`${evidence} SEC-0013 subscription limits`, () => {
  it(`${evidence} accepts only when all six subscription dimensions are simultaneously present and within limits`, async () => {
    await expect(enforceSubscriptionLimits(subscriptionPort(), subscription())).resolves.toEqual({ allowed: true, reason: 'allowed' });
  });

  it(`${evidence} accepts the inclusive boundary for every subscription dimension`, async () => {
    await expect(enforceSubscriptionLimits(subscriptionPort(), subscription(defaultSubscriptionLimits))).resolves.toEqual({ allowed: true, reason: 'allowed' });
  });

  it(`${evidence} rejects each subscription dimension independently above its boundary`, async () => {
    for (const dimension of Object.keys(defaultSubscriptionLimits) as (keyof SubscriptionLimits)[]) {
      const limit = defaultSubscriptionLimits[dimension];
      await expect(enforceSubscriptionLimits(subscriptionPort(), subscription({ [dimension]: limit + 1 }))).resolves.toMatchObject({ allowed: false });
    }
  });

  it(`${evidence} fails closed when any subscription usage or limit dimension is missing`, async () => {
    for (const dimension of Object.keys(defaultSubscriptionLimits) as (keyof SubscriptionLimits)[]) {
      const usage = { ...defaultSubscriptionLimits } as Record<string, unknown>;
      delete usage[dimension];
      await expect(enforceSubscriptionLimits(subscriptionPort(), { ...subscription(), requested: usage as SubscriptionUsage })).resolves.toMatchObject({ allowed: false });

      const limits = { ...defaultSubscriptionLimits } as Record<string, unknown>;
      delete limits[dimension];
      await expect(enforceSubscriptionLimits(subscriptionPort(), { ...subscription(), limits: limits as SubscriptionLimits })).resolves.toMatchObject({ allowed: false });
    }
  });

  it(`${evidence} rejects invalid subscription numerics and hostile structured input`, async () => {
    for (const value of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(enforceSubscriptionLimits(subscriptionPort(), subscription({ queueBytes: value }))).resolves.toMatchObject({ allowed: false });
    }
    const getter = vi.fn(() => 1);
    const accessorUsage = Object.defineProperty({ ...defaultSubscriptionLimits }, 'connections', { get: getter });
    await expect(enforceSubscriptionLimits(subscriptionPort(), { ...subscription(), requested: accessorUsage })).resolves.toMatchObject({ allowed: false });
    await expect(enforceSubscriptionLimits(subscriptionPort(), { ...subscription(), requested: new Proxy(defaultSubscriptionLimits, {}) })).resolves.toMatchObject({ allowed: false });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe(`${evidence} SEC-0013 fixed decisions and SEC-0004 compatibility`, () => {
  it(`${evidence} returns frozen fixed secret-safe decisions on allow, limit, and malformed input paths`, async () => {
    const decisions = [
      await enforcePublisherAdmission(portWith(), request()),
      await enforcePublisherAdmission(portWith((charge) => ({
        ...validResult(charge),
        ceilings: validResult(charge).ceilings.map((result, index) => index === 0 ? { ...result, allowed: false } : result),
      })), request()),
      await enforcePublisherAdmission(portWith(), request({ operations: [] })),
      await enforceSubscriptionLimits(subscriptionPort(), subscription()),
      await enforceSubscriptionLimits(subscriptionPort(), subscription({ connections: 5 })),
    ];
    for (const decision of decisions) {
      expect(Object.isFrozen(decision)).toBe(true);
      const observable = `${String(decision)}\n${JSON.stringify(decision)}`;
      expect(observable).not.toContain('credential-secret-Aa9');
      expect(observable).not.toContain('instance-secret-Bb8');
      expect(observable).not.toContain('grant-secret-Cc7');
      expect(Object.keys(decision).sort()).toEqual(['allowed', 'reason']);
    }
  });

  it(`${evidence} preserves SEC-0004 three-dimensional charging semantics without SEC-0014 header assertions`, async () => {
    const port = portWith();
    const noGrant = request({ operations: [leaf('read', 5)], grant: null });
    await enforcePublisherAdmission(port, noGrant);
    expect(port.checkAndConsume).toHaveBeenCalledOnce();
    expect(port.checkAndConsume.mock.calls[0]?.[0].ceilings.map(({ dimension }) => dimension)).toEqual([
      'subject-credential',
      'ip',
      'instance',
    ]);
    expect(port.checkAndConsume.mock.calls[0]?.[0]).not.toHaveProperty('headers');
  });
});
