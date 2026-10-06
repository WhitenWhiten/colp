import { describe, expect, it, vi } from 'vitest';

import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
} from '../../src/mcp/change-plan.js';
import { createMcpWriteToolGateway } from '../../src/mcp/write-tools.js';
import type {
  ChangePlanOperation,
  OperationResult,
  ScopeName,
} from '../../src/types/generated.js';
import {
  createCommitCoordinatorFixture,
  resolveFixtureBaseRevisions,
} from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const binding = authenticatedBinding({
  principalId: 'user-scope-policy',
  clientId: 'client-scope-policy',
});

const operationCases: readonly Readonly<{
  type: ChangePlanOperation['type'];
  operation: ChangePlanOperation;
  expectedScopes: readonly ScopeName[];
}>[] = Object.freeze([
  {
    type: 'delete_collection',
    operation: { type: 'delete_collection', collectionId: 'collection-1', baseRevision: 'r1' },
    expectedScopes: ['collections:delete'],
  },
  {
    type: 'delete_subtree',
    operation: {
      type: 'delete_subtree',
      collectionId: 'collection-1',
      targetId: 'node-1',
      baseRevision: 'r1',
    },
    expectedScopes: ['nodes:delete'],
  },
  {
    type: 'set_visibility',
    operation: {
      type: 'set_visibility',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { visibility: 'protected' },
    },
    expectedScopes: ['access:write'],
  },
  {
    type: 'set_access_policy',
    operation: {
      type: 'set_access_policy',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { visibility: 'private' },
    },
    expectedScopes: ['access:write'],
  },
  {
    type: 'create_key',
    operation: {
      type: 'create_key',
      input: {
        name: 'publisher key',
        type: 'publisher_key',
        scopes: ['collections:write'],
        collections: ['collection-1'],
        expiresAt: null,
      },
    },
    expectedScopes: ['keys:write'],
  },
  {
    type: 'rotate_key',
    operation: {
      type: 'rotate_key',
      targetId: 'key-1',
      input: { overlapSeconds: 60 },
    },
    expectedScopes: ['keys:write'],
  },
  {
    type: 'revoke_key',
    operation: { type: 'revoke_key', targetId: 'key-1' },
    expectedScopes: ['keys:write'],
  },
  {
    type: 'set_rate_limit',
    operation: {
      type: 'set_rate_limit',
      targetId: 'principal-1',
      baseRevision: 'r1',
      input: { limit: 100, windowSeconds: 60 },
    },
    expectedScopes: ['rate_limits:write'],
  },
  {
    type: 'publish_release',
    operation: {
      type: 'publish_release',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { title: 'Release 1' },
    },
    expectedScopes: ['release:publish'],
  },
  {
    type: 'sync_mirror',
    operation: {
      type: 'sync_mirror',
      collectionId: 'collection-1',
      baseRevision: 'r1',
      input: { replicaId: 'replica-1' },
    },
    expectedScopes: ['sync:pull', 'sync:push'],
  },
]);

function sampleImpact() {
  return {
    collections: 1,
    nodes: 1,
    annotations: 0,
    attachments: 0,
    relations: 0,
    privateFieldsExcluded: [] as string[],
  };
}

function createHarness(authorizationPolicy: unknown) {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const scopes = {
    hasScopes: vi.fn(async () => true),
  };
  const executor = {
    execute: vi.fn(async (): Promise<readonly OperationResult[]> => [
      {
        opId: 'op-h05',
        sequence: 1,
        status: 'applied',
        revision: 'r2',
        cursor: 'cursor-h05',
        warnings: [],
      },
    ]),
  };
  const commitCoordinator = createCommitCoordinatorFixture(planStore, approvalStore, executor);
  const options = {
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => sampleImpact()) },
    revisions: {
      resolveBaseRevisions: vi.fn(async (candidate: ChangePlanOperation) =>
        resolveFixtureBaseRevisions(candidate)),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    },
    scopes,
    authorizationPolicy,
    commitCoordinator,
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    revealUriForKey: (keyId: string) =>
      `https://alice.example/collections/keys/${keyId}/reveal`,
    ids: { nextPlanId: () => 'plan_h05' },
    clock: { now: () => new Date('2026-07-24T10:00:00.000Z') },
  };
  const service = createChangePlanService(
    options as Parameters<typeof createChangePlanService>[0],
  );

  return { service, planStore, scopes, executor, options };
}

function planRequest(operations: readonly ChangePlanOperation[]) {
  return {
    operations,
    reason: 'verify canonical operation scope derivation',
    dryRun: true,
  };
}

describe('H-05 canonical Change Plan operation scope policy', () => {
  it.each(operationCases)(
    'derives the canonical base Scope for $type and consults the trusted policy',
    async ({ type, operation, expectedScopes }) => {
      const authorizationPolicy = {
        requiredScopesForOperation: vi.fn(async (candidate: ChangePlanOperation) =>
          candidate.type === 'sync_mirror' ? ['sync:pull', 'sync:push'] as const : [] as const,
        ),
      };
      const { service } = createHarness(authorizationPolicy);

      const plan = await service.plan(planRequest([operation]), binding);

      expect(plan.requiredScopes, type).toEqual(expectedScopes);
      expect(authorizationPolicy.requiredScopesForOperation).toHaveBeenCalledOnce();
      expect(authorizationPolicy.requiredScopesForOperation).toHaveBeenCalledWith(
        operation,
        binding,
      );
    },
  );

  it('forms a stable, first-seen, duplicate-free union across a mixed Plan', async () => {
    const operations = [
      operationCases[2]!.operation,
      operationCases[0]!.operation,
      operationCases[3]!.operation,
      operationCases[4]!.operation,
    ];
    const authorizationPolicy = {
      requiredScopesForOperation: vi.fn(async (operation: ChangePlanOperation) => {
        switch (operation.type) {
          case 'set_visibility': return ['server:admin', 'access:write'] as const;
          case 'delete_collection': return ['access:read', 'collections:delete'] as const;
          case 'set_access_policy': return ['server:admin'] as const;
          case 'create_key': return ['access:read', 'keys:read'] as const;
          default: return [] as const;
        }
      }),
    };
    const { service } = createHarness(authorizationPolicy);

    const plan = await service.plan(planRequest(operations), binding);

    expect(plan.requiredScopes).toEqual([
      'access:write',
      'server:admin',
      'collections:delete',
      'access:read',
      'keys:write',
      'keys:read',
    ]);
    expect(authorizationPolicy.requiredScopesForOperation.mock.calls.map(([operation]) => operation.type))
      .toEqual(['set_visibility', 'delete_collection', 'set_access_policy', 'create_key']);
  });

  it('adds multiple host- and resource-state-dependent Scopes from the trusted policy', async () => {
    const resourceState = new Map([['collection-1', 'regulated']]);
    const authorizationPolicy = {
      requiredScopesForOperation: vi.fn(async (operation: ChangePlanOperation) =>
        operation.type === 'set_access_policy'
          && resourceState.get(operation.collectionId) === 'regulated'
          ? ['server:admin', 'audit:read'] as const
          : [] as const,
      ),
    };
    const { service } = createHarness(authorizationPolicy);

    const plan = await service.plan(planRequest([operationCases[3]!.operation]), binding);

    expect(plan.requiredScopes).toEqual(['access:write', 'server:admin', 'audit:read']);
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['non-array', 'sync:push'],
    ['unknown Scope', ['sync:push', 'not-a-canonical-scope']],
  ] as const)('fails closed for a %s sync_mirror policy decision', async (_label, decision) => {
    const authorizationPolicy = {
      requiredScopesForOperation: vi.fn(async () => decision),
    };
    const { service, planStore } = createHarness(authorizationPolicy);

    await expect(
      service.plan(planRequest([operationCases[9]!.operation]), binding),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(await planStore.get('plan_h05')).toBeUndefined();
  });

  it('rejects a missing authorization policy port at runtime', () => {
    expect(() => createHarness(undefined)).toThrow();
  });

  it('requires an own-data, non-Proxy authorization policy without invoking hostile code', () => {
    const getter = vi.fn(() => vi.fn(() => []));
    const accessorPolicy = Object.defineProperty({}, 'requiredScopesForOperation', { get: getter });
    expect(() => createHarness(accessorPolicy)).toThrow(/own/iu);
    expect(getter).not.toHaveBeenCalled();

    const inheritedPolicy = Object.create({ requiredScopesForOperation: () => [] });
    expect(() => createHarness(inheritedPolicy)).toThrow(/own/iu);

    const trap = vi.fn(() => { throw new Error('policy proxy trap executed'); });
    const proxyPolicy = new Proxy({ requiredScopesForOperation: () => [] }, {
      getOwnPropertyDescriptor: trap,
    });
    expect(() => createHarness(proxyPolicy)).toThrow(/own-data/iu);
    expect(trap).not.toHaveBeenCalled();

    const apply = vi.fn(() => []);
    const proxyMethod = new Proxy(() => [], { apply });
    expect(() => createHarness({ requiredScopesForOperation: proxyMethod })).toThrow(/own/iu);
    expect(apply).not.toHaveBeenCalled();
  });

  it('preserves the own-data policy boundary through write gateway assembly', () => {
    const { options } = createHarness({ requiredScopesForOperation: () => [] });
    const getter = vi.fn(() => ({ requiredScopesForOperation: () => [] }));
    Object.defineProperty(options, 'authorizationPolicy', { enumerable: true, get: getter });

    expect(() => createMcpWriteToolGateway({
      changePlan: options as Parameters<typeof createMcpWriteToolGateway>[0]['changePlan'],
    })).toThrow(/authorizationPolicy|own-data/iu);
    expect(getter).not.toHaveBeenCalled();
  });

  it('snapshots policy Scope arrays without invoking accessors or Proxy traps', async () => {
    const getter = vi.fn(() => 'sync:push');
    const accessorResult: unknown[] = [];
    Object.defineProperty(accessorResult, '0', { enumerable: true, get: getter });
    const accessorHarness = createHarness({ requiredScopesForOperation: () => accessorResult });
    await expect(accessorHarness.service.plan(
      planRequest([operationCases[9]!.operation]),
      binding,
    )).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(getter).not.toHaveBeenCalled();

    const trap = vi.fn(() => { throw new Error('policy result proxy trap executed'); });
    const proxyResult = new Proxy(['sync:push'], { get: trap, ownKeys: trap });
    const proxyHarness = createHarness({ requiredScopesForOperation: () => proxyResult });
    await expect(proxyHarness.service.plan(
      planRequest([operationCases[9]!.operation]),
      binding,
    )).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(trap).not.toHaveBeenCalled();
  });

  it('accepts native policy Promises but rejects arbitrary thenables without assimilation', async () => {
    const nativeHarness = createHarness({
      requiredScopesForOperation: () => Promise.resolve(['sync:push'] as const),
    });
    await expect(nativeHarness.service.plan(
      planRequest([operationCases[9]!.operation]),
      binding,
    )).resolves.toMatchObject({ requiredScopes: ['sync:push'] });

    const overriddenThen = vi.fn();
    const nativeWithHostileThen = Promise.resolve(['sync:pull'] as const);
    Object.defineProperty(nativeWithHostileThen, 'then', { get: overriddenThen });
    const overriddenHarness = createHarness({
      requiredScopesForOperation: () => nativeWithHostileThen,
    });
    await expect(overriddenHarness.service.plan(
      planRequest([operationCases[9]!.operation]),
      binding,
    )).resolves.toMatchObject({ requiredScopes: ['sync:pull'] });
    expect(overriddenThen).not.toHaveBeenCalled();

    const thenGetter = vi.fn(() => vi.fn());
    const thenable = Object.defineProperty({}, 'then', { enumerable: true, get: thenGetter });
    const thenableHarness = createHarness({ requiredScopesForOperation: () => thenable });
    await expect(thenableHarness.service.plan(
      planRequest([operationCases[9]!.operation]),
      binding,
    )).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(thenGetter).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown runtime operation before consulting policy', async () => {
    const authorizationPolicy = {
      requiredScopesForOperation: vi.fn(async () => []),
    };
    const { service, planStore } = createHarness(authorizationPolicy);
    const escapedOperation = {
      type: 'future_admin_operation',
      targetId: 'server-1',
    } as unknown as ChangePlanOperation;

    await expect(service.plan(planRequest([escapedOperation]), binding)).rejects.toMatchObject({
      code: 'invalid_plan_request',
    });
    expect(authorizationPolicy.requiredScopesForOperation).not.toHaveBeenCalled();
    expect(await planStore.get('plan_h05')).toBeUndefined();
  });

  it('passes the exact persisted derived Scope union to the Commit scope gate', async () => {
    let policyDecision: readonly ScopeName[] = ['server:admin', 'access:read'];
    const authorizationPolicy = {
      requiredScopesForOperation: vi.fn(async () => policyDecision),
    };
    const { service, planStore, scopes, executor } = createHarness(authorizationPolicy);
    const plan = await service.plan(planRequest([operationCases[2]!.operation]), binding);
    const persisted = await planStore.get(plan.planId);
    expect(persisted?.requiredScopes).toEqual(['access:write', 'server:admin', 'access:read']);

    policyDecision = [];
    await service.recordOutOfBandApproval(plan.planId, binding);
    await service.commit(plan.planId, binding, 'idem-h05-scopes');

    expect(authorizationPolicy.requiredScopesForOperation).toHaveBeenCalledOnce();
    expect(scopes.hasScopes).toHaveBeenCalledOnce();
    expect(scopes.hasScopes).toHaveBeenCalledWith(
      ['access:write', 'server:admin', 'access:read'],
      binding,
    );
    expect(executor.execute).toHaveBeenCalledOnce();
  });
});
