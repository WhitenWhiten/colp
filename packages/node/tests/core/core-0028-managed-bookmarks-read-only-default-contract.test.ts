import { describe, expect, it, vi } from 'vitest';

import * as packageBoundary from '../../src/server/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import * as serverBoundary from '../../src/server/index.js';
import { problemRegistry } from '../../src/server/problems.js';
import type { FolderRole, NodeConstraints, StrictNode } from '../../src/types/index.js';

const evidence = '[evidence:core.managed-bookmarks-read-only-default]';
const timestamp = '2026-07-17T06:00:00Z';
const defaultDenialReason = 'The node is read-only.';

type ReadOnlyResolution = Readonly<{
  readOnly: boolean;
  source: 'explicit-constraint' | 'managed-bookmarks-default' | 'invalid-constraint' | 'none';
  reason: string | null;
}>;
type ResolveNodeReadOnly = (node: StrictNode) => ReadOnlyResolution;

type NodeMutation =
  | { readonly kind: 'create-child'; readonly parent: StrictNode }
  | { readonly kind: 'update-node'; readonly node: StrictNode }
  | { readonly kind: 'move-node'; readonly node: StrictNode; readonly targetParent: StrictNode }
  | { readonly kind: 'reorder-children'; readonly parent: StrictNode }
  | { readonly kind: 'delete-node'; readonly node: StrictNode }
  | { readonly kind: 'delete-subtree'; readonly node: StrictNode }
  | { readonly kind: 'restore-node'; readonly node: StrictNode; readonly parent: StrictNode };
type MutationResolver = Readonly<{
  resolveNode(nodeId: string): Promise<StrictNode | undefined>;
  resolveDescendants(nodeId: string): Promise<Iterable<StrictNode> | AsyncIterable<StrictNode>>;
}>;
type MutationResult =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      code: 'node_read_only' | 'node_ancestry_unresolved' | 'invalid_node_constraints';
      nodeId: string;
      reason: string;
      source?: Exclude<ReadOnlyResolution['source'], 'none'>;
    }>;
type MutationLimits = Readonly<{ maxDepth?: number; maxVisitedNodes?: number }>;
type EvaluateNodeMutationPolicy = (
  mutation: NodeMutation,
  resolver: MutationResolver,
  limits?: MutationLimits,
) => Promise<MutationResult>;
type MutationUnitOfWork<Context extends MutationResolver> = {
  run<Result>(work: (context: Context) => Promise<Result>): Promise<Result>;
};
type ExecuteNodeMutationPolicyGuardedWrite = <Context extends MutationResolver, Result>(
  mutation: NodeMutation,
  unitOfWork: MutationUnitOfWork<Context>,
  write: (context: Context, mutation: NodeMutation, policy: { readonly allowed: true }) => Promise<Result>,
  limits?: MutationLimits,
) => Promise<Result>;
type MutationPolicyErrorConstructor = new (...arguments_: any[]) => Error & {
  readonly denial: Exclude<MutationResult, { readonly allowed: true }>;
};
type ManagedBookmarksApi = {
  readonly resolveNodeReadOnly?: ResolveNodeReadOnly;
  readonly evaluateNodeMutationPolicy?: EvaluateNodeMutationPolicy;
  readonly executeNodeMutationPolicyGuardedWrite?: ExecuteNodeMutationPolicyGuardedWrite;
  readonly NodeMutationPolicyError?: MutationPolicyErrorConstructor;
};

const resolveNodeReadOnly = (serverBoundary as ManagedBookmarksApi).resolveNodeReadOnly;
const evaluateNodeMutationPolicy = (serverBoundary as ManagedBookmarksApi).evaluateNodeMutationPolicy;
const executeNodeMutationPolicyGuardedWrite =
  (serverBoundary as ManagedBookmarksApi).executeNodeMutationPolicyGuardedWrite;
const NodeMutationPolicyError = (serverBoundary as ManagedBookmarksApi).NodeMutationPolicyError;
const validators = createValidatorRegistry();

function resolve(): ResolveNodeReadOnly {
  expect(resolveNodeReadOnly, 'CORE-0028 needs a public read-only resolver').toBeTypeOf('function');
  return resolveNodeReadOnly as ResolveNodeReadOnly;
}

function evaluate(): EvaluateNodeMutationPolicy {
  expect(
    evaluateNodeMutationPolicy,
    'CORE-0028 needs a transaction-context mutation policy',
  ).toBeTypeOf('function');
  return evaluateNodeMutationPolicy as EvaluateNodeMutationPolicy;
}

function execute(): ExecuteNodeMutationPolicyGuardedWrite {
  expect(
    executeNodeMutationPolicyGuardedWrite,
    'CORE-0028 needs an atomic policy-and-write boundary',
  ).toBeTypeOf('function');
  return executeNodeMutationPolicyGuardedWrite as ExecuteNodeMutationPolicyGuardedWrite;
}

function folder(
  role: Exclude<FolderRole, 'root'>,
  explicit?: NodeConstraints,
): Extract<StrictNode, { readonly kind: 'folder' }> {
  return {
    id: `folder-${role}`,
    collectionId: 'collection-managed-default',
    kind: 'folder',
    parentId: 'root-managed-default',
    position: 'A',
    folderRole: role,
    title: role,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `revision-${role}`,
    ...(explicit === undefined ? {} : { constraints: explicit }),
  };
}

function root(explicit?: NodeConstraints): Extract<StrictNode, { readonly kind: 'root' }> {
  return {
    id: 'root-managed-default',
    collectionId: 'collection-managed-default',
    kind: 'root',
    parentId: null,
    position: null,
    folderRole: 'root',
    title: 'Root',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'revision-root',
    ...(explicit === undefined ? {} : { constraints: explicit }),
  };
}

function bookmark(
  id = 'bookmark-managed-default',
  parentId = 'root-managed-default',
  explicit?: NodeConstraints,
): Extract<StrictNode, { readonly kind: 'bookmark' }> {
  return {
    id,
    collectionId: 'collection-managed-default',
    kind: 'bookmark',
    parentId,
    position: 'B',
    title: id,
    url: 'https://example.test/',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `revision-${id}`,
    ...(explicit === undefined ? {} : { constraints: explicit }),
  };
}

function policyResolver(
  nodes: readonly StrictNode[],
  descendants: Readonly<Record<string, readonly StrictNode[]>> = {},
): MutationResolver {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    async resolveNode(nodeId) {
      return byId.get(nodeId);
    },
    async resolveDescendants(nodeId) {
      return descendants[nodeId] ?? [];
    },
  };
}

describe(`CORE-0028 managed-bookmarks read-only default ${evidence}`, () => {
  describe('public contracts', () => {
    it.each([
      ['server', 'resolveNodeReadOnly', serverBoundary],
      ['server public entry', 'resolveNodeReadOnly', packageBoundary],
      ['server', 'evaluateNodeMutationPolicy', serverBoundary],
      ['server public entry', 'evaluateNodeMutationPolicy', packageBoundary],
    ] as const)('exports %s %s', (_label, name, boundary) => {
      const expected = name === 'resolveNodeReadOnly' ? resolve() : evaluate();
      expect((boundary as ManagedBookmarksApi)[name]).toBe(expected);
    });
  });

  describe('effective default and explicit override', () => {
    it('defaults managed-bookmarks with omitted constraints to read-only', () => {
      expect(resolve()(folder('managed-bookmarks'))).toEqual({
        readOnly: true,
        source: 'managed-bookmarks-default',
        reason: null,
      });
    });

    it('keeps explicit readOnly true and its reason', () => {
      expect(
        resolve()(folder('managed-bookmarks', { readOnly: true, reason: 'enterprise policy' })),
      ).toEqual({
        readOnly: true,
        source: 'explicit-constraint',
        reason: 'enterprise policy',
      });
    });

    it('honors the protocol-supported explicit readOnly false override', () => {
      expect(
        resolve()(folder('managed-bookmarks', { readOnly: false, reason: 'approved override' })),
      ).toEqual({
        readOnly: false,
        source: 'explicit-constraint',
        reason: 'approved override',
      });
    });

    it.each([
      ['root', () => root()],
      ['bookmarks-bar', () => folder('bookmarks-bar')],
      ['other-bookmarks', () => folder('other-bookmarks')],
      ['mobile-bookmarks', () => folder('mobile-bookmarks')],
      ['archive', () => folder('archive')],
      ['inbox', () => folder('inbox')],
      ['recovered', () => folder('recovered')],
      ['custom', () => folder('custom')],
      ['ordinary bookmark', () => bookmark()],
    ] as const)('leaves %s writable when constraints are omitted', (_label, makeNode) => {
      expect(resolve()(makeNode())).toEqual({ readOnly: false, source: 'none', reason: null });
    });

    it.each([
      ['an omitted reason', { readOnly: true }, null],
      ['a null reason', { readOnly: true, reason: null }, null],
      ['a string reason', { readOnly: true, reason: 'administrator lock' }, 'administrator lock'],
    ] as const)('normalizes %s', (_label, value, expectedReason) => {
      expect(resolve()(folder('managed-bookmarks', value))).toEqual({
        readOnly: true,
        source: 'explicit-constraint',
        reason: expectedReason,
      });
    });

    it('does not turn omission into false through truthiness or empty-default bugs', () => {
      const node = folder('managed-bookmarks');
      expect(Boolean(node.constraints?.readOnly)).toBe(false);
      expect(resolve()(node).readOnly).toBe(true);
      expect(resolve()(structuredClone(node)).readOnly).toBe(true);
    });
  });

  describe('malformed inputs fail closed', () => {
    it.each([
      ['missing readOnly', {}],
      ['null', null],
      ['falsey number', { readOnly: 0 }],
      ['truthy number', { readOnly: 1 }],
      ['string boolean', { readOnly: 'false' }],
      ['invalid reason', { readOnly: true, reason: 0 }],
      ['unknown member', { readOnly: true, inherited: true }],
    ] as const)('schema rejects malformed nodeConstraints: %s', (_label, value) => {
      expect(validators.validate('nodeConstraints', value).valid).toBe(false);
    });

    it.each([
      ['null constraints', null],
      ['array constraints', []],
      ['missing readOnly', {}],
      ['numeric readOnly', { readOnly: 0 }],
      ['string readOnly', { readOnly: 'false' }],
      ['numeric reason', { readOnly: true, reason: 0 }],
    ] as const)('resolver treats %s as read-only invalid constraints', (_label, malformed) => {
      const node = { ...folder('managed-bookmarks'), constraints: malformed } as unknown as StrictNode;
      expect(resolve()(node)).toEqual({
        readOnly: true,
        source: 'invalid-constraint',
        reason: 'Node constraints are malformed.',
      });
    });
  });

  describe('actual mutation decisions', () => {
    const managed = folder('managed-bookmarks');
    const ordinary = bookmark('ordinary-node');

    it.each([
      ['create-child', { kind: 'create-child', parent: managed }],
      ['update-node', { kind: 'update-node', node: managed }],
      ['move-node target parent', { kind: 'move-node', node: ordinary, targetParent: managed }],
      ['reorder-children', { kind: 'reorder-children', parent: managed }],
      ['delete-node', { kind: 'delete-node', node: managed }],
      ['delete-subtree', { kind: 'delete-subtree', node: managed }],
      ['restore-node parent', { kind: 'restore-node', node: ordinary, parent: managed }],
    ] as const)('denies %s at an omitted-constraints managed folder', async (_label, operation) => {
      await expect(evaluate()(operation, policyResolver([root(), managed, ordinary]))).resolves.toEqual({
        allowed: false,
        code: 'node_read_only',
        nodeId: managed.id,
        reason: defaultDenialReason,
        source: 'managed-bookmarks-default',
      });
    });

    it('allows mutation of an explicitly writable managed folder', async () => {
      const writable = folder('managed-bookmarks', { readOnly: false });
      await expect(
        evaluate()({ kind: 'update-node', node: writable }, policyResolver([root(), writable])),
      ).resolves.toEqual({ allowed: true });
    });

    it.each([
      'bookmarks-bar',
      'other-bookmarks',
      'mobile-bookmarks',
      'archive',
      'inbox',
      'recovered',
      'custom',
    ] as const)('leaves omitted-constraints %s folders writable at the mutation boundary', async (role) => {
      const node = folder(role);
      await expect(
        evaluate()({ kind: 'update-node', node }, policyResolver([root(), node])),
      ).resolves.toEqual({ allowed: true });
    });

    it('rejects a stale writable lookalike when authoritative state has the managed default', async () => {
      const stale = { ...managed, folderRole: 'custom' as const };
      await expect(
        evaluate()({ kind: 'update-node', node: stale }, policyResolver([root(), managed])),
      ).resolves.toEqual({
        allowed: false,
        code: 'node_read_only',
        nodeId: managed.id,
        reason: defaultDenialReason,
        source: 'managed-bookmarks-default',
      });
    });

    it('re-resolves a move source instead of trusting the mutation object', async () => {
      const staleSource = { ...managed, folderRole: 'custom' as const };
      const destination = folder('custom');
      await expect(
        evaluate()(
          { kind: 'move-node', node: staleSource, targetParent: destination },
          policyResolver([root(), managed, destination]),
        ),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_read_only',
        nodeId: managed.id,
        source: 'managed-bookmarks-default',
      });
    });

    it('re-resolves a move destination instead of trusting the mutation object', async () => {
      const staleDestination = { ...managed, folderRole: 'custom' as const };
      await expect(
        evaluate()(
          { kind: 'move-node', node: ordinary, targetParent: staleDestination },
          policyResolver([root(), managed, ordinary]),
        ),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_read_only',
        nodeId: managed.id,
        source: 'managed-bookmarks-default',
      });
    });

    it('denies mutation of a child through its managed ancestor', async () => {
      const child = bookmark('managed-child', managed.id);
      await expect(
        evaluate()({ kind: 'update-node', node: child }, policyResolver([root(), managed, child])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_read_only',
        nodeId: managed.id,
        source: 'managed-bookmarks-default',
      });
    });

    it('allows a child when its managed ancestor is explicitly writable', async () => {
      const writable = folder('managed-bookmarks', { readOnly: false });
      const child = bookmark('writable-managed-child', writable.id);
      await expect(
        evaluate()({ kind: 'update-node', node: child }, policyResolver([root(), writable, child])),
      ).resolves.toEqual({ allowed: true });
    });

    it('checks every descendant before deleting a subtree', async () => {
      const subtree = folder('custom');
      const protectedDescendant = folder('managed-bookmarks');
      const resolver = policyResolver(
        [root(), subtree, protectedDescendant],
        { [subtree.id]: [protectedDescendant] },
      );
      await expect(evaluate()({ kind: 'delete-subtree', node: subtree }, resolver)).resolves.toMatchObject({
        allowed: false,
        code: 'node_read_only',
        nodeId: protectedDescendant.id,
        source: 'managed-bookmarks-default',
      });
    });

    it('re-resolves subtree descendants instead of trusting returned objects', async () => {
      const subtree = folder('custom');
      const protectedDescendant = folder('managed-bookmarks');
      const staleDescendant = { ...protectedDescendant, folderRole: 'custom' as const };
      const resolver = policyResolver(
        [root(), subtree, protectedDescendant],
        { [subtree.id]: [staleDescendant] },
      );
      await expect(evaluate()({ kind: 'delete-subtree', node: subtree }, resolver)).resolves.toMatchObject({
        allowed: false,
        code: 'node_read_only',
        nodeId: protectedDescendant.id,
        source: 'managed-bookmarks-default',
      });
    });

    it('preserves an explicit read-only reason in the denial', async () => {
      const locked = folder('custom', { readOnly: true, reason: 'locked subtree' });
      await expect(
        evaluate()({ kind: 'update-node', node: locked }, policyResolver([root(), locked])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_read_only',
        nodeId: locked.id,
        reason: 'locked subtree',
        source: 'explicit-constraint',
      });
    });

    it('fails closed when authoritative ancestry is missing', async () => {
      const child = bookmark('orphan', 'missing-parent');
      await expect(
        evaluate()({ kind: 'update-node', node: child }, policyResolver([child])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: child.id,
      });
    });

    it('fails closed when the mutation participant is absent from authoritative state', async () => {
      await expect(
        evaluate()({ kind: 'update-node', node: managed }, policyResolver([root()])),
      ).resolves.toEqual({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: managed.id,
        reason: 'The complete authoritative node ancestry could not be resolved.',
      });
    });

    it('fails closed when the participant resolver returns a different Node', async () => {
      const resolver = policyResolver([root(), ordinary]);
      const mismatched = {
        ...resolver,
        async resolveNode() {
          return ordinary;
        },
      };
      await expect(evaluate()({ kind: 'update-node', node: managed }, mismatched)).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: managed.id,
      });
    });

    it('fails closed when an ancestor resolver returns a different Node', async () => {
      const child = bookmark('mismatched-ancestor-child', managed.id);
      const resolver = policyResolver([child, ordinary]);
      const mismatched = {
        ...resolver,
        async resolveNode(nodeId: string) {
          return nodeId === child.id ? child : ordinary;
        },
      };
      await expect(evaluate()({ kind: 'update-node', node: child }, mismatched)).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: child.id,
      });
    });

    it('fails closed when a target parent resolver returns a different Node', async () => {
      const rootNode = root();
      const resolver = policyResolver([rootNode, ordinary]);
      const mismatched = {
        ...resolver,
        async resolveNode(nodeId: string) {
          if (nodeId === managed.id) return ordinary;
          return resolver.resolveNode(nodeId);
        },
      };
      await expect(evaluate()(
        { kind: 'move-node', node: ordinary, targetParent: managed },
        mismatched,
      )).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: managed.id,
      });
    });

    it('fails closed when a descendant resolver returns a different Node', async () => {
      const subtree = folder('custom');
      const descendant = folder('archive');
      const resolver = policyResolver([root(), subtree, ordinary], { [subtree.id]: [descendant] });
      const mismatched = {
        ...resolver,
        async resolveNode(nodeId: string) {
          if (nodeId === descendant.id) return ordinary;
          return resolver.resolveNode(nodeId);
        },
      };
      await expect(evaluate()(
        { kind: 'delete-subtree', node: subtree },
        mismatched,
      )).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: descendant.id,
      });
    });

    it('fails closed on foreign-collection ancestry', async () => {
      const child = bookmark('foreign-child', 'foreign-parent');
      const foreignParent = {
        ...folder('custom'),
        id: 'foreign-parent',
        collectionId: 'another-collection',
      };
      await expect(
        evaluate()({ kind: 'update-node', node: child }, policyResolver([child, foreignParent])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: child.id,
      });
    });

    it('fails closed on a cross-collection move', async () => {
      const destination = {
        ...folder('custom'),
        id: 'foreign-destination',
        collectionId: 'another-collection',
      };
      await expect(
        evaluate()(
          { kind: 'move-node', node: ordinary, targetParent: destination },
          policyResolver([root(), ordinary, destination]),
        ),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: destination.id,
      });
    });

    it('fails closed on cyclic ancestry', async () => {
      const first = { ...folder('custom'), id: 'cycle-a', parentId: 'cycle-b' };
      const second = { ...folder('archive'), id: 'cycle-b', parentId: 'cycle-a' };
      await expect(
        evaluate()({ kind: 'update-node', node: first }, policyResolver([first, second])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'node_ancestry_unresolved',
        nodeId: first.id,
      });
    });

    it('fails closed when a mutation participant has malformed constraints', async () => {
      const malformed = { ...managed, constraints: {} } as unknown as StrictNode;
      await expect(
        evaluate()({ kind: 'update-node', node: malformed }, policyResolver([malformed])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'invalid_node_constraints',
        nodeId: malformed.id,
        source: 'invalid-constraint',
      });
    });

    it('fails closed when an ancestor has malformed constraints', async () => {
      const malformedParent = { ...folder('custom'), constraints: {} } as unknown as StrictNode;
      const child = bookmark('malformed-ancestor-child', malformedParent.id);
      await expect(
        evaluate()({ kind: 'update-node', node: child }, policyResolver([child, malformedParent])),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'invalid_node_constraints',
        nodeId: malformedParent.id,
        source: 'invalid-constraint',
      });
    });

    it('enforces maxDepth without an out-of-bound ancestry read', async () => {
      const rootNode = root();
      const parent = { ...folder('custom'), id: 'bounded-parent' };
      const child = bookmark('bounded-child', parent.id);
      const base = policyResolver([rootNode, parent, child]);
      const resolveNode = vi.fn(base.resolveNode);
      await expect(evaluate()(
        { kind: 'update-node', node: child },
        { ...base, resolveNode },
        { maxDepth: 1 },
      )).resolves.toMatchObject({ allowed: false, code: 'node_ancestry_unresolved' });
      expect(resolveNode.mock.calls.map(([nodeId]) => nodeId)).toEqual([child.id, parent.id]);

      await expect(evaluate()(
        { kind: 'update-node', node: child },
        policyResolver([rootNode, parent, child]),
        { maxDepth: 2 },
      )).resolves.toEqual({ allowed: true });
    });

    it('caches shared ancestors and stops a lazy descendant source at the budget', async () => {
      const rootNode = root();
      const subtree = { ...folder('custom'), id: 'cached-parent' };
      const children = Array.from({ length: 20 }, (_, index) => bookmark(`cached-${index}`, subtree.id));
      const base = policyResolver([rootNode, subtree, ...children]);
      const resolveNode = vi.fn(base.resolveNode);
      let emitted = 0;
      let closed = false;
      const resolveDescendants = async () => (async function* () {
        try { for (const node of children) { emitted += 1; yield node; } }
        finally { closed = true; }
      })();
      await expect(evaluate()({ kind: 'delete-subtree', node: subtree }, { resolveNode, resolveDescendants },
        { maxVisitedNodes: 5 })).resolves.toMatchObject({ allowed: false, code: 'node_ancestry_unresolved' });
      expect(emitted).toBeLessThanOrEqual(5);
      expect(closed).toBe(true);
      expect(resolveNode.mock.calls.filter(([id]) => id === rootNode.id)).toHaveLength(1);
      expect(resolveNode.mock.calls.filter(([id]) => id === subtree.id)).toHaveLength(1);
    });

    it('enforces maxVisitedNodes before the next resolver read', async () => {
      const rootNode = root();
      const parent = { ...folder('custom'), id: 'visited-parent' };
      const child = bookmark('visited-child', parent.id);
      const base = policyResolver([rootNode, parent, child]);
      const resolveNode = vi.fn(base.resolveNode);
      await expect(evaluate()(
        { kind: 'update-node', node: child },
        { ...base, resolveNode },
        { maxVisitedNodes: 2 },
      )).resolves.toMatchObject({ allowed: false, code: 'node_ancestry_unresolved' });
      expect(resolveNode.mock.calls.map(([nodeId]) => nodeId)).toEqual([child.id, parent.id]);
    });

    it('rejects an oversized descendant set before resolving any participant', async () => {
      const subtree = { ...folder('custom'), id: 'wide-subtree' };
      const descendants = [
        bookmark('wide-a', subtree.id),
        bookmark('wide-b', subtree.id),
      ];
      const base = policyResolver([root(), subtree, ...descendants], {
        [subtree.id]: descendants,
      });
      const resolveNode = vi.fn(base.resolveNode);
      await expect(evaluate()(
        { kind: 'delete-subtree', node: subtree },
        { ...base, resolveNode },
        { maxVisitedNodes: 2 },
      )).resolves.toMatchObject({ allowed: false, code: 'node_ancestry_unresolved' });
      expect(resolveNode).not.toHaveBeenCalled();
    });

    it.each([
      [{ maxDepth: 0 }, 'maxDepth'],
      [{ maxDepth: 4_097 }, 'maxDepth'],
      [{ maxVisitedNodes: 0 }, 'maxVisitedNodes'],
      [{ maxVisitedNodes: 100_001 }, 'maxVisitedNodes'],
    ] as const)('rejects invalid limits %j before resolver access', async (limits, name) => {
      const base = policyResolver([ordinary]);
      const resolveNode = vi.fn(base.resolveNode);
      await expect(evaluate()(
        { kind: 'update-node', node: ordinary },
        { ...base, resolveNode },
        limits,
      )).rejects.toThrow(name);
      expect(resolveNode).not.toHaveBeenCalled();
    });

    it('uses a registered stable HTTP problem for managed read-only denial', () => {
      expect(problemRegistry.node_read_only).toEqual({ status: 403, retryable: false });
    });
  });

  describe('immutability and determinism', () => {
    it('resolves deterministically without mutating the node', () => {
      const node = folder('managed-bookmarks');
      const before = structuredClone(node);
      expect(resolve()(node)).toEqual(resolve()(node));
      expect(node).toEqual(before);
    });

    it('evaluates deterministically without mutating operation or resolver nodes', async () => {
      const managed = folder('managed-bookmarks');
      const child = bookmark('deterministic-child', managed.id);
      const nodes = [root(), managed, child] as const;
      const operation = { kind: 'update-node', node: child } as const;
      const beforeNodes = structuredClone(nodes);
      const beforeOperation = structuredClone(operation);
      const resolver = policyResolver(nodes);

      expect(await evaluate()(operation, resolver)).toEqual(await evaluate()(operation, resolver));
      expect(nodes).toEqual(beforeNodes);
      expect(operation).toEqual(beforeOperation);
    });
  });

  describe('atomic policy and persistence boundary', () => {
    it('observes a concurrent move into a managed subtree before writing', async () => {
      const stale = bookmark('concurrent-child');
      const managed = folder('managed-bookmarks');
      const authoritative = { ...stale, parentId: managed.id } as StrictNode;
      const context = policyResolver([root(), managed, authoritative]);
      const unitOfWork = {
        run: <Result>(work: (value: typeof context) => Promise<Result>) => work(context),
      };
      const writer = vi.fn(async () => 'must-not-write');

      expect(NodeMutationPolicyError).toBeTypeOf('function');
      await expect(execute()(
        { kind: 'update-node', node: stale },
        unitOfWork,
        writer,
      )).rejects.toBeInstanceOf(NodeMutationPolicyError as MutationPolicyErrorConstructor);
      expect(writer).not.toHaveBeenCalled();
    });

    it('passes the exact transaction context and a frozen mutation to persistence', async () => {
      const writable = bookmark('atomic-writable');
      const context = policyResolver([root(), writable]);
      const unitOfWork = {
        run: <Result>(work: (value: typeof context) => Promise<Result>) => work(context),
      };
      const operation = { kind: 'update-node', node: writable } as NodeMutation;
      const writer = vi.fn(async (
        received: typeof context,
        checked: NodeMutation,
        policy: { readonly allowed: true },
      ) => {
        expect(received).toBe(context);
        expect(checked).toEqual(operation);
        expect(Object.isFrozen(checked)).toBe(true);
        expect(Object.isFrozen('node' in checked ? checked.node : checked)).toBe(true);
        expect(policy).toEqual({ allowed: true });
        expect(Object.isFrozen(policy)).toBe(true);
        return 'committed';
      });

      await expect(execute()(operation, unitOfWork, writer)).resolves.toBe('committed');
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it('propagates persistence failure so the unit of work can roll back', async () => {
      const writable = bookmark('rollback-writable');
      const resolver = policyResolver([root(), writable]);
      let committedTitle = writable.title;
      const unitOfWork: MutationUnitOfWork<typeof resolver> = {
        async run<Result>(work: (value: typeof resolver) => Promise<Result>): Promise<Result> {
          const before = committedTitle;
          try {
            return await work(resolver);
          } catch (error) {
            committedTitle = before;
            throw error;
          }
        },
      };
      const failure = new Error('transaction rollback');

      await expect(execute()(
        { kind: 'update-node', node: writable },
        unitOfWork,
        async () => {
          committedTitle = 'partial';
          throw failure;
        },
      )).rejects.toBe(failure);
      expect(committedTitle).toBe(writable.title);
    });

    it.each(['unit of work', 'writer'] as const)('rejects a non-Promise %s', async (boundary) => {
      const writable = bookmark('non-promise-writable');
      const context = policyResolver([root(), writable]);
      const unitOfWork = {
        run: boundary === 'unit of work'
          ? ((work: (value: typeof context) => Promise<unknown>) => (void work(context), 'invalid'))
          : ((work: (value: typeof context) => Promise<unknown>) => work(context)),
      } as unknown as MutationUnitOfWork<typeof context>;
      const writer = boundary === 'writer' ? (() => 'invalid') : async () => 'committed';
      await expect(execute()(
        { kind: 'update-node', node: writable },
        unitOfWork,
        writer as unknown as (received: typeof context) => Promise<string>,
      )).rejects.toThrow(/must return a Promise/u);
    });
  });
});
