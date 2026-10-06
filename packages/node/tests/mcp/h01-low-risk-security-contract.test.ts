import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import { McpToolOutputError } from '../../src/mcp/tool-input.js';
import {
  createMcpWriteToolGateway,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const evidence = '[review:mcp-write.h01]';

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
    // The gateway must carry this host-derived value through unchanged. Its
    // semantics belong to the host authorization layer, not to model input.
    authorization: Object.freeze({
      subject: 'subject-1',
      client: 'client-1',
      scopes: Object.freeze(['collections:write']),
    }),
  });
}

function lowRiskDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['private', 'public'] },
      },
      required: ['mode'],
    },
    outputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' as const },
        mode: { type: 'string' as const, enum: ['private', 'public'] },
      },
    },
    toCanonicalOperations: () => [{ type: 'custom.write', risk: 'low' as const }],
    invoke: () => ({ ok: true }),
    ...overrides,
  };
}

describe(`${evidence} trusted low-risk gateway boundary`, () => {
  it(`${evidence} rejects low-risk calls without a trusted authorization context`, async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({ invoke }),
      },
    } as never);

    await expect(
      gateway.callTool('custom.write', { mode: 'private' }, undefined as never),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/binding|required|authorization/i),
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects incomplete or accessor-backed authorization context`, async () => {
    const contextGetter = vi.fn(() => Object.freeze({ scopes: ['collections:write'] }));
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({ invoke }),
      },
    } as never);
    const binding = trustedContext().binding;
    const accessorContext = Object.defineProperty({ binding }, 'authorization', {
      configurable: true,
      enumerable: true,
      get: contextGetter,
    });

    await expect(
      gateway.callTool('custom.write', { mode: 'private' }, { binding } as never),
    ).rejects.toMatchObject({ code: 'binding_required' });
    await expect(
      gateway.callTool('custom.write', { mode: 'private' }, accessorContext as never),
    ).rejects.toMatchObject({ code: 'binding_required' });
    expect(contextGetter).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} passes the exact trusted context to canonicalization and execution`, async () => {
    const context = trustedContext();
    const seenContexts: unknown[] = [];
    const seenInputs: unknown[] = [];
    const descriptor = lowRiskDescriptor({
      toCanonicalOperations: (input: unknown, received: unknown) => {
        seenContexts.push(received);
        seenInputs.push(input);
        return [{ type: 'custom.write', risk: 'low' as const }];
      },
      invoke: (input: unknown, received: unknown) => {
        seenContexts.push(received);
        seenInputs.push(input);
        return { mode: (input as { mode: string }).mode };
      },
    });
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'custom.write': descriptor },
    } as never);

    const result = await gateway.callTool('custom.write', { mode: 'private' }, context);

    expect(result.structuredContent).toEqual({ mode: 'private' });
    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).toEqual(context);
    expect(seenContexts[1]).toEqual(context);
    expect(Object.isFrozen(seenContexts[0])).toBe(true);
    expect(Object.isFrozen(seenContexts[1])).toBe(true);
    expect(seenInputs[0]).toBe(seenInputs[1]);
    expect(Object.isFrozen(seenInputs[0])).toBe(true);
  });

  it.each([
    ['authorization denial', 'denied', 'forbidden'],
    ['concealment decision', 'conceal', 'not_found'],
    ['read-only deployment decision', 'read_only', 'read_only'],
  ] as const)(
    `${evidence} preserves the host residual %s and returns no model-visible success`,
    async (_label, outcome, code) => {
      const context = Object.freeze({
        ...trustedContext(),
        authorization: Object.freeze({ outcome }),
      });
      const denial = Object.assign(new Error('host authorization rejected the write'), { code });
      const invoke = vi.fn((
        _input: Readonly<Record<string, unknown>>,
        received: McpTrustedWriteRequestContext,
      ) => {
        if (received.authorization.outcome === outcome) throw denial;
        return { ok: true };
      });
      const gateway = createMcpWriteToolGateway({
        changePlan: changePlanOptions(),
        lowRiskTools: { 'custom.write': lowRiskDescriptor({ invoke }) },
      } as never);

      let returned: unknown;
      let rejected: unknown;
      try {
        returned = await gateway.callTool('custom.write', { mode: 'private' }, context);
      } catch (error) {
        rejected = error;
      }

      expect(returned).toBeUndefined();
      expect(rejected).toBe(denial);
      expect(rejected).toMatchObject({ code });
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'private' }),
        expect.objectContaining({ authorization: { outcome } }),
      );
    },
  );

  it(`${evidence} snapshots before application code can mutate caller-owned input`, async () => {
    const context = trustedContext();
    const source = { mode: 'private' };
    let adapterInput: Readonly<Record<string, unknown>> | undefined;
    let invokeInput: Readonly<Record<string, unknown>> | undefined;
    const invoke = vi.fn((input: Readonly<Record<string, unknown>>) => {
      invokeInput = input;
      return { mode: input.mode };
    });
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({
          toCanonicalOperations: (input: Readonly<Record<string, unknown>>) => {
            adapterInput = input;
            // Simulate a caller mutation between risk assessment and execution.
            source.mode = 'public';
            return [{ type: 'custom.write', risk: 'low' as const }];
          },
          invoke,
        }),
      },
    } as never);

    const result = await gateway.callTool('custom.write', source, context);

    expect(result.structuredContent).toEqual({ mode: 'private' });
    expect(adapterInput).toBe(invokeInput);
    expect(invoke).toHaveBeenCalledWith(adapterInput, expect.objectContaining({
      binding: context.binding,
      authorization: context.authorization,
    }));
    expect(invokeInput?.mode).toBe('private');
    expect(source.mode).toBe('public');
  });

  it(`${evidence} rejects accessor input without invoking the getter or application port`, async () => {
    const getter = vi.fn(() => 'private');
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: { 'custom.write': lowRiskDescriptor({ invoke }) },
    } as never);
    const input = Object.defineProperty({}, 'mode', {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    await expect(gateway.callTool('custom.write', input, trustedContext())).rejects.toMatchObject({
      code: 'invalid_tool_input',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects Proxy-backed context, input, and registrations before traps run`, async () => {
    const trap = vi.fn(() => {
      throw new Error('proxy trap must not run');
    });
    const context = new Proxy(trustedContext(), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
    });
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor(),
      },
    } as never);
    await expect(gateway.callTool('custom.write', { mode: 'private' }, context as never))
      .rejects.toMatchObject({ code: 'binding_required' });
    expect(trap).not.toHaveBeenCalled();

    const inputProxy = new Proxy({ mode: 'private' }, { get: trap, ownKeys: trap });
    await expect(gateway.callTool('custom.write', inputProxy, trustedContext()))
      .rejects.toMatchObject({ code: 'invalid_tool_input' });
    expect(trap).not.toHaveBeenCalled();

    const lowRiskProxy = new Proxy({ 'custom.write': lowRiskDescriptor() }, { ownKeys: trap });
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: lowRiskProxy,
    } as never)).toThrow(/Proxy|own-data/iu);
    expect(trap).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects open low-risk schemas at registration`, () => {
    expect(() => createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({
          inputSchema: {
            type: 'object',
            additionalProperties: true,
            properties: {},
          },
        }),
      },
    } as never)).toThrow(/closed|additionalProperties|schema/i);
  });

  it(`${evidence} rejects unknown properties before canonicalization or execution`, async () => {
    const toCanonicalOperations = vi.fn(() => [{ type: 'custom.write', risk: 'low' as const }]);
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({ toCanonicalOperations, invoke }),
      },
    } as never);

    await expect(
      gateway.callTool('custom.write', { mode: 'private', unexpected: true }, trustedContext()),
    ).rejects.toMatchObject({ code: 'invalid_tool_input' });
    expect(toCanonicalOperations).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} rejects a canonical high-risk operation from a low-risk descriptor`, async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({
          toCanonicalOperations: () => [{
            type: 'delete_collection',
            collectionId: 'collection-1',
            baseRevision: 'rev-1',
          }],
          invoke,
        }),
      },
    } as never);

    const result = await gateway.callTool('custom.write', { mode: 'private' }, trustedContext());

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'high_risk_requires_plan' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it(`${evidence} snapshots model-facing output and rejects accessor output`, async () => {
    const outputGetter = vi.fn(() => 'secret-like');
    const output = Object.defineProperty({}, 'value', {
      configurable: true,
      enumerable: true,
      get: outputGetter,
    });
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions(),
      lowRiskTools: {
        'custom.write': lowRiskDescriptor({ invoke: () => output }),
      },
    } as never);

    const operation = gateway.callTool('custom.write', { mode: 'private' }, trustedContext());
    await expect(operation).rejects.toBeInstanceOf(McpToolOutputError);
    await expect(operation).rejects.toMatchObject({
      name: 'McpToolOutputError',
      code: 'invalid_tool_output',
    });
    expect(outputGetter).not.toHaveBeenCalled();
  });
});
