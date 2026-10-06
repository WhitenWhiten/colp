import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import {
  assessCanonicalOperations,
  expandOperations,
  McpRiskAggregationError,
} from '../../src/mcp/risk-aggregation.js';
import {
  DEFAULT_MCP_WRITE_INPUT_BUDGET,
  resolveMcpWriteInputBudget,
  snapshotMcpData,
  type McpWriteInputBudget,
} from '../../src/mcp/safe-data.js';
import { McpToolOutputError } from '../../src/mcp/tool-input.js';
import { createMcpWriteMountAdapter } from '../../src/mcp/write-mount.js';
import {
  createMcpWriteToolGateway,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const evidence = '[review:mcp-write.m02]';
const stableBudgetMessage = 'MCP risk input exceeded the configured resource budget.';
const manifestFixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

const generousBudget = Object.freeze({
  maxDepth: 32,
  maxNodes: 1_000_000,
  maxBytes: 64_000_000,
  maxOperations: 200_000,
} satisfies McpWriteInputBudget);

function changePlanOptions() {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = { execute: vi.fn(async () => []) };
  return {
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => ({
      collections: 1,
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

function trustedContext(budget?: McpWriteInputBudget): McpTrustedWriteRequestContext {
  return Object.freeze({
    binding: authenticatedBinding({
      principalId: 'subject-1',
      clientId: 'client-1',
    }),
    scope: Object.freeze(['collections:write']),
    budget: budget ?? Object.freeze({
      maxDepth: 32,
      maxNodes: 10_000,
      maxBytes: 1_048_576,
      maxOperations: 1_000,
    }),
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({ scopes: Object.freeze(['collections:write']) }),
  });
}

function operation(index: number) {
  return Object.freeze({
    type: 'delete_collection' as const,
    collectionId: `collection-${index}`,
    baseRevision: `revision-${index}`,
  });
}

function lowRiskDescriptor(
  toCanonicalOperations: () => unknown,
  invoke: () => unknown = () => ({ ok: true }),
) {
  return {
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        value: { type: 'string' as const },
      },
    },
    outputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' as const },
        privateValue: { type: 'string' as const },
      },
    },
    toCanonicalOperations,
    invoke,
  };
}

function captureError(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected work to throw.');
}

async function captureRejection(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected work to reject.');
}

function expectStableRiskBudgetError(error: Error, reflectedValue?: string): void {
  expect(error).toBeInstanceOf(McpRiskAggregationError);
  expect(error).not.toBeInstanceOf(RangeError);
  expect(error).toMatchObject({
    code: 'invalid_risk_input',
    message: stableBudgetMessage,
  });
  if (reflectedValue !== undefined) expect(error.message).not.toContain(reflectedValue);
}

describe(`${evidence} shared MCP write input budgets`, () => {
  it(`${evidence} exposes one finite default budget`, () => {
    expect(DEFAULT_MCP_WRITE_INPUT_BUDGET).toEqual({
      maxDepth: 32,
      maxNodes: 10_000,
      maxBytes: 1_048_576,
      maxOperations: 1_000,
    });
    expect(Object.isFrozen(DEFAULT_MCP_WRITE_INPUT_BUDGET)).toBe(true);
  });

  it(`${evidence} accepts exactly maxDepth and rejects the next level`, () => {
    const value = { nested: {} };
    expect(snapshotMcpData(value, { maxDepth: 1 })).toEqual(value);
    expect(() => snapshotMcpData(value, { maxDepth: 0 }))
      .toThrow('MCP data exceeded snapshot depth budget.');
  });

  it(`${evidence} accepts exactly maxNodes and rejects the next node`, () => {
    const value = { value: true };
    expect(snapshotMcpData(value, { maxNodes: 2 })).toEqual(value);
    expect(() => snapshotMcpData(value, { maxNodes: 1 }))
      .toThrow('MCP data exceeded snapshot node budget.');
  });

  it(`${evidence} accepts exactly maxBytes and rejects the next estimated byte`, () => {
    const value = { value: true };
    expect(snapshotMcpData(value, { maxBytes: 29 })).toEqual(value);
    expect(() => snapshotMcpData(value, { maxBytes: 28 }))
      .toThrow('MCP data exceeded snapshot byte budget.');
  });

  it(`${evidence} counts object property names against maxBytes before copying values`, () => {
    const longKey = 'k'.repeat(100);
    expect(snapshotMcpData({ [longKey]: true }, { maxBytes: 409 })).toEqual({ [longKey]: true });
    expect(() => snapshotMcpData({ [longKey]: true }, { maxBytes: 408 }))
      .toThrow('MCP data exceeded snapshot byte budget.');
  });

  it(`${evidence} reads budget options without invoking accessors or Proxy traps`, () => {
    const getter = vi.fn(() => 1);
    const accessorBudget = Object.defineProperty({}, 'maxBytes', {
      enumerable: true,
      get: getter,
    }) as McpWriteInputBudget;
    expect(() => resolveMcpWriteInputBudget(accessorBudget))
      .toThrow('MCP write input budget must use own data properties.');
    expect(getter).not.toHaveBeenCalled();

    const proxyGet = vi.fn(() => 1);
    const proxyBudget = new Proxy({}, { get: proxyGet }) as McpWriteInputBudget;
    expect(() => resolveMcpWriteInputBudget(proxyBudget))
      .toThrow('MCP write input budget must be an own-data object.');
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it(`${evidence} accepts exactly maxOperations and rejects the next leaf`, () => {
    const input = { operations: [
      { type: 'custom.first' },
      { type: 'custom.second' },
      { type: 'custom.third' },
    ] };
    const exact = expandOperations(input, '$', 0, { ...generousBudget, maxOperations: 3 });
    expect(exact.map((item) => item.type)).toEqual([
      'custom.first',
      'custom.second',
      'custom.third',
    ]);

    const error = captureError(() => {
      expandOperations(input, '$', 0, { ...generousBudget, maxOperations: 2 });
    });
    expectStableRiskBudgetError(error);
  });

  it(`${evidence} maps exact depth node and byte boundaries into stable risk errors`, () => {
    const input = { type: 'custom.write' };
    const exactBudget = {
      maxDepth: 1,
      maxNodes: 2,
      maxBytes: 65,
      maxOperations: 1,
    };
    expect(expandOperations(input, '$', 0, exactBudget)).toMatchObject([
      { type: 'custom.write', risk: 'low', path: '$' },
    ]);

    for (const budget of [
      { ...exactBudget, maxDepth: 0 },
      { ...exactBudget, maxNodes: 1 },
      { ...exactBudget, maxBytes: 64 },
    ]) {
      const error = captureError(() => expandOperations(input, '$', 0, budget));
      expectStableRiskBudgetError(error);
    }
  });

  it(`${evidence} applies the same operation budget to canonical and legacy expansion`, () => {
    const canonical = [
      { type: 'custom.first', risk: 'low' as const },
      { type: 'custom.second', risk: 'medium' as const },
      { type: 'custom.third', risk: 'low' as const },
    ];
    const legacy = { operations: canonical.map(({ type }) => ({ type })) };
    const exactBudget = { ...generousBudget, maxOperations: 3 };

    expect(assessCanonicalOperations(canonical, exactBudget).affectedObjects).toBe(3);
    expect(expandOperations(legacy, '$', 0, exactBudget)).toHaveLength(3);

    const canonicalError = captureError(() => {
      assessCanonicalOperations(canonical, { ...generousBudget, maxOperations: 2 });
    });
    const legacyError = captureError(() => {
      expandOperations(legacy, '$', 0, { ...generousBudget, maxOperations: 2 });
    });
    expectStableRiskBudgetError(canonicalError);
    expectStableRiskBudgetError(legacyError);
    expect(canonicalError.message).toBe(legacyError.message);
  });

  it(`${evidence} counts every combination carrier and its typed parent`, () => {
    const input = {
      type: 'custom.parent',
      operations: [{ type: 'custom.operations' }],
      payload: {
        operations: [{ type: 'custom.payload_operations' }],
        items: [{ type: 'custom.payload_items' }],
        batch: [{ type: 'custom.payload_batch' }],
        changes: [{ type: 'custom.payload_changes' }],
      },
      items: [{ type: 'custom.items' }],
      batch: [{ type: 'custom.batch' }],
      changes: [{ type: 'custom.changes' }],
    };
    const exact = expandOperations(input, '$', 0, { ...generousBudget, maxOperations: 9 });
    expect(exact).toHaveLength(9);
    expect(new Set(exact.map((item) => item.type))).toEqual(new Set([
      'custom.parent',
      'custom.operations',
      'custom.payload_operations',
      'custom.payload_items',
      'custom.payload_batch',
      'custom.payload_changes',
      'custom.items',
      'custom.batch',
      'custom.changes',
    ]));

    expectStableRiskBudgetError(captureError(() => {
      expandOperations(input, '$', 0, { ...generousBudget, maxOperations: 8 });
    }));
  });

  it(`${evidence} rejects sparse carriers with a stable non-reflective protocol error`, () => {
    const secret = 'sparse-secret-must-not-escape';
    const sparse = new Array<unknown>(3);
    sparse[0] = { type: 'custom.first', secret };
    sparse[2] = { type: 'custom.third' };

    const error = captureError(() => {
      expandOperations({ operations: sparse }, '$', 0, generousBudget);
    });
    expectStableRiskBudgetError(error, secret);
  });

  it(`${evidence} rejects 150k leaves without an engine RangeError or reflected input`, () => {
    const secret = 'wide-secret-must-not-escape';
    const operations = Array.from({ length: 150_000 }, (_, index) => ({
      type: index === 0 ? secret : 'custom.write',
    }));

    const error = captureError(() => expandOperations({ operations }));
    expectStableRiskBudgetError(error, secret);
  });

  it(`${evidence} rejects an ultra-wide object with the same stable error`, () => {
    const secret = 'object-secret-must-not-escape';
    const wide: Record<string, unknown> = { type: 'custom.write', secret };
    for (let index = 0; index < 20_000; index += 1) wide[`field_${index}`] = index;

    const error = captureError(() => expandOperations(wide));
    expectStableRiskBudgetError(error, secret);
  });
});

describe(`${evidence} gateway budget propagation`, () => {
  it(`${evidence} publishes changes.plan maxItems from the runtime maxOperations budget`, async () => {
    const inputBudget = { ...generousBudget, maxOperations: 2 };
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      inputBudget,
    });
    const definition = gateway.listTools().find((tool) => tool.name === 'changes.plan');
    const properties = definition?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.operations?.maxItems).toBe(2);

    await expect(gateway.callTool('changes.plan', {
      operations: [operation(1), operation(2)],
      reason: 'exact operation limit',
      dryRun: true,
    }, trustedContext())).resolves.toMatchObject({
      structuredContent: { requiresApproval: true },
    });

    const error = await captureRejection(() => gateway.callTool('changes.plan', {
      operations: [operation(1), operation(2), operation(3)],
      reason: 'one operation over the limit',
      dryRun: true,
    }, trustedContext()));
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: 'invalid_tool_input' });
  });

  it(`${evidence} enforces the same changes.plan limit below the Tool schema boundary`, async () => {
    const inputBudget = { ...generousBudget, maxOperations: 2 };
    const service = createChangePlanService({
      ...changePlanOptions(),
      inputBudget,
    });
    await expect(service.plan({
      operations: [operation(1), operation(2)],
      reason: 'exact service operation limit',
      dryRun: true,
    }, trustedContext().binding)).resolves.toMatchObject({ requiresApproval: true });

    const error = await captureRejection(() => service.plan({
      operations: [operation(1), operation(2), operation(3)],
      reason: 'service operation limit exceeded',
      dryRun: true,
    }, trustedContext().binding));
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: 'invalid_plan_request' });
  });

  it(`${evidence} carries maxBytes into the pre-schema input snapshot without reflection`, async () => {
    const secret = 'input-secret-must-not-escape';
    const toCanonicalOperations = vi.fn(() => [{ type: 'custom.write', risk: 'low' as const }]);
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor(toCanonicalOperations, invoke),
      },
    } as never);

    const error = await captureRejection(() => gateway.callTool(
      'custom.write',
      { value: secret.repeat(100) },
      trustedContext({ maxDepth: 32, maxNodes: 100, maxBytes: 256, maxOperations: 4 }),
    ));
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: 'invalid_tool_input' });
    expect(error.message).not.toContain(secret);
    expect(toCanonicalOperations).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} carries maxOperations into the registered canonical adapter boundary`, async () => {
    const secret = 'adapter-secret-must-not-escape';
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor(() => [
          { type: secret, risk: 'low' as const },
          { type: 'custom.second', risk: 'low' as const },
        ], invoke),
      },
    } as never);

    const error = await captureRejection(() => gateway.callTool(
      'custom.write',
      {},
      trustedContext({ ...generousBudget, maxOperations: 1 }),
    ));
    expectStableRiskBudgetError(error, secret);
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} carries maxBytes into model-facing output without reflecting output`, async () => {
    const secret = 'output-secret-must-not-escape';
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor(
          () => [{ type: 'custom.write', risk: 'low' as const }],
          () => ({ privateValue: secret.repeat(100) }),
        ),
      },
    } as never);

    const error = await captureRejection(() => gateway.callTool(
      'custom.write',
      {},
      trustedContext({ maxDepth: 32, maxNodes: 100, maxBytes: 256, maxOperations: 4 }),
    ));
    expect(error).toBeInstanceOf(McpToolOutputError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({
      name: 'McpToolOutputError',
      code: 'invalid_tool_output',
    });
    expect((error as McpToolOutputError).issues).toContainEqual({
      instancePath: '',
      keyword: 'dataProperty',
      message: expect.stringMatching(/resource budget/i),
    });
    expect(error.message).not.toContain(secret);
  });

  it(`${evidence} exposes an explicit pre-parse body-byte host contract`, () => {
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      inputBudget: { ...generousBudget, maxBytes: 4_096 },
    });

    expect(gateway.transportRequirements).toEqual({
      maxRequestBodyBytes: 4_096,
      enforceBeforeJsonParsing: true,
    });
    expect(Object.isFrozen(gateway.transportRequirements)).toBe(true);
  });

  it(`${evidence} carries the pre-parse byte contract through the mount adapter`, async () => {
    const manifest = JSON.parse(await readFile(manifestFixturePath, 'utf8')) as {
      mounts: Array<{ id: string }>;
    };
    const exposure = createMcpWriteMountAdapter(manifest, {
      mountId: manifest.mounts[0]!.id,
      writeTools: {
        changePlan: changePlanOptions(),
        inputBudget: { ...generousBudget, maxBytes: 8_192 },
      },
    } as never);

    expect(exposure.transportRequirements).toBe(exposure.tools.transportRequirements);
    expect(exposure.transportRequirements).toEqual({
      maxRequestBodyBytes: 8_192,
      enforceBeforeJsonParsing: true,
    });
  });
});
