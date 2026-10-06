import { describe, expect, it, vi } from 'vitest';

import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  type McpStoredPlan,
} from '../../src/mcp/change-plan.js';
import { createCommitCoordinatorFixture, resolveFixtureBaseRevisions } from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const binding = authenticatedBinding({
  principalId: 'user-digest-port',
  clientId: 'client-digest-port',
});

const operation = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-digest-port',
  baseRevision: 'acl-digest-port',
  input: Object.freeze({ visibility: 'public' as const }),
});

function options(verify: ((plan: McpStoredPlan) => boolean | PromiseLike<boolean>) | undefined) {
  const basePlanStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const planStore = {
    save: async (plan: McpStoredPlan) => {
      await basePlanStore.save(Object.freeze({
        ...plan,
        operationsDigest: 'host-plan-digest',
      }));
    },
    get: (planId: string) => basePlanStore.get(planId),
    update: async (plan: McpStoredPlan) => {
      await basePlanStore.update(Object.freeze({
        ...plan,
        operationsDigest: 'host-plan-digest',
      }));
    },
  };
  const executor = {
    execute: vi.fn(async () => [{
      opId: 'op-digest-port',
      sequence: 1,
      status: 'applied' as const,
      revision: 'r-digest-port',
      cursor: 'cursor-digest-port',
      warnings: [] as never[],
    }]),
  };
  const service = createChangePlanService({
    planStore,
    approvalStore,
    impact: { assessImpact: async () => ({
      collections: 1,
      nodes: 0,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    }) },
    revisions: {
      resolveBaseRevisions: async (candidate) => resolveFixtureBaseRevisions(candidate),
      currentRevisions: async (_transaction, base) => ({ ...base }),
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    rateLimit: { allow: async () => true },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    approvalBaseUri: 'https://host.example/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_digest_port' },
    clock: { now: () => new Date('2026-08-05T12:00:00.000Z') },
    ...(verify === undefined ? {} : { verifyStoredOperationsDigest: { verify } }),
  });
  return { service, executor };
}

describe('MCP Change Plan host-owned stored digest port', () => {
  it('keeps the default operations-digest check when the port is omitted', async () => {
    const { service } = options(undefined);
    const plan = await service.plan({
      operations: [operation],
      reason: 'host digest contract',
      dryRun: true,
    }, binding);
    await service.recordOutOfBandApproval(plan.planId, binding);
    await expect(service.commit(plan.planId, binding, 'idem-default-digest')).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
  });

  it('accepts a host-persisted Plan when the verifier confirms its stored digest', async () => {
    const verify = vi.fn(async (plan: McpStoredPlan) => plan.operationsDigest === 'host-plan-digest');
    const { service, executor } = options(verify);
    const plan = await service.plan({
      operations: [operation],
      reason: 'host digest contract',
      dryRun: true,
    }, binding);
    await service.recordOutOfBandApproval(plan.planId, binding);

    const result = await service.commit(plan.planId, binding, 'idem-host-digest');
    expect(result.operations[0]).toMatchObject({ status: 'applied' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the verifier rejects the persisted digest', async () => {
    const { service } = options(async () => false);
    const plan = await service.plan({
      operations: [operation],
      reason: 'host digest contract',
      dryRun: true,
    }, binding);
    await service.recordOutOfBandApproval(plan.planId, binding);
    await expect(service.commit(plan.planId, binding, 'idem-rejected-digest')).rejects.toMatchObject({
      code: 'digest_mismatch',
    });
  });
});
