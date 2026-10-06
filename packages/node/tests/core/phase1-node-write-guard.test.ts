import { describe, expect, it, vi } from 'vitest';

import * as packageBoundary from '../../src/server/index.js';
import { isOpaqueId } from '../../src/semantic/index.js';
import {
  NodeWriteGuardError,
  executeGuardedNodeWrite,
  resolveNodeWriteLimits,
  type GuardedNodeWriteMutation,
  type NodeWriteGuardHooks,
  type NodeWriteResolver,
} from '../../src/server/index.js';
import type { StrictNode } from '../../src/types/index.js';

const timestamp = '2026-07-17T00:00:00Z';
const collection = Object.freeze({ id: 'collection-1', rootNodeId: 'root-1' });
type Candidate = { readonly requestId: string; readonly body?: Readonly<Record<string, unknown>> };

function candidate(): Candidate {
  return { requestId: 'request-1' };
}

function root(): Extract<StrictNode, { readonly kind: 'root' }> {
  return {
    id: 'root-1', collectionId: collection.id, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: 'Root', createdAt: timestamp, updatedAt: timestamp, revision: 'r-root',
  };
}

function folder(id: string, parentId = 'root-1'): Extract<StrictNode, { readonly kind: 'folder' }> {
  return {
    id, collectionId: collection.id, kind: 'folder', parentId, position: id, title: id,
    createdAt: timestamp, updatedAt: timestamp, revision: `r-${id}`,
  };
}

function bookmark(id: string, parentId = 'root-1'): Extract<StrictNode, { readonly kind: 'bookmark' }> {
  return {
    id, collectionId: collection.id, kind: 'bookmark', parentId, position: id, title: id,
    url: 'https://example.test/', createdAt: timestamp, updatedAt: timestamp, revision: `r-${id}`,
  };
}

function resolver(nodes: readonly StrictNode[]): NodeWriteResolver {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    async resolveCollection(id) {
      return id === collection.id ? collection : undefined;
    },
    async resolveNode(id) {
      return byId.get(id);
    },
    async resolveChildren(parentId, limit) {
      const children = nodes.filter((node) => node.parentId === parentId);
      return { nodes: children.slice(0, limit), hasMore: children.length > limit };
    },
  };
}

function hooks(
  authorize: NodeWriteGuardHooks<NodeWriteResolver, Candidate>['authorize'] = async () => ({ allowed: true }),
): NodeWriteGuardHooks<NodeWriteResolver, Candidate> {
  return {
    validate: async () => ({ allowed: true }),
    preAuthorize: async () => ({ allowed: true }),
    authorize,
    evaluatePolicy: async () => ({ allowed: true }),
  };
}

async function execute(
  mutation: GuardedNodeWriteMutation,
  context: NodeWriteResolver,
  guardHooks = hooks(),
  limits = {},
) {
  return executeGuardedNodeWrite(
    candidate(),
    mutation,
    { async run(work) { return work(context); } },
    guardHooks,
    async (_transaction, _candidate, plan) => ({
      result: plan,
      modifiedNodeIds: [...plan.modifiedNodeIds].reverse(),
      deletedNodeIds: [...plan.deletedNodeIds].reverse(),
      deletedNodeCount: plan.deletedNodeCount,
    }),
    limits,
  );
}

function denialCode(error: unknown): string | undefined {
  return error instanceof NodeWriteGuardError ? error.denial.code : undefined;
}

describe('Phase 1 composed Node write guard [evidence:core.guarded-node-write]', () => {
  it('is exported from the server public entry and freezes an ID-only create plan', async () => {
    expect(packageBoundary.executeGuardedNodeWrite).toBe(executeGuardedNodeWrite);
    const plan = await execute(
      { kind: 'create-node', nodeId: 'new-1', collectionId: collection.id, nodeKind: 'bookmark', parentId: 'root-1' },
      resolver([root()]),
    );
    expect(plan).toMatchObject({
      collectionId: collection.id,
      authorizationNodeIds: ['new-1', 'root-1'],
      modifiedNodeIds: ['new-1', 'root-1'],
      deletedNodeIds: [],
      deletedNodeCount: 0,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.mutation)).toBe(true);
    expect(Object.isFrozen(plan.modifiedNodeIds)).toBe(true);
  });

  it('binds one detached immutable validated candidate to authorization and persistence', async () => {
    const input = { requestId: 'request-bound', body: { title: 'before' } };
    let validated: Readonly<Candidate> | undefined;
    let authorized: Readonly<Candidate> | undefined;
    let persisted: Readonly<Candidate> | undefined;
    const operation = executeGuardedNodeWrite(
      input,
      { kind: 'update-node', nodeId: 'bookmark-1' },
      { async run(work) { return work(resolver([root(), bookmark('bookmark-1')])); } },
      {
        validate: async (_context, checked) => { validated = checked; return { allowed: true }; },
        preAuthorize: async () => ({ allowed: true }),
        authorize: async (_context, checked) => { authorized = checked; return { allowed: true }; },
        evaluatePolicy: async () => ({ allowed: true }),
      },
      async (_context, checked, plan) => {
        persisted = checked;
        return {
          result: checked,
          modifiedNodeIds: plan.modifiedNodeIds,
          deletedNodeIds: plan.deletedNodeIds,
          deletedNodeCount: plan.deletedNodeCount,
        };
      },
    );
    input.body.title = 'after';

    const result = await operation;
    expect(result).toBe(validated);
    expect(authorized).toBe(validated);
    expect(persisted).toBe(validated);
    expect(result).toEqual({ requestId: 'request-bound', body: { title: 'before' } });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.body)).toBe(true);
    await expect(executeGuardedNodeWrite(
      { requestId: 'request-date', body: { value: new Date() } },
      { kind: 'update-node', nodeId: 'bookmark-1' },
      { async run(work) { return work(resolver([root(), bookmark('bookmark-1')])); } },
      hooks() as never,
      async () => ({ result: undefined, modifiedNodeIds: [], deletedNodeIds: [], deletedNodeCount: 0 }),
    )).rejects.toThrow('plain structured data');
  });

  it('rejects non-structural Parents, cross-Collection state, Root deletion, and proposed cycles', async () => {
    await expect(execute(
      { kind: 'create-node', nodeId: 'new-1', collectionId: collection.id, nodeKind: 'folder', parentId: 'bookmark-1' },
      resolver([root(), bookmark('bookmark-1')]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'invalid_parent_kind');

    const foreign = { ...folder('foreign'), collectionId: 'collection-2' } as StrictNode;
    await expect(execute(
      { kind: 'move-node', nodeId: 'folder-1', parentId: 'foreign' },
      resolver([root(), folder('folder-1'), foreign]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_collection_mismatch');

    await expect(execute(
      { kind: 'delete-node', nodeId: 'root-1' },
      resolver([root()]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'root_invariant');

    const parent = folder('parent');
    const child = folder('child', parent.id);
    await expect(execute(
      { kind: 'move-node', nodeId: parent.id, parentId: child.id },
      resolver([root(), parent, child]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'parent_cycle');
  });

  it('Core-traverses delete-subtree, authorizes every affected ID, and enforces read-only descendants', async () => {
    const subtree = folder('subtree');
    const nested = folder('nested', subtree.id);
    const leaf = bookmark('leaf', nested.id);
    const authorize = vi.fn<NodeWriteGuardHooks<NodeWriteResolver, Candidate>['authorize']>(
      async () => ({ allowed: true as const }),
    );
    const evaluatePolicy = vi.fn<NodeWriteGuardHooks<NodeWriteResolver, Candidate>['evaluatePolicy']>(
      async () => ({ allowed: true as const }),
    );
    const plan = await execute(
      { kind: 'delete-subtree', nodeId: subtree.id },
      resolver([root(), subtree, nested, leaf]),
      { ...hooks(authorize), evaluatePolicy },
    );
    expect(plan.authorizationNodeIds).toEqual(['root-1', 'subtree', 'nested', 'leaf']);
    expect(plan.modifiedNodeIds).toEqual(['root-1', 'subtree', 'nested', 'leaf']);
    expect(plan.deletedNodeIds).toEqual(['subtree', 'nested', 'leaf']);
    expect(plan.deletedNodeCount).toBe(3);
    expect(authorize.mock.calls.map((call) => call[3])).toEqual(plan.authorizationNodeIds);
    expect(evaluatePolicy.mock.calls.map((call) => call[3])).toEqual(plan.authorizationNodeIds);

    await expect(execute(
      { kind: 'delete-subtree', nodeId: subtree.id },
      resolver([root(), subtree, nested, leaf]),
      {
        ...hooks(),
        evaluatePolicy: async (_context, _candidate, _mutation, nodeId) => nodeId === leaf.id
          ? { allowed: false, reason: 'retention policy' }
          : { allowed: true },
      },
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_policy_denied');

    const locked = { ...leaf, constraints: { readOnly: true, reason: 'locked' } } as StrictNode;
    await expect(execute(
      { kind: 'delete-subtree', nodeId: subtree.id },
      resolver([root(), subtree, nested, locked]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_read_only');
  });

  it('fails closed on ancestry, subtree depth, and visited-node limits before writing', async () => {
    const first = folder('first');
    const second = folder('second', first.id);
    const third = folder('third', second.id);
    const context = resolver([root(), first, second, third]);
    await expect(execute(
      { kind: 'update-node', nodeId: third.id },
      context,
      hooks(),
      { maxDepth: 2 },
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_ancestry_too_deep');
    await expect(execute(
      { kind: 'delete-subtree', nodeId: first.id },
      context,
      hooks(),
      { maxDepth: 1 },
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_too_deep');
    await expect(execute(
      { kind: 'delete-subtree', nodeId: first.id },
      context,
      hooks(),
      { maxVisitedNodes: 2 },
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_too_large');
    expect(() => resolveNodeWriteLimits({ maxDepth: 4_097 })).toThrow('maxDepth');
  });

  it('does not let the ancestry cache accept a subtree whose upward path is unresolved', async () => {
    const orphanParent = folder('orphan-parent', 'missing-parent');
    const subtree = folder('orphan-subtree', orphanParent.id);
    const leaf = bookmark('orphan-leaf', subtree.id);

    await expect(execute(
      { kind: 'delete-subtree', nodeId: subtree.id },
      resolver([root(), orphanParent, subtree, leaf]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_ancestry_unresolved');
  });

  it('validates a deep subtree ancestry in linear time while preserving every participant', { timeout: 10_000 }, async () => {
    const depth = 3_000;
    const nodes: StrictNode[] = [root()];
    const childrenByParent = new Map<string, StrictNode[]>();
    let parentId = 'root-1';
    for (let index = 1; index <= depth; index += 1) {
      const node = folder(`linear-${index}`, parentId);
      nodes.push(node);
      childrenByParent.set(parentId, [node]);
      parentId = node.id;
    }
    childrenByParent.set(parentId, []);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const context: NodeWriteResolver = {
      async resolveCollection(id) { return id === collection.id ? collection : undefined; },
      async resolveNode(id) { return byId.get(id); },
      async resolveChildren(id, limit) {
        const children = childrenByParent.get(id) ?? [];
        return { nodes: children.slice(0, limit), hasMore: children.length > limit };
      },
    };

    const started = performance.now();
    const plan = await execute(
      { kind: 'delete-subtree', nodeId: 'linear-1' },
      context,
      hooks(),
      { maxDepth: depth + 1, maxVisitedNodes: depth + 1 },
    );

    expect(plan.deletedNodeCount).toBe(depth);
    expect(plan.authorizationNodeIds).toHaveLength(depth + 1);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('runs validation before ACL and rejects a writer affected-set mismatch inside the unit of work', async () => {
    const events: string[] = [];
    const context = resolver([root(), bookmark('bookmark-1')]);
    const unitOfWork = {
      async run<Result>(work: (value: NodeWriteResolver) => Promise<Result>): Promise<Result> {
        events.push('begin');
        try { return await work(context); } finally { events.push('rollback-or-commit'); }
      },
    };
    await expect(executeGuardedNodeWrite(
      candidate(),
      { kind: 'update-node', nodeId: 'bookmark-1' },
      unitOfWork,
      {
        validate: async () => { events.push('validate'); return { allowed: true }; },
        preAuthorize: async () => { events.push('pre-authorize'); return { allowed: true }; },
        authorize: async () => { events.push('authorize'); return { allowed: true }; },
        evaluatePolicy: async () => { events.push('policy'); return { allowed: true }; },
      },
      async () => {
        events.push('write');
        return { result: undefined, modifiedNodeIds: ['other'], deletedNodeIds: [], deletedNodeCount: 0 };
      },
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'affected_nodes_mismatch');
    expect(events).toEqual(['begin', 'validate', 'pre-authorize', 'authorize', 'policy', 'write', 'rollback-or-commit']);
  });

  it('fails closed when validation or per-Node authorization denies the operation', async () => {
    const context = resolver([root(), bookmark('bookmark-1')]);
    const write = vi.fn();
    await expect(executeGuardedNodeWrite(
      candidate(),
      { kind: 'update-node', nodeId: 'bookmark-1' },
      { async run(work) { return work(context); } },
      {
        validate: async () => ({ allowed: false, reason: 'invalid body' }),
        preAuthorize: async () => ({ allowed: true }),
        authorize: async () => ({ allowed: true }),
        evaluatePolicy: async () => ({ allowed: true }),
      },
      write,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'invalid_node_mutation');
    await expect(execute(
      { kind: 'update-node', nodeId: 'bookmark-1' },
      context,
      hooks(async () => ({ allowed: false, reason: 'forbidden' })),
    )).rejects.toMatchObject({ denial: { code: 'authorization_denied', atNodeId: 'bookmark-1' } });
    expect(write).not.toHaveBeenCalled();
  });

  it('pre-authorizes before any authoritative graph read', async () => {
    const resolveCollection = vi.fn<NodeWriteResolver['resolveCollection']>(async () => collection);
    const resolveNode = vi.fn<NodeWriteResolver['resolveNode']>(async () => root());
    const resolveChildren = vi.fn<NodeWriteResolver['resolveChildren']>(async () => ({ nodes: [], hasMore: false }));
    const write = vi.fn();

    await expect(executeGuardedNodeWrite(
      candidate(),
      { kind: 'delete-subtree', nodeId: 'secret-subtree' },
      { async run(work) { return work({ resolveCollection, resolveNode, resolveChildren }); } },
      {
        validate: async () => ({ allowed: true }),
        preAuthorize: async () => ({ allowed: false, reason: 'concealed' }),
        authorize: async () => ({ allowed: true }),
        evaluatePolicy: async () => ({ allowed: true }),
      },
      write,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'authorization_denied');

    expect(resolveCollection).not.toHaveBeenCalled();
    expect(resolveNode).not.toHaveBeenCalled();
    expect(resolveChildren).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('supports move, reparent, restore, delete, and complete reorder plans', async () => {
    const source = folder('source');
    const destination = folder('destination');
    const childA = bookmark('child-a', source.id);
    const childB = bookmark('child-b', source.id);
    const context = resolver([root(), source, destination, childA, childB]);

    await expect(execute(
      { kind: 'move-node', nodeId: childA.id, parentId: destination.id }, context,
    )).resolves.toMatchObject({ modifiedNodeIds: ['child-a', 'source', 'destination'] });
    await expect(execute(
      { kind: 'reparent-node', nodeId: childA.id, parentId: destination.id }, context,
    )).resolves.toMatchObject({ modifiedNodeIds: ['child-a', 'source', 'destination'] });
    await expect(execute(
      { kind: 'restore-node', nodeId: childA.id, parentId: destination.id }, context,
    )).resolves.toMatchObject({ modifiedNodeIds: ['child-a', 'destination'] });
    await expect(execute(
      { kind: 'delete-node', nodeId: childA.id }, context,
    )).resolves.toMatchObject({ modifiedNodeIds: ['child-a', 'source'], deletedNodeIds: ['child-a'], deletedNodeCount: 1 });
    await expect(execute(
      { kind: 'reorder-children', parentId: source.id, childIds: [childB.id, childA.id] }, context,
    )).resolves.toMatchObject({ modifiedNodeIds: ['source', 'child-b', 'child-a'] });
    await expect(execute(
      { kind: 'reorder-children', parentId: source.id, childIds: [childA.id] }, context,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'invalid_node_mutation');
  });

  it('requires reorder-children to match the immediate child set exactly once', async () => {
    const parent = folder('reorder-parent');
    const childA = bookmark('reorder-a', parent.id);
    const childB = bookmark('reorder-b', parent.id);
    const childC = bookmark('reorder-c', parent.id);
    const context = resolver([root(), parent, childA, childB, childC]);
    const reorderDenial = (error: unknown) => (
      error instanceof NodeWriteGuardError
      && error.denial.code === 'invalid_node_mutation'
      && error.message.includes('every immediate child')
    );

    // Missing child: omits an existing immediate child.
    await expect(execute(
      { kind: 'reorder-children', parentId: parent.id, childIds: [childA.id, childB.id] }, context,
    )).rejects.toSatisfy(reorderDenial);

    // Extra child: includes an unknown id not among immediate children.
    await expect(execute(
      {
        kind: 'reorder-children',
        parentId: parent.id,
        childIds: [childA.id, childB.id, childC.id, 'unknown-sibling'],
      },
      context,
    )).rejects.toSatisfy(reorderDenial);

    // Extra + missing combination (swap unknown for omitted real child).
    await expect(execute(
      {
        kind: 'reorder-children',
        parentId: parent.id,
        childIds: [childA.id, childB.id, 'unknown-sibling'],
      },
      context,
    )).rejects.toSatisfy(reorderDenial);

    // Duplicate childIds are rejected at mutation snapshot (unique) before plan matching.
    await expect(execute(
      {
        kind: 'reorder-children',
        parentId: parent.id,
        childIds: [childA.id, childB.id, childB.id],
      },
      context,
    )).rejects.toThrow('unique');

    // Valid full permutation of all immediate children succeeds.
    await expect(execute(
      {
        kind: 'reorder-children',
        parentId: parent.id,
        childIds: [childC.id, childA.id, childB.id],
      },
      context,
    )).resolves.toMatchObject({
      modifiedNodeIds: ['reorder-parent', 'reorder-c', 'reorder-a', 'reorder-b'],
    });
  });

  it('rejects collisions, missing identities, malformed ancestry, and invalid constraints', async () => {
    await expect(execute(
      { kind: 'create-node', nodeId: 'existing', collectionId: collection.id, nodeKind: 'folder', parentId: 'root-1' },
      resolver([root(), folder('existing')]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_already_exists');
    await expect(execute(
      { kind: 'update-node', nodeId: 'missing' }, resolver([root()]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_unresolved');

    const noCollection: NodeWriteResolver = {
      ...resolver([root(), folder('node')]),
      async resolveCollection() { return undefined; },
    };
    await expect(execute(
      { kind: 'update-node', nodeId: 'node' }, noCollection,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'collection_unresolved');

    const first = { ...folder('first'), parentId: 'second' } as StrictNode;
    const second = { ...folder('second'), parentId: 'first' } as StrictNode;
    await expect(execute(
      { kind: 'update-node', nodeId: first.id }, resolver([first, second]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_ancestry_cycle');

    const malformed = { ...bookmark('malformed'), constraints: { readOnly: 'yes' } } as unknown as StrictNode;
    await expect(execute(
      { kind: 'update-node', nodeId: malformed.id }, resolver([root(), malformed]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'invalid_node_constraints');
  });

  it('rejects Root placement and malformed authoritative child sets', async () => {
    await expect(execute(
      { kind: 'move-node', nodeId: 'root-1', parentId: 'folder-1' },
      resolver([root(), folder('folder-1')]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'root_invariant');

    const fakeRoot = { ...root(), id: 'fake-root', revision: 'r-fake' } as StrictNode;
    await expect(execute(
      { kind: 'create-node', nodeId: 'new', collectionId: collection.id, nodeKind: 'folder', parentId: fakeRoot.id },
      resolver([root(), fakeRoot]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'root_invariant');

    const parent = folder('parent');
    const child = bookmark('child', parent.id);
    const base = resolver([root(), parent, child]);
    const nonArray = { ...base, resolveChildren: async () => ({}) } as unknown as NodeWriteResolver;
    await expect(execute(
      { kind: 'delete-subtree', nodeId: parent.id }, nonArray,
    )).rejects.toThrow('bounded children page');

    const leafWithChild: NodeWriteResolver = {
      ...base,
      async resolveChildren(id, limit) {
        return id === child.id
          ? { nodes: [bookmark('impossible', child.id)], hasMore: false }
          : base.resolveChildren(id, limit);
      },
    };
    await expect(execute(
      { kind: 'delete-subtree', nodeId: child.id }, leafWithChild,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'invalid_parent_kind');

    const malformedChild: NodeWriteResolver = {
      ...base,
      async resolveChildren(id) {
        return id === parent.id
          ? { nodes: [{ ...child, parentId: 'other' }] as StrictNode[], hasMore: false }
          : { nodes: [], hasMore: false };
      },
    };
    await expect(execute(
      { kind: 'delete-subtree', nodeId: parent.id }, malformedChild,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_unresolved');

    const duplicateChild: NodeWriteResolver = {
      ...base,
      async resolveChildren(id) {
        return id === parent.id
          ? { nodes: [child, { ...child }], hasMore: false }
          : { nodes: [], hasMore: false };
      },
    };
    await expect(execute(
      { kind: 'delete-subtree', nodeId: parent.id }, duplicateChild,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_cycle');
  });

  it('cross-checks children against resolveNode while accepting detached equivalent rows', async () => {
    const parent = folder('parent');
    const child = bookmark('child', parent.id);
    const base = resolver([root(), parent, child]);
    const detachedChildren: NodeWriteResolver = {
      ...base,
      async resolveChildren(id) {
        return id === parent.id
          ? { nodes: [{ ...child }], hasMore: false }
          : { nodes: [], hasMore: false };
      },
    };
    await expect(execute(
      { kind: 'delete-subtree', nodeId: parent.id }, detachedChildren,
    )).resolves.toMatchObject({
      modifiedNodeIds: ['root-1', 'parent', 'child'],
      deletedNodeIds: ['parent', 'child'],
      deletedNodeCount: 2,
    });

    const disagreeingNode: NodeWriteResolver = {
      ...detachedChildren,
      async resolveNode(id) { return id === child.id ? { ...child, parentId: 'other' } : base.resolveNode(id); },
    };
    await expect(execute(
      { kind: 'delete-subtree', nodeId: parent.id }, disagreeingNode,
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_unresolved');
  });

  it('bounds child queries before materialization and detects cross-level subtree cycles', async () => {
    const subtree = folder('subtree');
    const base = resolver([root(), subtree]);
    const resolveChildren = vi.fn<NodeWriteResolver['resolveChildren']>(
      async () => ({ nodes: [], hasMore: true }),
    );
    await expect(execute(
      { kind: 'delete-subtree', nodeId: subtree.id },
      { ...base, resolveChildren },
      hooks(),
      { maxVisitedNodes: 1 },
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_too_large');
    expect(resolveChildren).toHaveBeenCalledWith(subtree.id, 0);

    const first = { ...folder('cycle-a'), parentId: 'cycle-b' } as StrictNode;
    const second = { ...folder('cycle-b'), parentId: 'cycle-a' } as StrictNode;
    await expect(execute(
      { kind: 'delete-subtree', nodeId: first.id },
      resolver([root(), first, second]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'node_subtree_cycle');
  });

  it('rejects non-recursive deletion of a non-empty Folder', async () => {
    const parent = folder('parent');
    const child = bookmark('child', parent.id);
    await expect(execute(
      { kind: 'delete-node', nodeId: parent.id },
      resolver([root(), parent, child]),
    )).rejects.toSatisfy((error: unknown) => denialCode(error) === 'folder_not_empty');
  });

  it('treats Core guarded mutation IDs as non-empty adapter IDs, not OpaqueId wire grammar', async () => {
    // Snapshot rejects only empty / non-string IDs (isNonEmptyId: typeof string && length > 0).
    await expect(execute(
      { kind: 'update-node', nodeId: '' },
      resolver([root()]),
    )).rejects.toThrow(/non-empty/);

    // Vectors that fail isOpaqueId (/^[A-Za-z0-9._~-]{1,128}$/) but are non-empty strings.
    const spaceId = 'node with space';
    const longId = 'x'.repeat(200);
    const slashId = 'bad/id';
    // Whitespace-only is length > 0, so isNonEmptyId accepts it (documented boundary).
    const whitespaceOnly = ' ';
    const nonOpaqueIds = [spaceId, longId, slashId, whitespaceOnly] as const;

    for (const id of nonOpaqueIds) {
      expect(isOpaqueId(id), `fixture ${JSON.stringify(id)} must fail OpaqueId wire grammar`).toBe(false);
    }

    const wireOrEmptyIdShape = /non-empty|URI Unreserved|Wire ID|opaque/i;

    // Unresolved path: non-opaque IDs pass snapshot and fail later as node_unresolved,
    // not TypeError about OpaqueId / non-empty ID shape.
    for (const nodeId of nonOpaqueIds) {
      await expect(execute(
        { kind: 'update-node', nodeId },
        resolver([root()]),
      )).rejects.toSatisfy((error: unknown) => {
        if (error instanceof TypeError && wireOrEmptyIdShape.test(error.message)) {
          return false;
        }
        return denialCode(error) === 'node_unresolved';
      });

      await expect(execute(
        { kind: 'delete-node', nodeId },
        resolver([root()]),
      )).rejects.toSatisfy((error: unknown) => {
        if (error instanceof TypeError && wireOrEmptyIdShape.test(error.message)) {
          return false;
        }
        return denialCode(error) === 'node_unresolved';
      });
    }

    // Full execute path completes when the adapter resolver has the non-opaque node.
    const weird = bookmark(spaceId);
    const plan = await execute(
      { kind: 'update-node', nodeId: spaceId },
      resolver([root(), weird]),
    );
    expect(plan.mutation).toEqual({ kind: 'update-node', nodeId: spaceId });
    expect(plan.modifiedNodeIds).toContain(spaceId);
  });

  it('validates mutation snapshots, decisions, native Promise ports, and writer reports', async () => {
    const context = resolver([root(), bookmark('bookmark-1')]);
    const run = (mutation: unknown) => executeGuardedNodeWrite(
      candidate(),
      mutation as GuardedNodeWriteMutation,
      { async run(work) { return work(context); } },
      hooks(),
      async (_transaction, _candidate, plan) => ({
        result: undefined,
        modifiedNodeIds: plan.modifiedNodeIds,
        deletedNodeIds: plan.deletedNodeIds,
        deletedNodeCount: plan.deletedNodeCount,
      }),
    );
    await expect(run(null)).rejects.toThrow('must be an object');
    await expect(run({ kind: 'create-node', nodeId: 'new', collectionId: collection.id, nodeKind: 'root', parentId: 'root-1' })).rejects.toThrow('non-Root');
    await expect(run({ kind: 'update-node', nodeId: '' })).rejects.toThrow('non-empty');
    await expect(run({ kind: 'reorder-children', parentId: 'root-1', childIds: 'child' })).rejects.toThrow('array');
    await expect(run({ kind: 'reorder-children', parentId: 'root-1', childIds: ['child', 'child'] })).rejects.toThrow('unique');
    await expect(run({ kind: 'unknown' })).rejects.toThrow('Unknown');

    await expect(executeGuardedNodeWrite(
      candidate(),
      { kind: 'update-node', nodeId: 'bookmark-1' },
      { async run(work) { return work(context); } },
      {
        validate: async () => null as never,
        preAuthorize: async () => ({ allowed: true }),
        authorize: async () => ({ allowed: true }),
        evaluatePolicy: async () => ({ allowed: true }),
      },
      async () => ({ result: undefined, modifiedNodeIds: ['bookmark-1'], deletedNodeIds: [], deletedNodeCount: 0 }),
    )).rejects.toThrow('allow or deny decision');
    await expect(executeGuardedNodeWrite(
      candidate(),
      { kind: 'update-node', nodeId: 'bookmark-1' },
      { async run(work) { return work(context); } },
      {
        validate: async () => ({ allowed: true }),
        preAuthorize: async () => ({ allowed: true }),
        authorize: async () => ({ allowed: false, reason: '' }),
        evaluatePolicy: async () => ({ allowed: true }),
      },
      async () => ({ result: undefined, modifiedNodeIds: ['bookmark-1'], deletedNodeIds: [], deletedNodeCount: 0 }),
    )).rejects.toThrow('non-empty reason');

    const thenableUnit = { run: ((work: (value: NodeWriteResolver) => Promise<unknown>) => ({ then: work })) } as never;
    await expect(executeGuardedNodeWrite(
      candidate(), { kind: 'update-node', nodeId: 'bookmark-1' }, thenableUnit, hooks(), async () => ({ result: undefined, modifiedNodeIds: [], deletedNodeIds: [], deletedNodeCount: 0 }),
    )).rejects.toThrow('must return a Promise');

    for (const report of [
      null,
      { result: undefined, modifiedNodeIds: ['bookmark-1'], deletedNodeIds: [], deletedNodeCount: 2 },
      { result: undefined, modifiedNodeIds: ['bookmark-1', 'bookmark-1'], deletedNodeIds: [], deletedNodeCount: 0 },
    ]) {
      await expect(executeGuardedNodeWrite(
        candidate(),
        { kind: 'update-node', nodeId: 'bookmark-1' },
        { async run(work) { return work(context); } },
        hooks(),
        async () => report as never,
      )).rejects.toThrow();
    }
  });
});
