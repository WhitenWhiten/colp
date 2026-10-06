import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import {
  aggregateHighestRisk,
  assessCanonicalOperations,
  assertOneShotToolAllowed,
  assessLeafTypeRisk,
  assessToolCallRisk,
  expandOperations,
  McpHighRiskRequiresPlanError,
  McpRiskAggregationError,
  type RiskLevel,
} from '../../src/mcp/risk-aggregation.js';
import {
  createMcpWriteToolGateway,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import { propertyOptions } from '../helpers/property-options.js';

function changePlanOptions() {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = { execute: vi.fn(async () => []) };
  return {
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => ({
      collections: 0,
      nodes: 0,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    })) },
    revisions: {
      resolveBaseRevisions: vi.fn(async (operation) => resolveFixtureBaseRevisions(operation)),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    },
    scopes: { hasScopes: vi.fn(async () => true) },
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy: { allow: () => true },
  };
}

function trustedContext(): McpTrustedWriteRequestContext {
  return Object.freeze({
    binding: authenticatedBinding({
      principalId: 'subject-1',
      clientId: 'client-1',
    }),
    scope: Object.freeze(['collections:write']),
    budget: Object.freeze({
      maxDepth: 32,
      maxNodes: 10_000,
      maxBytes: 1_048_576,
      maxOperations: 1_000,
    }),
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({
      subject: 'subject-1',
      scopes: Object.freeze(['collections:write']),
    }),
  });
}

const arbitraryWrapperSchema = Object.freeze({
  type: 'object' as const,
  additionalProperties: false,
  properties: Object.freeze({
    route: Object.freeze({
      type: 'array' as const,
      items: Object.freeze({ type: 'string' as const, pattern: '^[a-z][a-z0-9_]{0,11}$' }),
      minItems: 1,
      maxItems: 6,
    }),
    wrapper: Object.freeze({}),
  }),
  required: Object.freeze(['route', 'wrapper']),
});

function extractAtRoute(input: Readonly<Record<string, unknown>>): unknown {
  const route = input.route as readonly string[];
  let current = input.wrapper;
  for (const segment of route) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new TypeError('Wrapper route does not resolve to canonical operations.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Wrapper route must resolve through own data properties.');
    }
    current = descriptor.value;
  }
  return current;
}

function wrapAtRoute(route: readonly string[], value: unknown): Readonly<Record<string, unknown>> {
  if (route.length === 0) throw new TypeError('Wrapper route must not be empty.');
  let wrapped = value;
  for (let index = route.length - 1; index >= 0; index -= 1) {
    wrapped = Object.freeze({ [route[index]!]: wrapped });
  }
  return wrapped as Readonly<Record<string, unknown>>;
}

function registeredWrapperGateway(
  toCanonicalOperations: (input: Readonly<Record<string, unknown>>) => unknown,
  invoke: (input: Readonly<Record<string, unknown>>) => unknown = () => ({ ok: true }),
) {
  return createMcpWriteToolGateway({
    changePlan: changePlanOptions(),
    lowRiskTools: {
      'custom.randomized_write': {
        inputSchema: arbitraryWrapperSchema,
        outputSchema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: { ok: { type: 'boolean' as const } },
        },
        toCanonicalOperations,
        invoke,
      },
    },
  } as never);
}

function expectStableRiskInputError(work: () => unknown): McpRiskAggregationError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(McpRiskAggregationError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({
      code: 'invalid_risk_input',
      message: 'MCP risk input exceeded the configured resource budget.',
    });
    return error as McpRiskAggregationError;
  }
  throw new Error('Expected risk assessment to reject its input.');
}

function canonicalSnapshotBytes(
  operations: readonly Readonly<{ type: string; risk: RiskLevel }>[],
): number {
  return 1 + operations.reduce(
    (total, operation) => total + 33 + (operation.type.length + operation.risk.length) * 4,
    0,
  );
}

function expectedHighestRisk(risks: readonly RiskLevel[]): RiskLevel {
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

const wrapperPropertyOptions = propertyOptions(40);
const budgetPropertyOptions = propertyOptions(40);

describe('MCP-0003 risk aggregation [evidence:mcp.risk-aggregation]', () => {
  it('keeps risk aggregation importable from its module [evidence:mcp.risk-aggregation]', () => {
    expect(typeof assessCanonicalOperations).toBe('function');
    expect(typeof assessToolCallRisk).toBe('function');
    expect(typeof expandOperations).toBe('function');
    expect(typeof aggregateHighestRisk).toBe('function');
    expect(typeof assertOneShotToolAllowed).toBe('function');
  });

  it('aggregates the highest risk among expanded leaf operations [evidence:mcp.risk-aggregation]', () => {
    expect(aggregateHighestRisk(['low', 'medium', 'high'])).toBe('high');
    expect(aggregateHighestRisk(['low', 'medium'])).toBe('medium');
    expect(aggregateHighestRisk(['low'])).toBe('low');
    expect(aggregateHighestRisk([])).toBe('low');
  });

  it('uses a registered adapter for high risk hidden at an arbitrary wrapper path [evidence:mcp.risk-aggregation]', async () => {
    const route = ['transport', 'document', 'command'] as const;
    const canonical = [{
      type: 'delete_collection',
      collectionId: 'collection-1',
      baseRevision: 'collection-revision-1',
    }] as const;
    const input = {
      route,
      wrapper: wrapAtRoute(route, canonical),
    };
    const invoke = vi.fn(() => ({ ok: true }));
    const toCanonicalOperations = vi.fn((snapshot: Readonly<Record<string, unknown>>) => (
      extractAtRoute(snapshot)
    ));
    const gateway = registeredWrapperGateway(toCanonicalOperations, invoke);

    // The carrier-name walker is compatibility diagnostics, not an authorization oracle.
    expect(gateway.assessRisk('custom.randomized_write', input)).toMatchObject({
      level: 'low',
      requiresPlan: false,
    });

    const result = await gateway.callTool('custom.randomized_write', input, trustedContext());

    expect(toCanonicalOperations).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: 'high_risk_requires_plan',
        assessment: { level: 'high', requiresPlan: true },
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('property-checks arbitrary wrappers and canonical highest-risk aggregation [evidence:mcp.risk-aggregation]', async () => {
    let adapted: unknown;
    const toCanonicalOperations = vi.fn((snapshot: Readonly<Record<string, unknown>>) => {
      adapted = extractAtRoute(snapshot);
      return adapted;
    });
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = registeredWrapperGateway(toCanonicalOperations, invoke);
    const routeArbitrary = fc.uniqueArray(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/u),
      { minLength: 1, maxLength: 6 },
    );
    const risksArbitrary = fc.array(
      fc.constantFrom<RiskLevel>('low', 'medium', 'high'),
      { minLength: 1, maxLength: 16 },
    );

    await fc.assert(fc.asyncProperty(routeArbitrary, risksArbitrary, async (route, risks) => {
      adapted = undefined;
      toCanonicalOperations.mockClear();
      invoke.mockClear();
      const canonical = risks.map((risk, index) => ({
        type: `custom.generated_${index}`,
        risk,
      }));
      const input = {
        route,
        wrapper: wrapAtRoute(route, canonical),
      };
      const expected = expectedHighestRisk(risks);

      const result = await gateway.callTool('custom.randomized_write', input, trustedContext());
      const assessment = assessCanonicalOperations(adapted);

      expect(toCanonicalOperations).toHaveBeenCalledOnce();
      expect(assessment).toMatchObject({
        level: expected,
        affectedObjects: risks.length,
        requiresPlan: expected === 'high',
      });
      expect(assessment.expanded.map((operation) => operation.risk)).toEqual(risks);
      if (expected === 'high') {
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: 'high_risk_requires_plan' },
        });
        expect(invoke).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ structuredContent: { ok: true } });
        expect(invoke).toHaveBeenCalledOnce();
      }
    }), wrapperPropertyOptions);
  });

  it('rejects sparse and over-wide canonical arrays with stable protocol errors [evidence:mcp.risk-aggregation]', () => {
    const sparse = new Array<unknown>(3);
    sparse[0] = { type: 'custom.first', risk: 'low' };
    sparse[2] = { type: 'custom.third', risk: 'high' };
    expectStableRiskInputError(() => assessCanonicalOperations(sparse));

    const reflected = 'wide-canonical-value-must-not-escape';
    const wide = Array.from({ length: 2_048 }, (_, index) => ({
      type: index === 0 ? reflected : `custom.operation_${index}`,
      risk: 'low' as const,
    }));
    const error = expectStableRiskInputError(() => assessCanonicalOperations(wide, {
      maxDepth: 4,
      maxNodes: 10_000,
      maxBytes: 1_048_576,
      maxOperations: 1_024,
    }));
    expect(error.message).not.toContain(reflected);
  });

  it('property-checks combined depth, node, byte, and operation budgets [evidence:mcp.risk-aggregation]', () => {
    fc.assert(fc.property(fc.array(
      fc.constantFrom<RiskLevel>('low', 'medium', 'high'),
      { minLength: 2, maxLength: 24 },
    ), (risks) => {
      const canonical = risks.map((risk, index) => ({
        type: `custom.operation_${index}`,
        risk,
      }));
      const exactBudget = {
        maxDepth: 2,
        maxNodes: 1 + canonical.length * 3,
        maxBytes: canonicalSnapshotBytes(canonical),
        maxOperations: canonical.length,
      };

      expect(assessCanonicalOperations(canonical, exactBudget)).toMatchObject({
        level: expectedHighestRisk(risks),
        affectedObjects: canonical.length,
      });
      for (const budget of [
        { ...exactBudget, maxDepth: exactBudget.maxDepth - 1 },
        { ...exactBudget, maxNodes: exactBudget.maxNodes - 1 },
        { ...exactBudget, maxBytes: exactBudget.maxBytes - 1 },
        { ...exactBudget, maxOperations: exactBudget.maxOperations - 1 },
      ]) {
        expectStableRiskInputError(() => assessCanonicalOperations(canonical, budget));
      }
    }), budgetPropertyOptions);
  });

  it('rejects accessor and Proxy canonical values without executing traps [evidence:mcp.risk-aggregation]', () => {
    const getter = vi.fn(() => 'delete_collection');
    const accessorOperation = Object.defineProperty({ risk: 'high' }, 'type', {
      enumerable: true,
      get: getter,
    });
    expectStableRiskInputError(() => assessCanonicalOperations([accessorOperation]));
    expect(getter).not.toHaveBeenCalled();

    const trap = vi.fn(() => {
      throw new Error('canonical Proxy trap must not run');
    });
    const proxyOperation = new Proxy({ type: 'custom.operation', risk: 'low' }, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
    });
    expectStableRiskInputError(() => assessCanonicalOperations([proxyOperation]));
    expect(trap).not.toHaveBeenCalled();
  });

  it('reuses one frozen parsed-JSON snapshot despite caller mutation after dispatch [evidence:mcp.risk-aggregation]', async () => {
    let releaseInvoke!: () => void;
    const invokeBlocked = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });
    let adapterInput: Readonly<Record<string, unknown>> | undefined;
    let invokeInput: Readonly<Record<string, unknown>> | undefined;
    const toCanonicalOperations = vi.fn((snapshot: Readonly<Record<string, unknown>>) => {
      adapterInput = snapshot;
      return extractAtRoute(snapshot);
    });
    const invoke = vi.fn(async (snapshot: Readonly<Record<string, unknown>>) => {
      invokeInput = snapshot;
      await invokeBlocked;
      return { ok: true };
    });
    const gateway = registeredWrapperGateway(toCanonicalOperations, invoke);
    const parsedInput = JSON.parse(JSON.stringify({
      route: ['payload', 'command'],
      wrapper: {
        payload: {
          command: [{ type: 'custom.index_refresh', risk: 'low' }],
        },
      },
    })) as {
      route: string[];
      wrapper: { payload: { command: Array<{ type: string; risk: RiskLevel }> } };
    };
    const entryValue = JSON.parse(JSON.stringify(parsedInput));

    const pending = gateway.callTool('custom.randomized_write', parsedInput, trustedContext());
    parsedInput.route[0] = 'mutated';
    parsedInput.wrapper.payload.command[0]!.risk = 'high';
    releaseInvoke();
    const result = await pending;

    expect(result).toEqual({ structuredContent: { ok: true } });
    expect(adapterInput).toBe(invokeInput);
    expect(adapterInput).not.toBe(parsedInput);
    expect(adapterInput).toEqual(entryValue);
    expect(Object.isFrozen(adapterInput)).toBe(true);
    expect(Object.isFrozen(adapterInput?.route)).toBe(true);
    expect(Object.isFrozen(adapterInput?.wrapper)).toBe(true);
    const snapshotWrapper = adapterInput?.wrapper as Readonly<{
      payload: Readonly<{ command: readonly Readonly<{ risk: RiskLevel }>[] }>;
    }>;
    expect(Object.isFrozen(snapshotWrapper.payload)).toBe(true);
    expect(Object.isFrozen(snapshotWrapper.payload.command)).toBe(true);
    expect(Object.isFrozen(snapshotWrapper.payload.command[0])).toBe(true);
    expect(parsedInput).toMatchObject({
      route: ['mutated', 'command'],
      wrapper: { payload: { command: [{ risk: 'high' }] } },
    });
  });

  // These carrier-name heuristics are diagnostic compatibility only. Executable
  // write authorization is covered above through registered canonical adapters.
  it('diagnostically assesses known carriers at their highest risk [evidence:mcp.risk-aggregation]', () => {
    const expanded = expandOperations({
      operations: [
        { type: 'nodes.create', collectionId: 'c1' },
        {
          type: 'batch',
          operations: [
            { type: 'annotations.create' },
            {
              type: 'set_visibility',
              collectionId: 'collection-1',
              baseRevision: 'acl_17',
              input: { visibility: 'public' },
            },
          ],
        },
      ],
    });

    expect(expanded.some((item) => item.type === 'set_visibility' && item.risk === 'high')).toBe(true);
    expect(aggregateHighestRisk(expanded.map((item) => item.risk))).toBe('high');
  });

  it('expands generic batch envelopes with payload.operations [evidence:mcp.risk-aggregation]', () => {
    const expanded = expandOperations({
      type: 'generic_batch',
      payload: {
        operations: [
          { type: 'create_key', input: { name: 'k' } },
          { type: 'nodes.create' },
        ],
      },
    });
    expect(expanded.map((item) => item.type)).toEqual(expect.arrayContaining(['create_key']));
    expect(aggregateHighestRisk(expanded.map((item) => item.risk))).toBe('high');
  });

  it('expands sync.push-style envelopes containing high-risk operations [evidence:mcp.risk-aggregation]', () => {
    const assessment = assessToolCallRisk('sync.push', {
      collectionId: 'collection-1',
      operations: [
        { type: 'nodes.update', targetId: 'n1' },
        { type: 'delete_collection', collectionId: 'collection-1', baseRevision: 'r1' },
      ],
    });
    expect(assessment.level).toBe('high');
    expect(assessment.requiresPlan).toBe(true);
    expect(assessment.expanded.some((item) => item.type === 'delete_collection')).toBe(true);
  });

  it('retains the legacy one-shot compatibility gate for known carriers [evidence:mcp.risk-aggregation]', () => {
    expect(() => assertOneShotToolAllowed('keys.create', { name: 'reader' }))
      .toThrow(McpHighRiskRequiresPlanError);

    expect(() =>
      assertOneShotToolAllowed('sync.push', {
        operations: [{ type: 'create_key', input: { name: 'x' } }],
      }),
    ).toThrow(McpHighRiskRequiresPlanError);

    expect(() =>
      assertOneShotToolAllowed('custom.batch', {
        batch: [
          { type: 'nodes.create' },
          { type: 'set_access_policy', collectionId: 'c1', baseRevision: 'r1', input: {} },
        ],
      }),
    ).toThrow(McpHighRiskRequiresPlanError);
  });

  it('reports low risk through the legacy compatibility gate [evidence:mcp.risk-aggregation]', () => {
    const assessment = assertOneShotToolAllowed('nodes.create', {
      collectionId: 'c1',
      parentId: 'root',
      node: { type: 'bookmark' },
    });
    expect(assessment.requiresPlan).toBe(false);
    expect(assessment.level).toBe('low');
  });

  it('diagnostically retains nested risk beneath an outer medium tool [evidence:mcp.risk-aggregation]', () => {
    // sync.push is medium by itself, but nested high-risk wins.
    expect(assessLeafTypeRisk('sync.push')).toBe('medium');
    const assessment = assessToolCallRisk('sync.push', {
      items: [{ type: 'keys.rotate', targetId: 'key-1' }],
    });
    expect(assessment.level).toBe('high');
    expect(assessment.requiresPlan).toBe(true);
  });

  it('treats public visibility changes as high risk [evidence:mcp.risk-aggregation]', () => {
    expect(assessLeafTypeRisk('set_visibility', {
      input: { visibility: 'public' },
    })).toBe('high');
    expect(assessLeafTypeRisk('set_visibility', {
      input: { visibility: 'private' },
    })).toBe('medium');
    expect(assessLeafTypeRisk('access.visibility', { visibility: 'unlisted' })).toBe('high');
  });

  it('assesses always-high leaf plan operation types [evidence:mcp.risk-aggregation]', () => {
    for (const type of [
      'delete_collection',
      'delete_subtree',
      'set_access_policy',
      'create_key',
      'rotate_key',
      'revoke_key',
      'set_rate_limit',
      'publish_release',
      'sync_mirror',
    ] as const) {
      expect(assessLeafTypeRisk(type), type).toBe('high');
    }
  });

  it('expands untyped payload.operations without dropping parent type risk [evidence:mcp.risk-aggregation]', () => {
    // Untyped envelope: no outer type, but payload.operations carries high-risk leaves.
    const untyped = expandOperations({
      payload: {
        operations: [
          { type: 'create_key', input: { name: 'k' } },
        ],
      },
    });
    expect(untyped.some((item) => item.type === 'create_key' && item.risk === 'high')).toBe(true);
    expect(aggregateHighestRisk(untyped.map((item) => item.risk))).toBe('high');

    // Parent type risk retained alongside nested expansion (not dropped).
    const withParent = expandOperations({
      type: 'generic_batch',
      payload: {
        operations: [{ type: 'nodes.create' }],
      },
    });
    expect(withParent.some((item) => item.type === 'generic_batch' && item.path === '$')).toBe(true);
    expect(withParent.some((item) => item.type === 'nodes.create')).toBe(true);

    // The legacy compatibility gate recognizes this known carrier shape.
    expect(() =>
      assertOneShotToolAllowed('custom.envelope', {
        payload: {
          operations: [{ type: 'delete_collection', collectionId: 'c1', baseRevision: 'r1' }],
        },
      }),
    ).toThrow(McpHighRiskRequiresPlanError);
  });
});
