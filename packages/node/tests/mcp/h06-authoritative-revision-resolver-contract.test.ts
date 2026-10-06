import { describe, expect, it, vi } from 'vitest';

import {
  createChangePlanService,
  createInMemoryApprovalStore,
  createInMemoryPlanStore,
  type McpChangePlanRevisionPort,
} from '../../src/mcp/change-plan.js';
import type { ChangePlanOperation, OperationResult } from '../../src/types/generated.js';
import { createCommitCoordinatorFixture } from './commit-coordinator-fixture.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const binding = authenticatedBinding({
  principalId: 'user-revision-policy',
  clientId: 'client-revision-policy',
});

const operations = Object.freeze({
  deleteCollection: Object.freeze({
    type: 'delete_collection' as const,
    collectionId: 'collection-1',
    baseRevision: 'collection-r17',
  }),
  deleteSubtree: Object.freeze({
    type: 'delete_subtree' as const,
    collectionId: 'collection-1',
    targetId: 'node-9',
    baseRevision: 'node-r4',
  }),
  setAccessPolicy: Object.freeze({
    type: 'set_access_policy' as const,
    collectionId: 'collection-1',
    baseRevision: 'acl-r7',
    input: Object.freeze({ visibility: 'private' as const }),
  }),
  setVisibility: Object.freeze({
    type: 'set_visibility' as const,
    collectionId: 'collection-1',
    baseRevision: 'acl-r7',
    input: Object.freeze({ visibility: 'protected' as const }),
  }),
  setRateLimit: Object.freeze({
    type: 'set_rate_limit' as const,
    targetId: 'principal-1',
    baseRevision: 'rate-r9',
    input: Object.freeze({ limit: 100, windowSeconds: 60 }),
  }),
  publishRelease: Object.freeze({
    type: 'publish_release' as const,
    collectionId: 'collection-1',
    baseRevision: 'release-r3',
    input: Object.freeze({ title: 'Release 3' }),
  }),
});

const authoritativeRevisions = new Map<ChangePlanOperation['type'], Readonly<Record<string, string>>>([
  ['delete_collection', Object.freeze({ 'collection.collection-1': 'collection-r17' })],
  ['delete_subtree', Object.freeze({ 'node.node-9': 'node-r4' })],
  ['set_access_policy', Object.freeze({ 'access.collection-1': 'acl-r7' })],
  ['set_visibility', Object.freeze({ 'access.collection-1': 'acl-r7' })],
  ['set_rate_limit', Object.freeze({ 'rate-limit.principal-1': 'rate-r9' })],
  ['publish_release', Object.freeze({ 'host.release-slot': 'release-r3' })],
]);

function impact() {
  return {
    collections: 1,
    nodes: 1,
    annotations: 0,
    attachments: 0,
    relations: 0,
    privateFieldsExcluded: [] as string[],
  };
}

function request(planOperations: readonly ChangePlanOperation[]) {
  return {
    operations: planOperations,
    reason: 'verify authoritative revision namespaces',
    dryRun: true as const,
  };
}

function createHarness(revisions: McpChangePlanRevisionPort) {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const executor = {
    execute: vi.fn(async (): Promise<readonly OperationResult[]> => [
      {
        opId: 'op-h06',
        sequence: 1,
        status: 'applied',
        revision: 'result-r1',
        cursor: 'cursor-h06',
        warnings: [],
      },
    ]),
  };
  const service = createChangePlanService({
    planStore,
    approvalStore,
    impact: { assessImpact: vi.fn(async () => impact()) },
    revisions,
    scopes: { hasScopes: vi.fn(async () => true) },
    authorizationPolicy: { requiredScopesForOperation: vi.fn(async () => []) },
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, executor),
    rateLimit: { allow: vi.fn(async () => true) },
    approvalBaseUri: 'https://alice.example/collections/approvals',
    uriPolicy: { allow: () => true },
    ids: { nextPlanId: () => 'plan_h06' },
    clock: { now: () => new Date('2026-07-24T12:00:00.000Z') },
  });

  return { service, planStore, executor };
}

function passThroughRevisionPort() {
  return {
    resolveBaseRevisions: vi.fn(async (operation: ChangePlanOperation) =>
      authoritativeRevisions.get(operation.type) ?? Object.freeze({}),
    ),
    currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
  };
}

describe('H-06 authoritative Change Plan revision resolver', () => {
  it.each([
    ['collection deletion', operations.deleteCollection, { 'collection.collection-1': 'collection-r17' }],
    ['subtree deletion', operations.deleteSubtree, { 'node.node-9': 'node-r4' }],
    ['access ACL', operations.setAccessPolicy, { 'access.collection-1': 'acl-r7' }],
    ['visibility ACL', operations.setVisibility, { 'access.collection-1': 'acl-r7' }],
    ['rate-limit target', operations.setRateLimit, { 'rate-limit.principal-1': 'rate-r9' }],
    ['host-defined release namespace', operations.publishRelease, { 'host.release-slot': 'release-r3' }],
  ] as const)('persists the resolver-owned namespace for %s', async (_label, operation, expected) => {
    const revisions = passThroughRevisionPort();
    const { service } = createHarness(revisions);

    const plan = await service.plan(request([operation]), binding);

    expect(plan.baseRevisions).toEqual(expected);
    expect(revisions.resolveBaseRevisions).toHaveBeenCalledOnce();
    expect(revisions.resolveBaseRevisions).toHaveBeenCalledWith(operation, binding);
  });

  it('keeps ACL and collection revisions independent and merges a mixed Plan', async () => {
    const revisions = passThroughRevisionPort();
    const { service } = createHarness(revisions);
    const mixed = [
      operations.deleteCollection,
      operations.setAccessPolicy,
      operations.setRateLimit,
      operations.publishRelease,
    ];

    const plan = await service.plan(request(mixed), binding);

    expect(plan.baseRevisions).toEqual({
      'collection.collection-1': 'collection-r17',
      'access.collection-1': 'acl-r7',
      'rate-limit.principal-1': 'rate-r9',
      'host.release-slot': 'release-r3',
    });
    expect(revisions.resolveBaseRevisions.mock.calls.map(([operation]) => operation.type)).toEqual([
      'delete_collection',
      'set_access_policy',
      'set_rate_limit',
      'publish_release',
    ]);
  });

  it('allows duplicate namespace entries only when their revision is identical', async () => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async () => ({ 'tenant.shared': 'collection-r17' })),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    };
    const { service } = createHarness(revisions);

    const plan = await service.plan(
      request([operations.deleteCollection, operations.deleteCollection]),
      binding,
    );

    expect(plan.baseRevisions).toEqual({ 'tenant.shared': 'collection-r17' });
  });

  it('fails closed when operations resolve the same namespace to conflicting revisions', async () => {
    const secondDelete = Object.freeze({
      ...operations.deleteCollection,
      collectionId: 'collection-2',
      baseRevision: 'collection-r18',
    });
    const revisions = {
      resolveBaseRevisions: vi.fn(async (operation: ChangePlanOperation) => ({
        'tenant.shared': 'baseRevision' in operation ? operation.baseRevision : 'unexpected-r1',
      })),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    };
    const { service, planStore } = createHarness(revisions);

    await expect(
      service.plan(request([operations.deleteCollection, secondDelete]), binding),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(await planStore.get('plan_h06')).toBeUndefined();
  });

  it('fails closed when the resolver omits the operation declared baseRevision', async () => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async () => ({ 'rate-limit.principal-1': 'different-r1' })),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    };
    const { service, planStore } = createHarness(revisions);

    await expect(
      service.plan(request([operations.setRateLimit]), binding),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(await planStore.get('plan_h06')).toBeUndefined();
  });

  it.each([
    ['set_visibility', 'aliases the ACL as a collection revision', operations.setVisibility, {
      'access.collection-1': 'acl-r7',
      'collection-1': 'acl-r7',
    }],
    ['set_access_policy', 'aliases the ACL as a collection revision', operations.setAccessPolicy, {
      'access.collection-1': 'acl-r7',
      'collection-1': 'acl-r7',
    }],
  ] as const)('fails closed when %s resolver %s', async (_type, _label, operation, decision) => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async () => decision),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    };
    const { service, planStore } = createHarness(revisions);

    await expect(
      service.plan(request([operation]), binding),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(await planStore.get('plan_h06')).toBeUndefined();
  });

  it.each([
    ['set_visibility', operations.setVisibility],
    ['set_access_policy', operations.setAccessPolicy],
  ] as const)('accepts a host-owned access namespace for %s', async (_type, operation) => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async () => ({ 'tenant.acl': 'acl-r7' })),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    };
    const { service } = createHarness(revisions);

    await expect(service.plan(request([operation]), binding)).resolves.toMatchObject({
      baseRevisions: { 'tenant.acl': 'acl-r7' },
    });
  });

  it('accepts the colon-separated access namespace shown by the protocol example', async () => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async () => ({ 'access:collection-1': 'acl-r7' })),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    };
    const { service } = createHarness(revisions);

    await expect(service.plan(request([operations.setAccessPolicy]), binding)).resolves.toMatchObject({
      baseRevisions: { 'access:collection-1': 'acl-r7' },
    });
  });

  it.each([
    ['an accessor result', () => {
      const result = {} as Record<string, string>;
      Object.defineProperty(result, 'tenant.shared', {
        enumerable: true,
        get: () => 'shared-r1',
      });
      return result;
    }],
    ['a Proxy result', () => new Proxy({ 'tenant.shared': 'shared-r1' }, {
      ownKeys: () => { throw new Error('resolver-proxy-trap'); },
    })],
    ['an empty revision', () => ({ 'access.collection-1': '' })],
    ['a non-string revision', () => ({ 'access.collection-1': 7 })],
  ] as const)('fails closed when the Plan resolver returns %s', async (_label, result) => {
    const revisions = {
      resolveBaseRevisions: vi.fn(async () => result()),
      currentRevisions: vi.fn(async (_transaction, base: Readonly<Record<string, string>>) => ({ ...base })),
    } as unknown as McpChangePlanRevisionPort;
    const { service, planStore } = createHarness(revisions);

    await expect(
      service.plan(request([operations.setAccessPolicy]), binding),
    ).rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(await planStore.get('plan_h06')).toBeUndefined();
  });

  it('accepts native resolver Promises but rejects arbitrary thenables without assimilation', async () => {
    const native = createHarness({
      resolveBaseRevisions: () => Promise.resolve({ 'tenant.acl': 'acl-r7' }),
      currentRevisions: async (_transaction, base) => ({ ...base }),
    });
    await expect(native.service.plan(request([operations.setAccessPolicy]), binding)).resolves.toMatchObject({
      baseRevisions: { 'tenant.acl': 'acl-r7' },
    });

    const overriddenThen = vi.fn();
    const nativeWithHostileThen = Promise.resolve({ 'tenant.acl': 'acl-r7' });
    Object.defineProperty(nativeWithHostileThen, 'then', { get: overriddenThen });
    const overridden = createHarness({
      resolveBaseRevisions: () => nativeWithHostileThen,
      currentRevisions: async (_transaction, base) => ({ ...base }),
    });
    await expect(overridden.service.plan(request([operations.setAccessPolicy]), binding)).resolves.toMatchObject({
      baseRevisions: { 'tenant.acl': 'acl-r7' },
    });
    expect(overriddenThen).not.toHaveBeenCalled();

    const thenGetter = vi.fn(() => vi.fn());
    const thenable = Object.defineProperty({}, 'then', { enumerable: true, get: thenGetter });
    const arbitrary = createHarness({
      resolveBaseRevisions: () => thenable as never,
      currentRevisions: async (_transaction, base) => ({ ...base }),
    });
    await expect(arbitrary.service.plan(request([operations.setAccessPolicy]), binding))
      .rejects.toMatchObject({ code: 'invalid_plan_request' });
    expect(thenGetter).not.toHaveBeenCalled();
  });

  it('passes the persisted namespace map and binding to Commit current revision resolution', async () => {
    const revisions = passThroughRevisionPort();
    const { service, executor } = createHarness(revisions);
    const plan = await service.plan(request([operations.setRateLimit]), binding);
    await service.recordOutOfBandApproval(plan.planId, binding);

    await service.commit(plan.planId, binding, 'idem-h06-current-contract');

    expect(revisions.currentRevisions).toHaveBeenCalledOnce();
    expect(revisions.currentRevisions).toHaveBeenCalledWith(
      expect.any(Object),
      { 'rate-limit.principal-1': 'rate-r9' },
      binding,
    );
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('detects set_rate_limit TOCTOU in its resolver-owned namespace before execution', async () => {
    const revisions = passThroughRevisionPort();
    revisions.currentRevisions.mockResolvedValue({ 'rate-limit.principal-1': 'rate-r10' });
    const { service, executor } = createHarness(revisions);
    const plan = await service.plan(request([operations.setRateLimit]), binding);
    await service.recordOutOfBandApproval(plan.planId, binding);

    await expect(
      service.commit(plan.planId, binding, 'idem-h06-rate-drift'),
    ).rejects.toMatchObject({ code: 'revision_drift' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['additional', {
      'rate-limit.principal-1': 'rate-r9',
      'host.unapproved-revision': 'host-r1',
    }],
  ] as const)('rejects a valid but %s Commit namespace set as revision drift', async (_label, current) => {
    const revisions = passThroughRevisionPort();
    revisions.currentRevisions.mockResolvedValue(current);
    const { service, executor } = createHarness(revisions);
    const plan = await service.plan(request([operations.setRateLimit]), binding);
    await service.recordOutOfBandApproval(plan.planId, binding);

    await expect(
      service.commit(plan.planId, binding, `idem-h06-${_label}-namespace`),
    ).rejects.toMatchObject({ code: 'revision_drift' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['an accessor result', () => {
      const result = {} as Record<string, string>;
      Object.defineProperty(result, 'rate-limit.principal-1', {
        enumerable: true,
        get: () => 'rate-r9',
      });
      return result;
    }],
    ['a Proxy result', () => new Proxy({ 'rate-limit.principal-1': 'rate-r9' }, {
      ownKeys: () => { throw new Error('current-revision-proxy-trap'); },
    })],
    ['an illegal revision', () => ({ 'rate-limit.principal-1': '' })],
  ] as const)('fails closed when Commit current revision resolution returns %s', async (_label, result) => {
    const revisions = passThroughRevisionPort();
    revisions.currentRevisions.mockImplementation(async () => result());
    const { service, executor } = createHarness(revisions);
    const plan = await service.plan(request([operations.setRateLimit]), binding);
    await service.recordOutOfBandApproval(plan.planId, binding);

    await expect(
      service.commit(plan.planId, binding, `idem-h06-invalid-current-${_label}`),
    ).rejects.toMatchObject({ code: 'commit_failed' });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
