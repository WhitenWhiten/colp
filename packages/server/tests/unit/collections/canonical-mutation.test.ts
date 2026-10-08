import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CanonicalMutationInvariantError,
  CANONICAL_MUTATION_WRITE_ORDER,
  createCanonicalMutationApplication,
  type AllocatedMutationState,
  type CanonicalMutationApplication,
  type CanonicalMutationInput,
  type CanonicalMutationPlan,
  type CanonicalMutationPorts,
  type CanonicalTransactionContext,
  type LockedCollectionState,
} from '../../../src/modules/index.js';

type Tx = { readonly id: string };

const locked: LockedCollectionState = {
  collectionId: 'collection-1',
  currentCommitOrdinal: 4n,
  resourceRevision: 'r-4',
  contentRevision: 'c-4',
  policyRevision: 'p-4',
};

const allocation: AllocatedMutationState = {
  commitOrdinal: 5n,
  resourceRevision: 'r-5',
  childrenRevisions: {},
  positionToken: 'pos-5',
};

function input(overrides: Partial<CanonicalMutationInput['mutation']> = {}): CanonicalMutationInput {
  return {
    operationId: 'operation-1',
    collectionId: 'collection-1',
    actor: { principalId: 'principal-1', principalType: 'account' },
    mutation: {
      action: 'update',
      target: { collectionId: 'collection-1', resourceId: 'resource-1', resourceKind: 'note' },
      parentId: null,
      fields: { kindFields: { title: 'updated' }, extensions: { source: 'test' } },
      ...overrides,
    },
  };
}

function planFor(
  admitted: CanonicalMutationInput,
  overrides: Partial<CanonicalMutationPlan['mutation']> = {},
): CanonicalMutationPlan {
  return {
    operationId: admitted.operationId,
    collectionId: admitted.collectionId,
    mutation: {
      ...admitted.mutation,
      revisionEffects: { resource: true, content: false, policy: false, childrenOf: [] },
      ...overrides,
    },
  };
}

interface HarnessOverrides {
  readonly locked?: LockedCollectionState | null;
  readonly plan?: (admitted: CanonicalMutationInput) => CanonicalMutationPlan;
  readonly allocation?: AllocatedMutationState;
  readonly failAt?: 'canonical-plan' | 'allocation' | 'resource' | 'operation' | 'audit' | 'outbox';
}

function harness(overrides: HarnessOverrides = {}) {
  const calls: string[] = [];
  const transactions: unknown[] = [];
  const argumentsByPort: Record<string, unknown[]> = {};
  const failure = new Error(`${overrides.failAt ?? 'no'} failed`);
  const record = (name: string, tx: Tx, argument?: unknown) => {
    calls.push(name);
    transactions.push(tx);
    if (argument !== undefined) argumentsByPort[name] = [...(argumentsByPort[name] ?? []), argument];
    if (overrides.failAt === name) throw failure;
  };
  const ports: CanonicalMutationPorts<Tx> = {
    collectionLock: {
      async lockForCanonicalMutation(tx) {
        record('collection-lock', tx);
        return overrides.locked === undefined ? locked : overrides.locked;
      },
    },
    planner: {
      async planCanonicalMutation(tx, admitted, collection) {
        record('canonical-plan', tx, { admitted, collection });
        return overrides.plan?.(admitted) ?? planFor(admitted);
      },
    },
    allocator: {
      async allocate(tx, request) {
        record('allocation', tx, request);
        return overrides.allocation ?? allocation;
      },
    },
    resources: {
      async applyCanonicalMutation(tx, write) { record('resource', tx, write); },
    },
    operations: {
      async appendCanonicalOperation(tx, operation) { record('operation', tx, operation); },
    },
    audit: {
      async appendAuditEvent(tx, event) { record('audit', tx, event); },
    },
    outbox: {
      async appendDomainEvents(tx, events) { record('outbox', tx, events); },
    },
  };
  return {
    calls,
    transactions,
    argumentsByPort,
    failure,
    application: createCanonicalMutationApplication(ports),
  };
}

function isInvariant(error: unknown): boolean {
  return error instanceof CanonicalMutationInvariantError && error.code === 'invalid_canonical_mutation';
}

const WRITE_PORTS = Object.freeze(['resource', 'operation', 'audit', 'outbox'] as const);

function assertNoWritePorts(calls: readonly string[]): void {
  for (const port of WRITE_PORTS) {
    assert.equal(calls.includes(port), false, `write port ${port} must not be called`);
  }
}

function deleteAdmitted(overrides: Partial<CanonicalMutationInput['mutation']> = {}): CanonicalMutationInput {
  return input({
    action: 'delete',
    target: { collectionId: 'collection-1', resourceId: 'folder-1', resourceKind: 'node' },
    parentId: 'root-1',
    fields: undefined,
    deleteIntent: { scope: 'subtree', expectedContentRevision: 'c-4' },
    ...overrides,
  });
}

function deletePlanFor(
  admitted: CanonicalMutationInput,
  orderedResourceIds: readonly string[] = ['leaf-1', 'folder-1'],
  overrides: Partial<CanonicalMutationPlan['mutation']> = {},
): CanonicalMutationPlan {
  return planFor(admitted, {
    fields: undefined,
    deletePlan: { orderedResourceIds },
    revisionEffects: { resource: true, content: true, policy: false, childrenOf: ['root-1'] },
    ...overrides,
  });
}

const deleteAllocation: AllocatedMutationState = {
  commitOrdinal: 5n,
  resourceRevision: 'folder-r5',
  contentRevision: 'c-5',
  childrenRevisions: { 'root-1': 'root-c5' },
  deletedResourceRevisions: {
    'leaf-1': 'leaf-r5',
    'folder-1': 'folder-r5',
  },
};

describe('canonical mutation capability', () => {
  test('authoritative planner runs after the lock in the same transaction and owns revision effects', async () => {
    const admitted = input();
    assert.equal('revisionEffects' in admitted.mutation, false);
    const plannedEffects = { resource: true, content: false, policy: false, childrenOf: [] } as const;
    const h = harness({ plan: (seen) => planFor(seen, { revisionEffects: plannedEffects }) });
    const tx = { id: 'tx-1' };

    const result = await h.application.execute({ transaction: tx }, admitted);

    assert.deepEqual(h.calls, [...CANONICAL_MUTATION_WRITE_ORDER]);
    assert.ok(h.transactions.every((seen) => seen === tx));
    assert.deepEqual(
      (h.argumentsByPort['allocation']?.[0] as { mutation: { revisionEffects: unknown } }).mutation.revisionEffects,
      plannedEffects,
    );
    assert.equal(result.allocation.resourceRevision, 'r-5');
  });

  test('does not create or re-enter a transaction', async () => {
    const h = harness();
    const context: CanonicalTransactionContext<Tx> = { transaction: { id: 'outer' } };
    await h.application.execute(context, input());
    assert.equal(h.transactions.length, CANONICAL_MUTATION_WRITE_ORDER.length);
    assert.ok(h.transactions.every((seen) => seen === context.transaction));
  });

  test.each([
    ['canonical-plan', ['collection-lock', 'canonical-plan']],
    ['allocation', ['collection-lock', 'canonical-plan', 'allocation']],
    ['resource', ['collection-lock', 'canonical-plan', 'allocation', 'resource']],
    ['operation', ['collection-lock', 'canonical-plan', 'allocation', 'resource', 'operation']],
    ['audit', ['collection-lock', 'canonical-plan', 'allocation', 'resource', 'operation', 'audit']],
    ['outbox', [...CANONICAL_MUTATION_WRITE_ORDER]],
  ] as const)('short-circuits after %s fails', async (failAt, expectedCalls) => {
    const h = harness({ failAt });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), h.failure);
    assert.deepEqual(h.calls, expectedCalls);
  });

  test('passes the sole caller operation id through every durable write and result', async () => {
    const h = harness();
    const admitted = { ...input(), operationId: 'caller-owned-operation' };
    const result = await h.application.execute({ transaction: { id: 'tx' } }, admitted);

    assert.equal((h.argumentsByPort['resource']?.[0] as { operationId: string }).operationId, admitted.operationId);
    assert.equal((h.argumentsByPort['operation']?.[0] as { operationId: string }).operationId, admitted.operationId);
    assert.equal((h.argumentsByPort['audit']?.[0] as { operationId: string }).operationId, admitted.operationId);
    const outboxEvent = (h.argumentsByPort['outbox']?.[0] as readonly { operationId: string; domainEventId: string }[])[0];
    assert.equal(outboxEvent?.operationId, admitted.operationId);
    assert.notEqual(outboxEvent?.domainEventId, admitted.operationId);
    assert.match(outboxEvent?.domainEventId ?? '', /^[A-Za-z0-9_-]{21}[AQgw]$/u);
    assert.equal(result.operationId, admitted.operationId);
  });

  test('carries the admitted actor principal into operation and audit evidence', async () => {
    const h = harness();
    const admitted = input();
    await h.application.execute({ transaction: { id: 'tx' } }, admitted);

    assert.equal(
      (h.argumentsByPort['operation']?.[0] as { actorPrincipalId: string }).actorPrincipalId,
      admitted.actor.principalId,
    );
    assert.equal(
      (h.argumentsByPort['audit']?.[0] as { principalId: string }).principalId,
      admitted.actor.principalId,
    );
  });

  test.each([
    ['missing lock', null],
    ['wrong collection lock', { ...locked, collectionId: 'collection-other' }],
  ] as const)('rejects %s before planning or writing', async (_name, lockResult) => {
    const h = harness({ locked: lockResult });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock']);
  });

  test('enforces collection binding and monotonic ordinal invariants', async () => {
    const h = harness();
    await assert.rejects(
      h.application.execute({ transaction: { id: 'tx' } }, input({ target: { ...input().mutation.target, collectionId: 'other' } })),
      isInvariant,
    );
    assert.deepEqual(h.calls, []);

    const badOrdinal = harness({ allocation: { ...allocation, commitOrdinal: 9n } });
    await assert.rejects(badOrdinal.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(badOrdinal.calls, ['collection-lock', 'canonical-plan', 'allocation']);
  });

  test('rejects relational fields in payload while allowing kind fields and extensions', async () => {
    await harness().application.execute(
      { transaction: { id: 'tx' } },
      input({ fields: { kindFields: { title: 'ok' }, extensions: { custom: true } } }),
    );
    await assert.rejects(
      harness().application.execute(
        { transaction: { id: 'tx' } },
        input({ fields: { kindFields: { parentId: 'forbidden' }, extensions: {} } }),
      ),
      (error: unknown) => error instanceof CanonicalMutationInvariantError
        && error.code === 'resource_field_authority_violation',
    );
  });

  test('rejects duplicate planner-owned children effects before allocation', async () => {
    const h = harness({
      plan: (admitted) => planFor(admitted, {
        revisionEffects: { resource: true, content: false, policy: false, childrenOf: ['p', 'p'] },
      }),
    });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan']);
  });

  test('binds one delete intent to an authoritative ordered subtree and exact revision allocation', async () => {
    const admitted = input({
      action: 'delete',
      target: { collectionId: 'collection-1', resourceId: 'folder-1', resourceKind: 'node' },
      parentId: 'root-1',
      fields: undefined,
      expectedResourceRevision: 'folder-r4',
      deleteIntent: { scope: 'subtree', expectedContentRevision: 'c-4' },
    });
    const deleteAllocation: AllocatedMutationState = {
      commitOrdinal: 5n,
      resourceRevision: 'folder-r5',
      contentRevision: 'c-5',
      childrenRevisions: { 'root-1': 'root-c5' },
      deletedResourceRevisions: {
        'leaf-1': 'leaf-r5',
        'folder-1': 'folder-r5',
      },
    };
    const h = harness({
      plan: (seen) => planFor(seen, {
        fields: undefined,
        deletePlan: { orderedResourceIds: ['leaf-1', 'folder-1'] },
        revisionEffects: { resource: true, content: true, policy: false, childrenOf: ['root-1'] },
      }),
      allocation: deleteAllocation,
    });

    const result = await h.application.execute({ transaction: { id: 'tx-delete' } }, admitted);

    assert.deepEqual(result.allocation.deletedResourceRevisions, deleteAllocation.deletedResourceRevisions);
    const operation = h.argumentsByPort['operation']?.[0] as { canonicalPayload: Record<string, unknown> };
    assert.deepEqual(operation.canonicalPayload.affectedResourceIds, ['leaf-1', 'folder-1']);
  });

  test('rejects a partial or retargeted delete allocation before any resource write', async () => {
    const admitted = input({
      action: 'delete',
      target: { collectionId: 'collection-1', resourceId: 'folder-1', resourceKind: 'node' },
      parentId: 'root-1',
      fields: undefined,
      deleteIntent: { scope: 'subtree', expectedContentRevision: 'c-4' },
    });
    const h = harness({
      plan: (seen) => planFor(seen, {
        fields: undefined,
        deletePlan: { orderedResourceIds: ['leaf-1', 'folder-1'] },
        revisionEffects: { resource: true, content: true, policy: false, childrenOf: ['root-1'] },
      }),
      allocation: {
        commitOrdinal: 5n,
        resourceRevision: 'wrong-target-revision',
        contentRevision: 'c-5',
        childrenRevisions: { 'root-1': 'root-c5' },
        deletedResourceRevisions: { 'folder-1': 'folder-r5' },
      },
    });

    await assert.rejects(h.application.execute({ transaction: { id: 'tx-delete' } }, admitted), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan', 'allocation']);
  });
});

describe('canonical revision and position tokens', () => {
  const invalidRevisionTokens = ['   ', 'bad\u0000token', 'x'.repeat(129), 'bad/token'] as const;
  const invalidPositionTokens = ['   ', 'bad\u0000token', 'x'.repeat(129), 'bad\u007ftoken'] as const;

  test.each(invalidRevisionTokens)('rejects invalid resource revision %j', async (token) => {
    const h = harness({ allocation: { ...allocation, resourceRevision: token } });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan', 'allocation']);
  });

  test.each(invalidRevisionTokens)('rejects invalid children revision %j', async (token) => {
    const h = harness({
      plan: (admitted) => planFor(admitted, {
        revisionEffects: { resource: true, content: false, policy: false, childrenOf: ['parent-1'] },
      }),
      allocation: { ...allocation, childrenRevisions: { 'parent-1': token } },
    });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan', 'allocation']);
  });

  test.each(invalidPositionTokens)('rejects invalid position token %j', async (token) => {
    const moved = input({ action: 'move', parentId: 'parent-1' });
    const h = harness({
      plan: (admitted) => planFor(admitted),
      allocation: { ...allocation, positionToken: token },
    });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, moved), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan', 'allocation']);
  });

  test('accepts a maximum-length COLP order key through the allocator contract', async () => {
    const moved = input({ action: 'move', parentId: 'parent-1' });
    const h = harness({
      plan: (admitted) => planFor(admitted),
      allocation: {
        ...allocation,
        positionToken: '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'.repeat(2),
      },
    });
    await h.application.execute({ transaction: { id: 'tx-printable-position' } }, moved);
    assert.deepEqual(h.calls, [...CANONICAL_MUTATION_WRITE_ORDER]);
  });

  test('accepts explicit sibling rebalance only for create or move allocations', async () => {
    const rebalancedSiblings = [{
      resourceId: 'sibling-1', positionToken: 'pos-6', resourceRevision: 'r-sibling-6',
    }] as const;
    const invalid = harness({ allocation: { ...allocation, rebalancedSiblings } });
    await assert.rejects(invalid.application.execute(
      { transaction: { id: 'tx-update' } }, input(),
    ), isInvariant);
    assert.deepEqual(invalid.calls, ['collection-lock', 'canonical-plan', 'allocation']);

    const created = input({ action: 'create', parentId: 'parent-1' });
    const valid = harness({ allocation: { ...allocation, rebalancedSiblings } });
    await valid.application.execute({ transaction: { id: 'tx-create' } }, created);
    assert.deepEqual(valid.calls, [...CANONICAL_MUTATION_WRITE_ORDER]);
  });

  test('requires one validated initial children revision for node create', async () => {
    const created = input({
      action: 'create',
      target: { ...input().mutation.target, resourceKind: 'node' },
      parentId: 'parent-1',
    });
    const missing = harness();
    await assert.rejects(
      missing.application.execute({ transaction: { id: 'tx-missing' } }, created),
      isInvariant,
    );
    assert.deepEqual(missing.calls, ['collection-lock', 'canonical-plan', 'allocation']);

    const invalid = harness({
      allocation: { ...allocation, createdNodeChildrenRevision: 'bad/revision' },
    });
    await assert.rejects(
      invalid.application.execute({ transaction: { id: 'tx-invalid' } }, created),
      isInvariant,
    );
    assert.deepEqual(invalid.calls, ['collection-lock', 'canonical-plan', 'allocation']);

    const valid = harness({
      allocation: { ...allocation, createdNodeChildrenRevision: 'children-r-1' },
    });
    await valid.application.execute({ transaction: { id: 'tx-valid' } }, created);
    assert.deepEqual(valid.calls, [...CANONICAL_MUTATION_WRITE_ORDER]);
  });
});

describe('independent admission owners', () => {
  function admission(
    name: string,
    canonical: CanonicalMutationApplication<Tx>,
  ) {
    const claims = new Set<string>();
    const receipts = new Map<string, unknown>();
    return {
      name,
      claims,
      receipts,
      canonical,
      async execute(operationId: string) {
        claims.add(operationId);
        const result = await canonical.execute(
          { transaction: { id: `${name}-transaction` } },
          { ...input(), operationId },
        );
        receipts.set(operationId, result);
        return result;
      },
    };
  }

  test('Product and Publisher share one capability but keep claims, receipts, and results isolated', async () => {
    const h = harness();
    const product = admission('product', h.application);
    const publisher = admission('publisher', h.application);

    const productResult = await product.execute('product-operation');
    const publisherResult = await publisher.execute('publisher-operation');

    assert.equal(product.canonical, publisher.canonical);
    assert.notEqual(product.claims, publisher.claims);
    assert.notEqual(product.receipts, publisher.receipts);
    assert.notEqual(productResult, publisherResult);
    assert.deepEqual([...product.claims], ['product-operation']);
    assert.deepEqual([...publisher.claims], ['publisher-operation']);
    assert.equal(product.receipts.has('publisher-operation'), false);
    assert.equal(publisher.receipts.has('product-operation'), false);
    assert.equal(productResult.operationId, 'product-operation');
    assert.equal(publisherResult.operationId, 'publisher-operation');

    const persistedOperationIds = h.argumentsByPort['operation']?.map(
      (record) => (record as { operationId: string }).operationId,
    );
    assert.deepEqual(persistedOperationIds, ['product-operation', 'publisher-operation']);
    assert.equal(new Set(persistedOperationIds).size, 2);
  });
});

describe('canonical mutation negative branches (T7)', () => {
  test.each([
    ['same relative anchor', input({
      action: 'move',
      parentId: 'parent-1',
      relativePosition: { afterId: 'sibling-1', beforeId: 'sibling-1' },
    }), [], isInvariant],
    ['non-delete carrying deleteIntent', input({
      deleteIntent: { scope: 'single' },
    }), [], isInvariant],
  ] as const)('rejects %s before any write port', async (_label, admitted, expectedCalls, matcher) => {
    const h = harness();
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, admitted), matcher);
    assert.deepEqual(h.calls, expectedCalls);
    assertNoWritePorts(h.calls);
  });

  test.each([
    ['missing deletePlan', () => deleteAdmitted(), (admitted: CanonicalMutationInput) => planFor(admitted, {
      fields: undefined,
      revisionEffects: { resource: true, content: true, policy: false, childrenOf: ['root-1'] },
    })],
    ['deletePlan target not last', () => deleteAdmitted(), (admitted: CanonicalMutationInput) => deletePlanFor(admitted, ['folder-1', 'leaf-1'])],
    ['deletePlan duplicate resource ids', () => deleteAdmitted(), (admitted: CanonicalMutationInput) => deletePlanFor(admitted, ['leaf-1', 'leaf-1', 'folder-1'])],
    ['deleteIntent scope mismatch', () => deleteAdmitted(), (admitted: CanonicalMutationInput) => deletePlanFor(admitted, ['leaf-1', 'folder-1'], {
      deleteIntent: { scope: 'single', expectedContentRevision: 'c-4' },
    })],
    ['non-delete carrying deletePlan', () => input(), (admitted: CanonicalMutationInput) => planFor(admitted, {
      deletePlan: { orderedResourceIds: ['folder-1'] },
    })],
  ] as const)('rejects delete plan binding %s before allocation', async (_label, admittedBuilder, planBuilder) => {
    const admitted = admittedBuilder();
    const h = harness({ plan: (seen) => planBuilder(seen) });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx-delete' } }, admitted), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan']);
    assertNoWritePorts(h.calls);
  });

  test.each([
    ['operationId', (admitted: CanonicalMutationInput, plan: CanonicalMutationPlan) => ({
      ...plan,
      operationId: `${plan.operationId}-drift`,
    })],
    ['collectionId', (admitted: CanonicalMutationInput, plan: CanonicalMutationPlan) => ({
      ...plan,
      collectionId: 'collection-other',
    })],
    ['target resourceId', (admitted: CanonicalMutationInput, plan: CanonicalMutationPlan) => ({
      ...plan,
      mutation: {
        ...plan.mutation,
        target: { ...plan.mutation.target, resourceId: 'resource-other' },
      },
    })],
    ['action', (admitted: CanonicalMutationInput, plan: CanonicalMutationPlan) => ({
      ...plan,
      mutation: { ...plan.mutation, action: 'update' },
    })],
  ] as const)('rejects plan identity mismatch on %s before allocation', async (_label, driftPlan) => {
    const admitted = deleteAdmitted();
    const h = harness({
      plan: (seen) => driftPlan(seen, deletePlanFor(seen)),
    });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx-delete' } }, admitted), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan']);
    assertNoWritePorts(h.calls);
  });

  test.each([
    ['non-positive commit ordinal', 'delete', {
      ...deleteAllocation,
      commitOrdinal: 0n,
    }],
    ['resource revision when effect disabled', 'create-disabled-resource', {
      ...allocation,
      resourceRevision: 'r-5',
    }],
    ['missing content revision when effect enabled', 'delete', {
      ...deleteAllocation,
      contentRevision: undefined,
    }],
    ['children revision parent mismatch', 'update-children', {
      ...allocation,
      childrenRevisions: { 'parent-other': 'parent-c5' },
    }],
    ['empty children revision token', 'update-children', {
      ...allocation,
      childrenRevisions: { 'parent-1': '' },
    }],
    ['delete allocation missing tombstone revisions', 'delete', {
      commitOrdinal: 5n,
      resourceRevision: 'folder-r5',
      contentRevision: 'c-5',
      childrenRevisions: { 'root-1': 'root-c5' },
      deletedResourceRevisions: { 'folder-1': 'folder-r5' },
    }],
  ] as const)('rejects illegal allocation shape: %s', async (_label, scenario, badAllocation) => {
    const admitted = scenario === 'delete'
      ? deleteAdmitted()
      : scenario === 'update-children'
        ? input()
        : input({ action: 'create', parentId: 'parent-1' });
    const h = harness({
      plan: (seen) => {
        if (scenario === 'delete') return deletePlanFor(seen);
        if (scenario === 'update-children') {
          return planFor(seen, {
            revisionEffects: { resource: true, content: false, policy: false, childrenOf: ['parent-1'] },
          });
        }
        return planFor(seen, {
          revisionEffects: { resource: false, content: false, policy: false, childrenOf: [] },
        });
      },
      allocation: badAllocation,
    });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, admitted), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan', 'allocation']);
    assertNoWritePorts(h.calls);
  });

  test('rejects locked collection revision mismatch before planning', async () => {
    const h = harness({
      locked: {
        ...locked,
        resourceRevision: 'bad revision token',
      },
    });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock']);
    assertNoWritePorts(h.calls);
  });

  test('rejects non-monotonic allocator ordinal before resource write', async () => {
    const h = harness({ allocation: { ...allocation, commitOrdinal: 99n } });
    await assert.rejects(h.application.execute({ transaction: { id: 'tx' } }, input()), isInvariant);
    assert.deepEqual(h.calls, ['collection-lock', 'canonical-plan', 'allocation']);
    assertNoWritePorts(h.calls);
  });
});

describe('canonical mutation import boundary', () => {
  test('domain and application sources do not import transport or database adapters', async () => {
    const fs = await import('node:fs/promises');
    for (const file of ['src/modules/collections/domain/canonical-mutation.ts', 'src/modules/collections/application/canonical-mutation.ts']) {
      const source = await fs.readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /fastify|kysely|\bpg\b/i);
    }
  });
});
