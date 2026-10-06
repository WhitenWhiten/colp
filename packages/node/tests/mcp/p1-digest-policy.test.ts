/** Core/gateway digest-policy parity. Fixture transactions do not prove database atomicity. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createChangePlanService, createInMemoryApprovalStore, createInMemoryPlanStore,
  type McpChangePlanServiceOptions, type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import { createMcpWriteToolGateway, type McpTrustedWriteRequestContext } from '../../src/mcp/write-tools.js';
import { DEFAULT_MCP_WRITE_INPUT_BUDGET } from '../../src/mcp/safe-data.js';
import type { ChangePlanOperation, OperationResult } from '../../src/types/generated.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import { createCommitCoordinatorFixture, resolveFixtureBaseRevisions } from './commit-coordinator-fixture.js';

const binding = authenticatedBinding({ principalId: 'review-principal', clientId: 'review-client' });
const operation = Object.freeze({
  type: 'set_visibility' as const, collectionId: 'review-collection', baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
});
const context: McpTrustedWriteRequestContext = {
  binding, scope: ['access:write'], budget: DEFAULT_MCP_WRITE_INPUT_BUDGET,
  abortSignal: new AbortController().signal, authorization: {},
};
const impact = { collections: 1, nodes: 1, annotations: 0, attachments: 0, relations: 0, privateFieldsExcluded: [] };

async function harness(verifier?: (plan: McpStoredPlan) => boolean, storedDigest?: string) {
  const clock = { now: () => new Date('2026-09-29T12:00:00.000Z') };
  const planStore = createInMemoryPlanStore({ clock });
  const approvalStore = createInMemoryApprovalStore({ clock });
  const verify = verifier === undefined ? undefined : vi.fn(verifier);
  const execute = vi.fn(async (): Promise<readonly OperationResult[]> => [{
    opId: 'review-op', sequence: 1, status: 'applied', revision: 'acl_18',
    cursor: 'review-cursor', warnings: [],
  }]);
  const coordinator = createCommitCoordinatorFixture(planStore, approvalStore, { execute });
  const options: McpChangePlanServiceOptions = {
    planStore, approvalStore, commitCoordinator: coordinator,
    impact: { assessImpact: async () => impact },
    revisions: {
      resolveBaseRevisions: async (op: ChangePlanOperation) => resolveFixtureBaseRevisions(op),
      currentRevisions: async (_transaction, base) => base,
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    rateLimit: { allow: async () => true },
    approvalBaseUri: 'https://approval.example.test/review', uriPolicy: { allow: () => true },
    clock, ids: { nextPlanId: () => 'review-plan' },
    ...(verify === undefined ? {} : { verifyStoredOperationsDigest: { verify } }),
  };
  const service = createChangePlanService(options);
  const plan = await service.plan({ operations: [operation], dryRun: true, reason: 'review regression' }, binding);
  if (storedDigest !== undefined) {
    const stored = await planStore.get(plan.planId);
    if (stored === undefined) throw new Error('fixture plan was not saved');
    await planStore.update({ ...stored, operationsDigest: storedDigest });
  }
  await service.recordOutOfBandApproval(plan.planId, binding);
  const gateway = createMcpWriteToolGateway({ changePlan: options });
  const call = (entry: 'core' | 'gateway') => entry === 'core'
    ? service.commit(plan.planId, binding, 'review-idempotency')
    : gateway.callTool('changes.commit', { planId: plan.planId, idempotencyKey: 'review-idempotency' }, context);
  return { call, verify, execute, plan, planStore, options };
}

describe('R2-03: configured Commit digest policy survives the public gateway', () => {
  it.each(['core', 'gateway'] as const)('%s honors an explicitly rejecting verifier BEFORE executor', async entry => {
    const h = await harness(() => false);
    await expect(h.call(entry)).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect((await h.planStore.get(h.plan.planId))?.status).toBe('approved');
  });

  it.each(['core', 'gateway'] as const)('%s accepts the host digest and replays without re-running verification/execution', async entry => {
    const hostDigest = 'sha-256:' + createHash('sha256').update('synthetic host transcript includes policy context').digest('base64url');
    const h = await harness(plan => plan.operationsDigest === hostDigest, hostDigest);
    const first = await h.call(entry);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(await h.call(entry)).toEqual(first);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('control: default digest policy still supports gateway Commit', async () => {
    const h = await harness();
    await expect(h.call('gateway')).resolves.toMatchObject({ structuredContent: { planId: h.plan.planId } });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});


it('rejects accessor-backed verifier options rather than silently omitting policy', async () => {
  const h = await harness();
  const getter = vi.fn(() => ({ verify: () => true }));
  Object.defineProperty(h.options, 'verifyStoredOperationsDigest', { enumerable: true, get: getter });
  expect(() => createMcpWriteToolGateway({ changePlan: h.options })).toThrow('own enumerable data property');
  expect(getter).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
});

it('rejects hidden verifier configuration and preserves explicit undefined as absent', async () => {
  const h = await harness();
  Object.defineProperty(h.options, 'verifyStoredOperationsDigest', {
    configurable: true, value: { verify: () => false }, enumerable: false,
  });
  expect(() => createMcpWriteToolGateway({ changePlan: h.options })).toThrow('own enumerable data property');
  Object.defineProperty(h.options, 'verifyStoredOperationsDigest', { value: undefined, enumerable: true });
  expect(() => createMcpWriteToolGateway({ changePlan: h.options })).not.toThrow();
});

describe('host planner keeps Plan minting and the digest verifier on the same rules', () => {
  const hostDigest = 'sha-256:' + createHash('sha256').update('synthetic host planner transcript').digest('base64url');
  const planInput = { operations: [operation], dryRun: true, reason: 'review regression' };

  async function gatewayHarness(withPlanner: boolean) {
    const h = await harness(plan => plan.operationsDigest === hostDigest);
    const service = createChangePlanService(h.options);
    const planner = { plan: vi.fn(async (request: unknown, planBinding: typeof binding) => {
      const minted = await service.plan(request, planBinding);
      const stored = await h.planStore.get(minted.planId);
      if (stored === undefined) throw new Error('fixture plan was not saved');
      await h.planStore.update({ ...stored, operationsDigest: hostDigest });
      return minted;
    }) };
    const gateway = createMcpWriteToolGateway({
      changePlan: withPlanner ? { ...h.options, planner } : h.options,
    });
    return { ...h, service, planner, gateway };
  }

  it('mints changes.plan through the host planner so a strong verifier can Commit', async () => {
    const h = await gatewayHarness(true);
    const result = await h.gateway.callTool('changes.plan', planInput, context);
    const planId = (result.structuredContent as { planId: string }).planId;
    expect(h.planner.plan).toHaveBeenCalledTimes(1);
    expect(h.planner.plan.mock.calls[0]?.[1]).toEqual(binding);
    await h.service.recordOutOfBandApproval(planId, binding);
    await expect(h.gateway.callTool('changes.commit', { planId, idempotencyKey: 'host-planner-key' }, context))
      .resolves.toMatchObject({ structuredContent: { planId } });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('control: without a host planner the generic digest fails the strong verifier before execution', async () => {
    const h = await gatewayHarness(false);
    const result = await h.gateway.callTool('changes.plan', planInput, context);
    const planId = (result.structuredContent as { planId: string }).planId;
    await h.service.recordOutOfBandApproval(planId, binding);
    await expect(h.gateway.callTool('changes.commit', { planId, idempotencyKey: 'generic-key' }, context))
      .rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['accessor', { enumerable: true, get: () => ({ plan: async () => ({}) }) }],
    ['hidden', { enumerable: false, value: { plan: async () => ({}) } }],
  ])('rejects a %s planner rather than falling back to the generic planner', async (_name, descriptor) => {
    const h = await harness();
    Object.defineProperty(h.options, 'planner', { configurable: true, ...descriptor });
    expect(() => createMcpWriteToolGateway({ changePlan: h.options })).toThrow('own enumerable data property');
  });

  it('rejects a planner without an own plan function and treats explicit undefined as absent', async () => {
    const h = await harness();
    expect(() => createMcpWriteToolGateway({ changePlan: { ...h.options, planner: {} as never } }))
      .toThrow('planner.plan must be an own data function');
    expect(() => createMcpWriteToolGateway({ changePlan: { ...h.options, planner: undefined as never } })).not.toThrow();
  });
});
