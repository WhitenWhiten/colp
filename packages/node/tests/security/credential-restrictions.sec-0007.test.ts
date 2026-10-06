import { describe, expect, it, vi } from 'vitest';

import { enforceCredentialRestrictions } from '../../src/security/index.js';
import type {
  CredentialClockPort,
  CredentialNodeSubtreePort,
  CredentialOperationBudgetPort,
  CredentialRestriction,
  CredentialRestrictionPorts,
  CredentialRestrictionRequest,
} from '../../src/security/index.js';

const evidence = '[evidence:security.credential-restrictions]';
const now = Date.parse('2026-07-18T04:00:00.000Z');

function restriction(overrides: Partial<CredentialRestriction> = {}): CredentialRestriction {
  return {
    collectionAllowlist: ['collection-a'],
    nodeSubtrees: [{ collectionId: 'collection-a', rootNodeId: 'folder-a' }],
    ipAllowlist: ['203.0.113.7'],
    originAllowlist: ['https://console.example.test'],
    maxOperations: 5,
    notBefore: now - 3_600_000,
    expiresAt: now + 3_600_000,
    allowPublicExposure: false,
    ...overrides,
  };
}

function request(overrides: Partial<CredentialRestrictionRequest> = {}): CredentialRestrictionRequest {
  return {
    credentialId: 'key-42',
    restrictions: [restriction()],
    collectionId: 'collection-a',
    nodeId: 'bookmark-a',
    ipAddress: '203.0.113.7',
    origin: 'https://console.example.test',
    operationCost: 2,
    publicExposure: false,
    ...overrides,
  };
}

function nodePort(allowed = true): CredentialNodeSubtreePort {
  return { isAllowed: vi.fn(async () => allowed) };
}

function budgetPort(allowed = true): CredentialOperationBudgetPort {
  return { checkAndConsume: vi.fn(async () => allowed) };
}

function ports(
  nodeSubtree: CredentialNodeSubtreePort = nodePort(),
  operationBudget: CredentialOperationBudgetPort = budgetPort(),
  currentTime = now,
): CredentialRestrictionPorts {
  return { nodeSubtree, operationBudget, clock: { now: vi.fn(() => currentTime) } };
}

describe(`${evidence} SEC-0007 credential restrictions`, () => {
  it(`${evidence} allows only when every configured restriction matches`, async () => {
    const subtree = nodePort();
    const budget = budgetPort();

    await expect(enforceCredentialRestrictions(ports(subtree, budget), request())).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
    expect(subtree.isAllowed).toHaveBeenCalledOnce();
    expect(subtree.isAllowed).toHaveBeenCalledWith({
      collectionId: 'collection-a',
      nodeId: 'bookmark-a',
      allowedRootNodeIdsByRestriction: [['folder-a']],
    });
    expect(budget.checkAndConsume).toHaveBeenCalledOnce();
    expect(budget.checkAndConsume).toHaveBeenCalledWith({
      credentialId: 'key-42',
      cost: 2,
      maxOperations: 5,
    });
  });

  it(`${evidence} denies a collection outside the allowlist and an empty allowlist`, async () => {
    await expect(
      enforceCredentialRestrictions(ports(), request({ collectionId: 'collection-b' })),
    ).resolves.toEqual({ allowed: false, reason: 'collection_denied' });
    await expect(
      enforceCredentialRestrictions(
        ports(),
        request({ restrictions: [restriction({ collectionAllowlist: [] })] }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'collection_denied' });
  });

  it(`${evidence} accepts the subtree root itself and a resolved descendant`, async () => {
    const rootPort = nodePort();
    await expect(
      enforceCredentialRestrictions(ports(rootPort), request({ nodeId: 'folder-a' })),
    ).resolves.toMatchObject({ allowed: true });
    expect(rootPort.isAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'folder-a', allowedRootNodeIdsByRestriction: [['folder-a']] }),
    );

    const descendantPort = nodePort();
    await expect(enforceCredentialRestrictions(ports(descendantPort), request())).resolves.toMatchObject({
      allowed: true,
    });
    expect(descendantPort.isAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'bookmark-a', allowedRootNodeIdsByRestriction: [['folder-a']] }),
    );
  });

  it(`${evidence} denies subtree mismatch or a missing target and fails closed on resolver failure`, async () => {
    await expect(enforceCredentialRestrictions(ports(nodePort(false)), request())).resolves.toEqual({
      allowed: false,
      reason: 'node_denied',
    });
    const { nodeId: _nodeId, ...missingTarget } = request();
    await expect(
      enforceCredentialRestrictions(ports(), missingTarget as CredentialRestrictionRequest),
    ).resolves.toEqual({ allowed: false, reason: 'node_denied' });
    await expect(
      enforceCredentialRestrictions(
        { operationBudget: budgetPort(), clock: { now: () => now } },
        request(),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'port_failure' });

    const throwing: CredentialNodeSubtreePort = {
      isAllowed() {
        throw new Error('resolver unavailable');
      },
    };
    const rejecting: CredentialNodeSubtreePort = {
      isAllowed: vi.fn(() => Promise.reject(new Error('snapshot aborted'))),
    };
    for (const subtree of [throwing, rejecting]) {
      await expect(enforceCredentialRestrictions(ports(subtree), request())).resolves.toEqual({
        allowed: false,
        reason: 'port_failure',
      });
    }
  });

  it(`${evidence} matches exact and subnet IPv4 and IPv6 addresses`, async () => {
    const restrictions = [restriction({
      ipAllowlist: [
        '198.51.100.7',
        '2001:db8:1::7',
        { address: '203.0.113.0', prefixLength: 24 },
        { address: '2001:db8::', prefixLength: 64 },
      ],
    })];
    await expect(enforceCredentialRestrictions(ports(), request({ restrictions }))).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      enforceCredentialRestrictions(ports(), request({ restrictions, ipAddress: '2001:db8::7' })),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforceCredentialRestrictions(ports(), request({ restrictions, ipAddress: '198.51.100.7' })),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      enforceCredentialRestrictions(ports(), request({ restrictions, ipAddress: '2001:db8:1::7' })),
    ).resolves.toMatchObject({ allowed: true });
  });

  it(`${evidence} denies IP mismatch or absence and fails closed on invalid addresses`, async () => {
    const { ipAddress: _ipAddress, ...missingIp } = request();
    await expect(enforceCredentialRestrictions(ports(), request({ ipAddress: '203.0.113.8' }))).resolves.toEqual({
      allowed: false,
      reason: 'ip_denied',
    });
    await expect(
      enforceCredentialRestrictions(ports(), missingIp as CredentialRestrictionRequest),
    ).resolves.toEqual({ allowed: false, reason: 'ip_denied' });
    await expect(
      enforceCredentialRestrictions(
        ports(),
        request({ restrictions: [restriction({ ipAllowlist: ['203.0.113.999'] })] }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
    await expect(
      enforceCredentialRestrictions(ports(), request({ ipAddress: '203.0.113.7/32' })),
    ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
    for (const ipAllowlist of [
      [{ address: '203.0.113.0', prefixLength: 33 }],
      [{ address: '2001:db8::', prefixLength: 129 }],
      [{ address: 'not-an-ip', prefixLength: 24 }],
    ] satisfies CredentialRestriction['ipAllowlist'][]) {
      await expect(
        enforceCredentialRestrictions(ports(), request({ restrictions: [restriction({ ipAllowlist })] })),
      ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
    }
  });

  it(`${evidence} canonicalizes a standard Origin before matching`, async () => {
    await expect(
      enforceCredentialRestrictions(
        ports(),
        request({
          restrictions: [restriction({ originAllowlist: ['https://console.example.test:443'] })],
          origin: 'https://CONSOLE.example.test',
        }),
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it(`${evidence} denies Origin mismatch or absence and fails closed on opaque or non-Origin values`, async () => {
    const { origin: _origin, ...missingOrigin } = request();
    await expect(
      enforceCredentialRestrictions(ports(), request({ origin: 'https://admin.example.test' })),
    ).resolves.toEqual({ allowed: false, reason: 'origin_denied' });
    await expect(
      enforceCredentialRestrictions(ports(), missingOrigin as CredentialRestrictionRequest),
    ).resolves.toEqual({ allowed: false, reason: 'origin_denied' });
    for (const origin of ['null', 'data:text/plain,opaque', 'https://console.example.test/path']) {
      await expect(enforceCredentialRestrictions(ports(), request({ origin }))).resolves.toEqual({
        allowed: false,
        reason: 'invalid_input',
      });
    }
  });

  it(`${evidence} rejects before notBefore and allows its inclusive boundary`, async () => {
    const restrictions = [restriction({ notBefore: now })];
    const clock = vi.fn(() => now);
    await expect(enforceCredentialRestrictions(ports(nodePort(), budgetPort(), now - 1), request({ restrictions })))
      .resolves.toEqual({ allowed: false, reason: 'outside_validity' });
    await expect(enforceCredentialRestrictions(ports(nodePort(), budgetPort(), now), request({ restrictions })))
      .resolves.toMatchObject({ allowed: true });
    await expect(
      enforceCredentialRestrictions(
        { nodeSubtree: nodePort(), operationBudget: budgetPort(), clock: { now: clock } },
        request({ restrictions }),
      ),
    ).resolves.toMatchObject({ allowed: true });
    expect(clock).toHaveBeenCalledOnce();
    await expect(
      enforceCredentialRestrictions(
        { nodeSubtree: nodePort(), operationBudget: budgetPort() },
        request({ restrictions }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'port_failure' });
  });

  it(`${evidence} preserves class port receivers and calls each required method once`, async () => {
    class StatefulClock implements CredentialClockPort {
      calls = 0;
      readonly #currentTime = now;

      now(): number {
        this.calls += 1;
        return this.#currentTime;
      }
    }
    class StatefulNodeSubtree implements CredentialNodeSubtreePort {
      calls = 0;
      readonly #allowed = true;

      async isAllowed(): Promise<boolean> {
        this.calls += 1;
        return this.#allowed;
      }
    }
    class StatefulOperationBudget implements CredentialOperationBudgetPort {
      calls = 0;
      #remaining = 2;

      async checkAndConsume(input: { readonly cost: number }): Promise<boolean> {
        this.calls += 1;
        if (input.cost > this.#remaining) return false;
        this.#remaining -= input.cost;
        return true;
      }
    }

    const clock = new StatefulClock();
    const nodeSubtree = new StatefulNodeSubtree();
    const operationBudget = new StatefulOperationBudget();
    await expect(
      enforceCredentialRestrictions({ clock, nodeSubtree, operationBudget }, request()),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(clock.calls).toBe(1);
    expect(nodeSubtree.calls).toBe(1);
    expect(operationBudget.calls).toBe(1);
  });

  it(`${evidence} accepts null-prototype ports and custom prototype data methods`, async () => {
    const clockPrototype = {
      now(this: { readonly currentTime: number }): number {
        return this.currentTime;
      },
    };
    const clock = Object.assign(
      Object.create(clockPrototype) as object,
      { currentTime: now },
    ) as unknown as CredentialClockPort;
    const nodeSubtree = Object.assign(Object.create(null) as object, {
      isAllowed: vi.fn(async () => true),
    }) as CredentialNodeSubtreePort;
    const operationBudget = Object.assign(Object.create(null) as object, {
      checkAndConsume: vi.fn(async () => true),
    }) as CredentialOperationBudgetPort;

    await expect(
      enforceCredentialRestrictions({ clock, nodeSubtree, operationBudget }, request()),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(nodeSubtree.isAllowed).toHaveBeenCalledOnce();
    expect(operationBudget.checkAndConsume).toHaveBeenCalledOnce();
  });

  it(`${evidence} never fills missing port methods from Object.prototype pollution`, async () => {
    const poisonedNow = vi.fn(() => now);
    const poisonedIsAllowed = vi.fn(async () => true);
    const poisonedCheckAndConsume = vi.fn(async () => true);
    const methodNames = ['now', 'isAllowed', 'checkAndConsume'] as const;
    for (const methodName of methodNames) {
      expect(Object.getOwnPropertyDescriptor(Object.prototype, methodName)).toBeUndefined();
    }

    Object.defineProperties(Object.prototype, {
      now: { configurable: true, value: poisonedNow },
      isAllowed: { configurable: true, value: poisonedIsAllowed },
      checkAndConsume: { configurable: true, value: poisonedCheckAndConsume },
    });
    try {
      await expect(
        enforceCredentialRestrictions(
          { clock: {} as CredentialClockPort, nodeSubtree: nodePort(), operationBudget: budgetPort() },
          request(),
        ),
      ).resolves.toEqual({ allowed: false, reason: 'port_failure' });
      await expect(
        enforceCredentialRestrictions(
          {
            clock: { now: () => now },
            nodeSubtree: {} as CredentialNodeSubtreePort,
            operationBudget: budgetPort(),
          },
          request(),
        ),
      ).resolves.toEqual({ allowed: false, reason: 'port_failure' });
      await expect(
        enforceCredentialRestrictions(
          {
            clock: { now: () => now },
            nodeSubtree: nodePort(),
            operationBudget: {} as CredentialOperationBudgetPort,
          },
          request(),
        ),
      ).resolves.toEqual({ allowed: false, reason: 'port_failure' });
      expect(poisonedNow).not.toHaveBeenCalled();
      expect(poisonedIsAllowed).not.toHaveBeenCalled();
      expect(poisonedCheckAndConsume).not.toHaveBeenCalled();
    } finally {
      for (const methodName of methodNames) {
        Reflect.deleteProperty(Object.prototype, methodName);
      }
    }

    for (const methodName of methodNames) {
      expect(Object.getOwnPropertyDescriptor(Object.prototype, methodName)).toBeUndefined();
    }
  });

  it(`${evidence} rejects at expiresAt and fails closed on invalid validity times`, async () => {
    const restrictions = [restriction({ expiresAt: now })];
    await expect(enforceCredentialRestrictions(ports(), request({ restrictions }))).resolves.toEqual({
      allowed: false,
      reason: 'outside_validity',
    });

    for (const invalid of [Number.NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        enforceCredentialRestrictions(
          ports(),
          request({ restrictions: [restriction({ notBefore: invalid })] }),
        ),
      ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
    }
    await expect(
      enforceCredentialRestrictions(
        ports(),
        request({ restrictions: [restriction({ notBefore: now, expiresAt: now })] }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it(`${evidence} denies Public Exposure by default and allows only an explicit opt-in`, async () => {
    const { allowPublicExposure: _allowPublicExposure, ...defaultRestriction } = restriction();
    await expect(
      enforceCredentialRestrictions(
        ports(),
        request({ restrictions: [defaultRestriction], publicExposure: true }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'public_exposure_denied' });
    await expect(
      enforceCredentialRestrictions(ports(), request({ restrictions: [], publicExposure: true })),
    ).resolves.toEqual({ allowed: false, reason: 'public_exposure_denied' });
    await expect(
      enforceCredentialRestrictions(
        ports(),
        request({ restrictions: [restriction({ allowPublicExposure: true })], publicExposure: true }),
      ),
    ).resolves.toMatchObject({ allowed: true });
  });

  it(`${evidence} consumes maxOperations once atomically and denies an exhausted budget`, async () => {
    const available = budgetPort(true);
    const exhausted = budgetPort(false);
    await expect(enforceCredentialRestrictions(ports(nodePort(), available), request())).resolves.toMatchObject({
      allowed: true,
    });
    await expect(enforceCredentialRestrictions(ports(nodePort(), exhausted), request())).resolves.toEqual({
      allowed: false,
      reason: 'operation_limit_denied',
    });
    expect(available.checkAndConsume).toHaveBeenCalledOnce();
    expect(exhausted.checkAndConsume).toHaveBeenCalledOnce();
    await expect(
      enforceCredentialRestrictions(
        { nodeSubtree: nodePort(), clock: { now: () => now } },
        request(),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'port_failure' });
  });

  it(`${evidence} snapshots the budget method before awaiting the subtree port`, async () => {
    const originalConsume = vi.fn(async () => true);
    const replacementConsume = vi.fn(async () => false);
    const operationBudget: CredentialOperationBudgetPort = { checkAndConsume: originalConsume };
    const nodeSubtree: CredentialNodeSubtreePort = {
      isAllowed: vi.fn(async () => {
        Object.defineProperty(operationBudget, 'checkAndConsume', { value: replacementConsume });
        return true;
      }),
    };

    await expect(
      enforceCredentialRestrictions(ports(nodeSubtree, operationBudget), request()),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
    expect(originalConsume).toHaveBeenCalledOnce();
    expect(replacementConsume).not.toHaveBeenCalled();
  });

  it(`${evidence} fails closed when the atomic operation consume throws or rejects`, async () => {
    const throwing: CredentialOperationBudgetPort = {
      checkAndConsume() {
        throw new Error('counter unavailable');
      },
    };
    const rejecting: CredentialOperationBudgetPort = {
      checkAndConsume: vi.fn(() => Promise.reject(new Error('transaction aborted'))),
    };
    for (const operationBudget of [throwing, rejecting]) {
      await expect(enforceCredentialRestrictions(ports(nodePort(), operationBudget), request())).resolves.toEqual({
        allowed: false,
        reason: 'port_failure',
      });
    }
  });

  it(`${evidence} never consumes operations after a static restriction rejects`, async () => {
    const budget = budgetPort();
    await expect(
      enforceCredentialRestrictions(ports(nodePort(), budget), request({ collectionId: 'collection-b' })),
    ).resolves.toMatchObject({ allowed: false });
    expect(budget.checkAndConsume).not.toHaveBeenCalled();

    const getter = vi.fn(() => budgetPort());
    const accessorPorts = Object.defineProperty(ports(), 'operationBudget', { get: getter });
    await expect(
      enforceCredentialRestrictions(accessorPorts, request({ collectionId: 'collection-b' })),
    ).resolves.toEqual({ allowed: false, reason: 'collection_denied' });
    expect(getter).not.toHaveBeenCalled();
  });

  it(`${evidence} accepts only positive safe-integer operation cost`, async () => {
    for (const operationCost of [1, Number.MAX_SAFE_INTEGER]) {
      await expect(
        enforceCredentialRestrictions(
          ports(),
          request({
            operationCost,
            restrictions: [restriction({ maxOperations: Number.MAX_SAFE_INTEGER })],
          }),
        ),
      ).resolves.toMatchObject({ allowed: true });
    }
    for (const operationCost of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity]) {
      const budget = budgetPort();
      await expect(enforceCredentialRestrictions(ports(nodePort(), budget), request({ operationCost })))
        .resolves.toEqual({ allowed: false, reason: 'invalid_input' });
      expect(budget.checkAndConsume).not.toHaveBeenCalled();
    }
  });

  it(`${evidence} fails closed on restriction accessors and configuration Proxies`, async () => {
    const getter = vi.fn(() => ['collection-a']);
    const accessor = Object.defineProperty(restriction(), 'collectionAllowlist', {
      get: getter,
    }) as CredentialRestriction;
    const proxy = new Proxy(restriction(), {});

    for (const configured of [accessor, proxy]) {
      await expect(
        enforceCredentialRestrictions(ports(), request({ restrictions: [configured] })),
      ).resolves.toEqual({ allowed: false, reason: 'invalid_input' });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it(`${evidence} fails closed on request accessors, Proxies, sparse lists, and dynamic list mutation`, async () => {
    const getter = vi.fn(() => 'collection-a');
    const accessor = Object.defineProperty(request(), 'collectionId', { get: getter });
    const proxy = new Proxy(request(), {});
    const sparse = new Array<CredentialRestriction>(1);
    const dynamic = [restriction()];
    Object.defineProperty(dynamic, '0', { get: vi.fn(() => restriction()) });
    const malformed = [
      accessor,
      proxy,
      request({ restrictions: sparse }),
      request({ restrictions: dynamic }),
    ] as readonly CredentialRestrictionRequest[];

    for (const input of malformed) {
      const budget = budgetPort();
      await expect(enforceCredentialRestrictions(ports(nodePort(), budget), input)).resolves.toEqual({
        allowed: false,
        reason: 'invalid_input',
      });
      expect(budget.checkAndConsume).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();

    const secret = 'credential-secret-must-not-echo';
    await expect(
      enforceCredentialRestrictions(ports(), request({ credentialId: secret, operationCost: 0 })),
    ).resolves.not.toEqual(expect.objectContaining({ credentialId: secret }));
  });

  it(`${evidence} intersects every restriction source so one permissive source cannot bypass another`, async () => {
    const permissive = restriction({
      collectionAllowlist: ['collection-a', 'collection-b'],
      nodeSubtrees: [
        { collectionId: 'collection-a', rootNodeId: 'root' },
        { collectionId: 'collection-b', rootNodeId: 'root' },
      ],
      ipAllowlist: ['203.0.113.7', '203.0.113.8'],
      originAllowlist: ['https://console.example.test', 'https://other.example.test'],
      maxOperations: 100,
      allowPublicExposure: true,
    });
    const restrictive = restriction({ maxOperations: 3 });
    const subtree = nodePort();
    const budget = budgetPort();

    await expect(
      enforceCredentialRestrictions(
        ports(subtree, budget),
        request({ restrictions: [permissive, restrictive], operationCost: 3 }),
      ),
    ).resolves.toMatchObject({ allowed: true });
    expect(subtree.isAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRootNodeIdsByRestriction: [['root'], ['folder-a']] }),
    );
    expect(budget.checkAndConsume).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 3, maxOperations: 3 }),
    );

    for (const input of [
      request({ restrictions: [permissive, restrictive], collectionId: 'collection-b' }),
      request({ restrictions: [permissive, restrictive], ipAddress: '203.0.113.8' }),
      request({ restrictions: [permissive, restrictive], origin: 'https://other.example.test' }),
      request({ restrictions: [permissive, restrictive], publicExposure: true }),
    ]) {
      await expect(enforceCredentialRestrictions(ports(), input)).resolves.toMatchObject({ allowed: false });
    }

    const nonBooleanNode = { isAllowed: vi.fn(async () => 'yes') } as unknown as CredentialNodeSubtreePort;
    const nonBooleanBudget = { checkAndConsume: vi.fn(async () => 1) } as unknown as CredentialOperationBudgetPort;
    await expect(enforceCredentialRestrictions(ports(nonBooleanNode), request())).resolves.toEqual({
      allowed: false,
      reason: 'port_failure',
    });
    await expect(enforceCredentialRestrictions(ports(nodePort(), nonBooleanBudget), request())).resolves.toEqual({
      allowed: false,
      reason: 'port_failure',
    });

    const portGetter = vi.fn(() => nodePort());
    const accessorPorts = Object.defineProperty(ports(), 'nodeSubtree', { get: portGetter });
    await expect(enforceCredentialRestrictions(accessorPorts, request())).resolves.toEqual({
      allowed: false,
      reason: 'port_failure',
    });
    expect(portGetter).not.toHaveBeenCalled();
    const methodGetter = vi.fn(() => nodePort().isAllowed);
    const accessorNodePort = Object.defineProperty({}, 'isAllowed', { get: methodGetter }) as CredentialNodeSubtreePort;
    await expect(enforceCredentialRestrictions(ports(accessorNodePort), request())).resolves.toEqual({
      allowed: false,
      reason: 'port_failure',
    });
    expect(methodGetter).not.toHaveBeenCalled();
    const inheritedMethodGetter = vi.fn(() => nodePort().isAllowed);
    const accessorPrototype = Object.defineProperty({}, 'isAllowed', { get: inheritedMethodGetter });
    const inheritedAccessorNodePort = Object.create(accessorPrototype) as CredentialNodeSubtreePort;
    await expect(enforceCredentialRestrictions(ports(inheritedAccessorNodePort), request())).resolves.toEqual({
      allowed: false,
      reason: 'port_failure',
    });
    expect(inheritedMethodGetter).not.toHaveBeenCalled();
    await expect(
      enforceCredentialRestrictions(ports(new Proxy(nodePort(), {})), request()),
    ).resolves.toEqual({ allowed: false, reason: 'port_failure' });
    await expect(enforceCredentialRestrictions(new Proxy(ports(), {}), request())).resolves.toEqual({
      allowed: false,
      reason: 'port_failure',
    });

    const manyRestrictions = Array<CredentialRestriction>(150_000).fill({ maxOperations: 1 });
    const largeListBudget = budgetPort();
    await expect(
      enforceCredentialRestrictions(
        { operationBudget: largeListBudget },
        request({ restrictions: manyRestrictions, operationCost: 2 }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'operation_limit_denied' });
    expect(largeListBudget.checkAndConsume).not.toHaveBeenCalled();
  });
});
