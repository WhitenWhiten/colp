import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import { McpRiskAggregationError } from '../../src/mcp/risk-aggregation.js';
import {
  createMcpWriteToolGateway,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const evidence = '[review:mcp-write.h07]';

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

const arbitraryEnvelopeSchema = Object.freeze({
  type: 'object' as const,
  additionalProperties: false,
  properties: Object.freeze({
    envelope: Object.freeze({
      type: 'object' as const,
      additionalProperties: false,
      properties: Object.freeze({
        command: Object.freeze({
          type: 'object' as const,
          additionalProperties: false,
          properties: Object.freeze({
            operation: Object.freeze({
              type: 'object' as const,
              additionalProperties: false,
              properties: Object.freeze({
                type: Object.freeze({ const: 'delete_collection' }),
                collectionId: Object.freeze({ type: 'string' as const, minLength: 1 }),
                baseRevision: Object.freeze({ type: 'string' as const, minLength: 1 }),
              }),
              required: Object.freeze(['type', 'collectionId', 'baseRevision']),
            }),
          }),
          required: Object.freeze(['operation']),
        }),
      }),
      required: Object.freeze(['command']),
    }),
  }),
  required: Object.freeze(['envelope']),
});

const arbitraryEnvelopeInput = Object.freeze({
  envelope: Object.freeze({
    command: Object.freeze({
      operation: Object.freeze({
        type: 'delete_collection' as const,
        collectionId: 'collection-1',
        baseRevision: 'collection-revision-1',
      }),
    }),
  }),
});

function registeredTool(
  toCanonicalOperations: (input: Readonly<Record<string, unknown>>) => unknown,
  invoke: (
    input: Readonly<Record<string, unknown>>,
    context: McpTrustedWriteRequestContext,
  ) => unknown = vi.fn(() => ({ ok: true })),
) {
  return {
    inputSchema: arbitraryEnvelopeSchema,
    outputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' as const },
        route: { type: 'string' as const, enum: ['high', 'low'] },
      },
    },
    toCanonicalOperations,
    invoke,
  };
}

function gatewayWith(tool: ReturnType<typeof registeredTool>) {
  return createMcpWriteToolGateway({
    changePlan: changePlanOptions(),
    lowRiskTools: { 'custom.enveloped_write': tool },
  } as never);
}

describe(`${evidence} registered canonical-operation adapters`, () => {
  it(`${evidence} rejects a high-risk operation extracted from an arbitrary envelope path`, async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const toCanonicalOperations = vi.fn((input: typeof arbitraryEnvelopeInput) => {
      return [input.envelope.command.operation];
    });
    const gateway = gatewayWith(registeredTool(toCanonicalOperations as never, invoke));

    const result = await gateway.callTool(
      'custom.enveloped_write',
      arbitraryEnvelopeInput,
      trustedContext(),
    );

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

  it(`${evidence} uses only the registered adapter result, not hard-coded input carriers`, async () => {
    const highInvoke = vi.fn(() => ({ route: 'high' }));
    const lowInvoke = vi.fn(() => ({ route: 'low' }));
    const highGateway = gatewayWith(registeredTool(() => [{
      type: 'delete_collection',
      collectionId: 'collection-1',
      baseRevision: 'collection-revision-1',
    }], highInvoke));
    const lowGateway = gatewayWith(registeredTool(() => [{
      type: 'custom.index_refresh',
      risk: 'low',
    }], lowInvoke));

    const highResult = await highGateway.callTool(
      'custom.enveloped_write',
      arbitraryEnvelopeInput,
      trustedContext(),
    );
    const lowResult = await lowGateway.callTool(
      'custom.enveloped_write',
      arbitraryEnvelopeInput,
      trustedContext(),
    );

    expect(highResult).toMatchObject({
      isError: true,
      structuredContent: { error: 'high_risk_requires_plan' },
    });
    expect(highInvoke).not.toHaveBeenCalled();
    expect(lowResult).toEqual({ structuredContent: { route: 'low' } });
    expect(lowInvoke).toHaveBeenCalledOnce();
  });

  it.each([
    ['a non-array result', null],
    ['an empty operation list', []],
    ['a malformed canonical operation', [{ type: 'delete_collection' }]],
    ['a canonical operation disguised as a low-risk descriptor', [{
      type: 'delete_collection',
      risk: 'low',
    }]],
    ['an unknown operation without an explicit trusted risk', [{ type: 'custom.unknown_operation' }]],
    ['a descriptor with a non-canonical risk', [{
      type: 'custom.index_refresh',
      risk: 'critical',
    }]],
    ['a malformed risk descriptor', [{
      type: 'custom.index_refresh',
      risk: 'low',
      unexpected: true,
    }]],
  ])(`${evidence} fails closed when the adapter returns %s`, async (_label, operations) => {
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = gatewayWith(registeredTool(() => operations, invoke));

    const operation = gateway.callTool(
      'custom.enveloped_write',
      arbitraryEnvelopeInput,
      trustedContext(),
    );
    await expect(operation).rejects.toBeInstanceOf(McpRiskAggregationError);
    await expect(operation).rejects.toMatchObject({
      name: 'McpRiskAggregationError',
      code: 'invalid_risk_input',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} aggregates mixed canonical operations at their highest risk`, async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = gatewayWith(registeredTool(() => [
      { type: 'custom.index_refresh', risk: 'low' },
      {
        type: 'set_visibility',
        collectionId: 'collection-1',
        baseRevision: 'access-revision-1',
        input: { visibility: 'private' },
      },
      {
        type: 'delete_collection',
        collectionId: 'collection-1',
        baseRevision: 'collection-revision-1',
      },
    ], invoke));

    const result = await gateway.callTool(
      'custom.enveloped_write',
      arbitraryEnvelopeInput,
      trustedContext(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: 'high_risk_requires_plan',
        assessment: { level: 'high', requiresPlan: true },
      },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} never dispatches an unregistered write tool`, async () => {
    const toCanonicalOperations = vi.fn(() => [{
      type: 'custom.index_refresh',
      risk: 'low',
    }]);
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = gatewayWith(registeredTool(toCanonicalOperations, invoke));

    await expect(gateway.callTool(
      'custom.unregistered_write',
      arbitraryEnvelopeInput,
      trustedContext(),
    )).rejects.toMatchObject({ code: 'unknown_tool' });
    expect(toCanonicalOperations).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
