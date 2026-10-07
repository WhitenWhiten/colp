/**
 * COLP-MCP-06: MCP Write Gateway trusted request context contract.
 *
 * The Write Gateway, low-risk Tool, risk/secret handling and write mount
 * surface are migrated to a per-request authenticated trusted context
 * (current binding, scope, budget, abort signal plus opaque host residual).
 * Every call re-accepts the current context; the gateway never captures or
 * reuses the Plan-creation request context object.
 *
 * Covers: anonymous rejection, current vs different binding, scope/risk
 * downgrade, timeout/abort, secret redaction, output validation, application
 * exception hiding, same/different idempotency replay, and Session public
 * absence on the Write gateway surface.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  McpChangePlanError,
  type McpChangePlanExecutorPort,
  type McpChangePlanScopePort,
} from '../../src/mcp/change-plan.js';
import { McpToolOutputError } from '../../src/mcp/tool-input.js';
import type { McpWriteInputBudget } from '../../src/mcp/safe-data.js';
import {
  createAnonymousPublicBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '../../src/mcp/shared/authorization.js';
import { structuredContentContainsSecret } from '../../src/mcp/secret-redaction.js';
import {
  createMcpWriteToolGateway,
  type McpTrustedWriteRequestContext,
} from '../../src/mcp/write-tools.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const evidence = '[evidence:mcp.trusted-write-context]';
const AUDIENCE = 'urn:colp:resource:public';
const EPOCH = 'epoch-2026-07-28-01';

const DEFAULT_BUDGET = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 1_048_576,
  maxOperations: 1_000,
});

function changePlanOptions(options: Readonly<{
  executor?: McpChangePlanExecutorPort | undefined;
  scopes?: McpChangePlanScopePort;
}> = {}) {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = options.executor ?? { execute: vi.fn(async () => []) };
  const scopes = options.scopes ?? { hasScopes: vi.fn(async () => true) };
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
    scopes,
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy: { allow: () => true },
  };
}

function trustedContext(overrides: Readonly<{
  binding?: McpAuthenticatedAuthorizationBinding;
  scope?: readonly string[];
  budget?: McpWriteInputBudget;
  abortSignal?: AbortSignal;
  authorization?: Readonly<Record<string, unknown>>;
}> = {}): McpTrustedWriteRequestContext {
  return Object.freeze({
    binding: overrides.binding ?? authenticatedBinding({
      principalId: 'principal-gw',
      clientId: 'client-gw',
    }),
    scope: overrides.scope ?? Object.freeze(['collections:write', 'access:write']),
    budget: overrides.budget ?? DEFAULT_BUDGET,
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    authorization: overrides.authorization ?? Object.freeze({
      subject: 'principal-gw',
      scopes: Object.freeze(['collections:write']),
    }),
  });
}

function lowRiskDescriptor(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { mode: { type: 'string' as const, enum: ['private', 'public'] } },
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

function lowRiskGateway(
  descriptor: ReturnType<typeof lowRiskDescriptor>,
  executor?: McpChangePlanExecutorPort,
) {
  return createMcpWriteToolGateway({
    changePlan: changePlanOptions({ executor }),
    lowRiskTools: { 'custom.write': descriptor },
  } as never);
}

function planRequest(operation: unknown = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-1',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
})) {
  return {
    operations: [operation],
    reason: 'User asked to publish the collection',
    dryRun: true as const,
  };
}

async function planAndApprove(
  gateway: ReturnType<typeof createMcpWriteToolGateway>,
  context: McpTrustedWriteRequestContext,
): Promise<string> {
  const planned = await gateway.callTool('changes.plan', planRequest(), context);
  const planId = (planned.structuredContent as { planId: string }).planId;
  await gateway.recordOutOfBandApproval(planId, context);
  return planId;
}

describe(`MCP 2026-07-28 Write Gateway trusted request context ${evidence}`, () => {
  it('rejects anonymous bindings on every write entry', async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = lowRiskGateway(lowRiskDescriptor({ invoke }));
    const anonymous = createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: EPOCH });
    const context = trustedContext({ binding: anonymous as never });

    await expect(gateway.callTool('changes.plan', planRequest(), context))
      .rejects.toMatchObject({ code: 'binding_required' });
    await expect(gateway.callTool('custom.write', { mode: 'private' }, context))
      .rejects.toMatchObject({ code: 'binding_required' });
    await expect(gateway.recordOutOfBandApproval('plan-gw', context))
      .rejects.toMatchObject({ code: 'binding_required' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an incomplete or accessor-backed trusted request context', async () => {
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = lowRiskGateway(lowRiskDescriptor({ invoke }));
    const binding = trustedContext().binding;
    const accessorContext = Object.defineProperty(
      { binding, scope: [], budget: DEFAULT_BUDGET, abortSignal: new AbortController().signal },
      'authorization',
      { configurable: true, enumerable: true, get: () => ({ scopes: ['collections:write'] }) },
    );

    await expect(gateway.callTool('custom.write', { mode: 'private' }, { binding } as never))
      .rejects.toMatchObject({ code: 'binding_required' });
    await expect(gateway.callTool('custom.write', { mode: 'private' }, accessorContext as never))
      .rejects.toMatchObject({ code: 'binding_required' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('re-accepts the current binding per call and rejects commit/approval with a different binding', async () => {
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-gw-binding',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-gw-binding',
        cursor: 'cur-gw-binding',
        warnings: Object.freeze([]) as readonly [],
      })]),
    };
    const gateway = createMcpWriteToolGateway({ changePlan: changePlanOptions({ executor }) });
    const contextA = trustedContext();
    const planId = await planAndApprove(gateway, contextA);

    const contextB = trustedContext({ binding: authenticatedBinding({ principalId: 'principal-other' }) });
    const commit = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-b' }, contextB)
      .then(() => undefined, (error: unknown) => error);
    expect(commit).toBeInstanceOf(McpChangePlanError);
    expect(commit).toMatchObject({ code: 'plan_binding_mismatch' });

    const approval = await gateway.recordOutOfBandApproval(planId, contextB)
      .then(() => undefined, (error: unknown) => error);
    expect(approval).toBeInstanceOf(McpChangePlanError);
    expect(approval).toMatchObject({ code: 'plan_binding_mismatch' });

    // The same principal's current context still completes the approved plan.
    const committed = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-a' }, contextA);
    expect(committed.structuredContent).toMatchObject({ planId });
  });

  it('re-runs the scope check at commit so a downgraded scope fails closed', async () => {
    const scopes = { hasScopes: vi.fn(async () => true) };
    const gateway = createMcpWriteToolGateway({ changePlan: changePlanOptions({ scopes }) });
    const context = trustedContext();
    const planId = await planAndApprove(gateway, context);

    // Scope revoked between Plan creation and Commit; the gateway must not
    // reuse the Plan-creation authorization decision.
    scopes.hasScopes.mockResolvedValue(false);
    const commit = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-scope' }, context)
      .then(() => undefined, (error: unknown) => error);
    expect(commit).toBeInstanceOf(McpChangePlanError);
    expect(commit).toMatchObject({ code: 'scope_invalid' });
  });

  it('re-runs the one-shot risk gate per call so a downgraded adapter cannot complete', async () => {
    let call = 0;
    const invoke = vi.fn(() => ({ ok: true }));
    const toCanonicalOperations = vi.fn(() => {
      call += 1;
      return call === 1
        ? [{ type: 'custom.write', risk: 'low' as const }]
        : [{ type: 'delete_collection', collectionId: 'collection-1', baseRevision: 'r1' }];
    });
    const gateway = lowRiskGateway(lowRiskDescriptor({ toCanonicalOperations, invoke }));

    const first = await gateway.callTool('custom.write', { mode: 'private' }, trustedContext());
    expect(first.structuredContent).toEqual({ ok: true });

    const second = await gateway.callTool('custom.write', { mode: 'private' }, trustedContext());
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({ error: 'high_risk_requires_plan' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a request aborted before the call without invoking the application', async () => {
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn(() => ({ ok: true }));
    const gateway = lowRiskGateway(lowRiskDescriptor({ invoke }));

    await expect(
      gateway.callTool('custom.write', { mode: 'private' }, trustedContext({ abortSignal: controller.signal })),
    ).rejects.toMatchObject({ code: 'request_aborted' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('threads the live abort signal to application ports and hides an aborted mid-flight result', async () => {
    const controller = new AbortController();
    let resolveInvoke!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolvePromise) => { resolveInvoke = resolvePromise; });
    const seenSignals: AbortSignal[] = [];
    const invoke = vi.fn((_input: unknown, received: McpTrustedWriteRequestContext) => {
      seenSignals.push(received.abortSignal);
      return pending;
    });
    const gateway = lowRiskGateway(lowRiskDescriptor({ invoke }));

    const operation = gateway.callTool('custom.write', { mode: 'private' }, trustedContext({
      abortSignal: controller.signal,
    }));
    controller.abort();
    resolveInvoke({ ok: true });

    await expect(operation).rejects.toMatchObject({ code: 'request_aborted' });
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(seenSignals[0]!.aborted).toBe(true);
  });

  it('propagates a host timeout signalled through the request abort without a model-visible success', async () => {
    const controller = new AbortController();
    const invoke = vi.fn((_input: unknown, received: McpTrustedWriteRequestContext) => new Promise((_resolve, reject) => {
      received.abortSignal.addEventListener('abort', () => {
        reject(Object.assign(new Error('MCP Tool call timed out.'), { code: 'timed_out' }));
      });
    }));
    const gateway = lowRiskGateway(lowRiskDescriptor({ invoke }));

    const operation = gateway.callTool('custom.write', { mode: 'private' }, trustedContext({
      abortSignal: controller.signal,
    }));
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: 'timed_out' });
  });

  it('never returns plaintext secrets through the Plan/Commit key redaction path', async () => {
    const secretValue = 'colp_live_gateway_secret';
    const revealUriForKey = vi.fn((keyId: string) =>
      `https://alice.example/collections/keys/${keyId}/reveal`);
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-gw-key',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-gw-key',
        cursor: 'cur-gw-key',
        warnings: Object.freeze([]) as readonly [],
        transform: Object.freeze({
          keyId: 'key-gw-1',
          secretAvailable: true,
          revealUri: 'https://alice.example/collections/keys/key-gw-1/reveal',
          apiKey: secretValue,
        }),
      })]),
    };
    const gateway = createMcpWriteToolGateway({
      changePlan: changePlanOptions({ executor }),
      revealUriForKey,
    } as never);
    const context = trustedContext();
    const planId = await planAndApprove(gateway, context);

    const committed = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-gw-secret' }, context);
    const json = JSON.stringify(committed);
    expect(json).not.toContain(secretValue);
    expect(json).not.toContain('"apiKey"');
    expect(structuredContentContainsSecret(committed.structuredContent)).toBe(false);
  });

  it('fails closed when application output violates the closed outputSchema', async () => {
    const gateway = lowRiskGateway(lowRiskDescriptor({
      invoke: () => ({ ok: 'not-a-boolean' }),
    }));
    const operation = gateway.callTool('custom.write', { mode: 'private' }, trustedContext());
    await expect(operation).rejects.toBeInstanceOf(McpToolOutputError);
    await expect(operation).rejects.toMatchObject({ code: 'invalid_tool_output' });
  });

  it('hides application exceptions: they reject the call instead of becoming a model-visible success', async () => {
    const denial = Object.assign(new Error('host authorization rejected the write'), { code: 'forbidden' });
    const invoke = vi.fn(() => { throw denial; });
    const gateway = lowRiskGateway(lowRiskDescriptor({ invoke }));

    let resolved: unknown;
    let rejected: unknown;
    try {
      resolved = await gateway.callTool('custom.write', { mode: 'private' }, trustedContext());
    } catch (error) {
      rejected = error;
    }
    expect(resolved).toBeUndefined();
    expect(rejected).toBe(denial);
    expect(rejected).toMatchObject({ code: 'forbidden' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('replays the same idempotency key and rejects a different key after consumption', async () => {
    const executor = {
      execute: vi.fn(async () => [Object.freeze({
        opId: 'op-gw-1',
        sequence: 1,
        status: 'applied' as const,
        revision: 'r-gw-1',
        cursor: 'cur-gw-1',
        warnings: Object.freeze([]) as readonly [],
      })]),
    };
    const gateway = createMcpWriteToolGateway({ changePlan: changePlanOptions({ executor }) });
    const context = trustedContext();
    const planId = await planAndApprove(gateway, context);

    const first = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-same' }, context);
    const replay = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-same' }, context);
    expect(replay).toEqual(first);
    expect(executor.execute).toHaveBeenCalledTimes(1);

    const different = await gateway.callTool('changes.commit', { planId, idempotencyKey: 'idem-different' }, context)
      .then(() => undefined, (error: unknown) => error);
    expect(different).toBeInstanceOf(McpChangePlanError);
    expect(different).toMatchObject({ code: 'plan_already_consumed' });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps Session identifiers and the Write Gateway out of the /mcp public surface', () => {
    const mcpIndexSource = readFileSync(
      resolve(import.meta.dirname, '..', '..', 'src', 'mcp', 'index.ts'),
      'utf8',
    );
    // COLP-MCP-12: the /mcp entry only exports the Modern Read/shared surface;
    // the Write Gateway module stays internal and is never re-exported.
    expect(mcpIndexSource).not.toContain("from './write-tools.js'");
    expect(mcpIndexSource).not.toContain("from './write-mount.js'");
    expect(mcpIndexSource).not.toMatch(/\bMcpTrustedWriteRequestContext\b/u);
    expect(mcpIndexSource).not.toMatch(/\bsessionId\b/u);
    expect(mcpIndexSource).not.toMatch(/\bMcpSessionBinding\b/u);
    expect(mcpIndexSource).not.toMatch(/\bMcpPlanBinding\b/u);

    for (const file of ['write-tools.ts', 'write-mount.ts']) {
      const source = readFileSync(
        resolve(import.meta.dirname, '..', '..', 'src', 'mcp', file),
        'utf8',
      );
      expect(source, file).not.toMatch(/\bsessionId\b/u);
      expect(source, file).not.toMatch(/\bMcpSessionBinding\b/u);
      expect(source, file).not.toMatch(/\bMcpPlanBinding\b/u);
    }
  });
});
