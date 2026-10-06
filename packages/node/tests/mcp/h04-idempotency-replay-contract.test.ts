import { describe, expect, it, vi } from 'vitest';

import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import type { ChangePlanOperation, OperationResult } from '../../src/types/generated.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import {
  authenticatedBinding,
  type McpAuthenticatedAuthorizationBinding,
} from './authenticated-binding-fixture.js';

const binding = authenticatedBinding({
  principalId: 'user-idempotency-replay',
  clientId: 'client-idempotency-replay',
});

const operation = Object.freeze({
  type: 'set_visibility' as const,
  collectionId: 'collection-idempotency-replay',
  baseRevision: 'acl_17',
  input: Object.freeze({ visibility: 'public' as const }),
});

function impact() {
  return Object.freeze({
    collections: 1,
    nodes: 4,
    annotations: 0,
    attachments: 0,
    relations: 0,
    privateFieldsExcluded: [] as string[],
  });
}

function createHarness() {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  let authoritativeRevision = 'acl_17';

  const scopes = {
    hasScopes: vi.fn(async () => true),
  };
  const revisions = {
    resolveBaseRevisions: vi.fn(async (candidate: ChangePlanOperation) =>
      resolveFixtureBaseRevisions(candidate)),
    currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) =>
      Object.freeze(Object.fromEntries(
        Object.keys(base).map((target) => [target, authoritativeRevision]),
      )),
    ),
  };
  const impacts = {
    assessImpact: vi.fn(async () => impact()),
  };
  const rateLimit = {
    allow: vi.fn(async () => true),
  };
  const executor = {
    execute: vi.fn(async (
      _transaction: object,
      _operations: readonly ChangePlanOperation[],
      _binding: McpAuthenticatedAuthorizationBinding,
    ): Promise<readonly OperationResult[]> => {
      authoritativeRevision = 'acl_18';
      return Object.freeze([
        Object.freeze({
          opId: 'op-idempotency-replay',
          sequence: 1,
          status: 'applied' as const,
          revision: authoritativeRevision,
          cursor: 'cur-idempotency-replay',
          warnings: Object.freeze([]) as readonly [],
        }),
      ]);
    }),
  };
  const commitCoordinator = createCommitCoordinatorFixture(planStore, approvalStore, executor);

  let serviceNumber = 0;
  const createServiceInstance = () => {
    serviceNumber += 1;
    return createChangePlanService({
      planStore,
      approvalStore,
      impact: impacts,
      revisions,
      scopes,
      authorizationPolicy: { requiredScopesForOperation: async () => [] },
      commitCoordinator,
      rateLimit,
      approvalBaseUri: 'https://alice.example/collections/approvals',
      uriPolicy: { allow: () => true },
      ids: { nextPlanId: () => `plan_h04_${serviceNumber}` },
      clock: { now: () => new Date('2026-07-24T09:00:00.000Z') },
    });
  };

  const prepare = async () => {
    const service = createServiceInstance();
    const plan = await service.plan({
      operations: [operation],
      reason: 'verify replay before mutable state checks',
      dryRun: true,
    }, binding);
    await service.recordOutOfBandApproval(plan.planId, binding);
    return { plan, service };
  };

  const clearMutablePortSpies = (): void => {
    scopes.hasScopes.mockClear();
    revisions.currentRevisions.mockClear();
    impacts.assessImpact.mockClear();
    rateLimit.allow.mockClear();
    executor.execute.mockClear();
  };

  const expectMutablePortsUntouched = (): void => {
    expect(scopes.hasScopes).not.toHaveBeenCalled();
    expect(revisions.currentRevisions).not.toHaveBeenCalled();
    expect(impacts.assessImpact).not.toHaveBeenCalled();
    expect(rateLimit.allow).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  };

  return {
    prepare,
    createServiceInstance,
    clearMutablePortSpies,
    expectMutablePortsUntouched,
    planStore,
    state: {
      get authoritativeRevision() { return authoritativeRevision; },
    },
  };
}

describe('H-04 MCP Commit idempotency replay contract', () => {
  it('replays the immutable first result before mutable revalidation, including across service instances', async () => {
    const harness = createHarness();
    const { plan, service: firstService } = await harness.prepare();

    const first = await firstService.commit(plan.planId, binding, 'idem-h04-first');
    expect(harness.state.authoritativeRevision).toBe('acl_18');
    expect(first.operations[0]?.revision).toBe('acl_18');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operations)).toBe(true);
    expect(Object.isFrozen(first.operations[0])).toBe(true);

    harness.clearMutablePortSpies();
    const sameInstanceReplay = await firstService.commit(plan.planId, binding, 'idem-h04-first');
    expect(sameInstanceReplay).toEqual(first);
    harness.expectMutablePortsUntouched();

    const stored = await harness.planStore.get(plan.planId);
    expect(stored).toBeDefined();
    await harness.planStore.update(Object.freeze({ ...stored!, status: 'cancelled' as const }));

    const secondService = harness.createServiceInstance();
    const crossInstanceReplay = await secondService.commit(plan.planId, binding, 'idem-h04-first');
    expect(crossInstanceReplay).toEqual(first);
    expect(Object.isFrozen(crossInstanceReplay)).toBe(true);
    expect(Object.isFrozen(crossInstanceReplay.operations)).toBe(true);
    expect(Object.isFrozen(crossInstanceReplay.operations[0])).toBe(true);
    harness.expectMutablePortsUntouched();
  });

  it('rejects a different idempotency key after consumption without mutable revalidation', async () => {
    const harness = createHarness();
    const { plan, service } = await harness.prepare();
    await service.commit(plan.planId, binding, 'idem-h04-winner');
    expect(harness.state.authoritativeRevision).toBe('acl_18');

    harness.clearMutablePortSpies();
    const otherService = harness.createServiceInstance();
    await expect(
      otherService.commit(plan.planId, binding, 'idem-h04-loser'),
    ).rejects.toMatchObject({ code: 'plan_already_consumed' });
    harness.expectMutablePortsUntouched();
  });
});
