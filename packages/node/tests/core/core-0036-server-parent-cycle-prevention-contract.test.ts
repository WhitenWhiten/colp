import { describe, expect, it, vi } from 'vitest';

import * as packageBoundary from '../../src/server/index.js';
import * as serverBoundary from '../../src/server/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';

const evidence = '[evidence:core.server-parent-cycle-prevention]';
const collectionId = 'collection-parent-cycle';

type Mutation =
  | Readonly<{ kind: 'create-node'; nodeId: string; collectionId: string; parentId: string | null }>
  | Readonly<{
      kind: 'reparent-node' | 'move-node' | 'restore-node';
      nodeId: string;
      parentId: string | null;
    }>;
type NodeIdentity = Readonly<{ id: string; collectionId: string; parentId: string | null }>;
type Resolver = Readonly<{
  resolveCollection(id: string): Promise<Readonly<{ id: string }> | undefined>;
  resolveNode(id: string): Promise<NodeIdentity | undefined>;
}>;
type DenialCode =
  | 'parent_cycle'
  | 'parent_ancestry_cycle'
  | 'parent_ancestry_unresolved'
  | 'parent_ancestry_malformed'
  | 'parent_collection_mismatch'
  | 'parent_ancestry_too_deep'
  | 'node_already_exists'
  | 'node_unresolved'
  | 'collection_unresolved';
type GuardResult =
  | Readonly<{ allowed: true; nodeId: string; parentId: string | null; collectionId: string }>
  | Readonly<{
      allowed: false;
      code: DenialCode;
      nodeId: string;
      parentId: string | null;
      collectionId?: string;
      atNodeId?: string;
      ancestry?: readonly string[];
      reason: string;
    }>;
type Evaluate = (
  mutation: Mutation,
  resolver: Resolver,
  options?: Readonly<{ maxDepth?: number }>,
) => Promise<GuardResult>;
type UnitOfWork<Context extends Resolver = Resolver> = Readonly<{
  run<Result>(work: (context: Context) => Promise<Result>): Promise<Result>;
}>;
type Execute = <Context extends Resolver, Result>(
  mutation: Mutation,
  unitOfWork: UnitOfWork<Context>,
  write: (
    context: Context,
    mutation: Mutation,
    guardResult: Extract<GuardResult, { allowed: true }>,
  ) => Promise<Result>,
  options?: Readonly<{ maxDepth?: number }>,
) => Promise<Result>;
type GuardErrorConstructor = new (denial: Extract<GuardResult, { allowed: false }>) => Error & {
  readonly denial: Extract<GuardResult, { allowed: false }>;
};
type Api = Readonly<{
  evaluateParentCycleGuard?: Evaluate;
  executeParentCycleGuardedWrite?: Execute;
  ParentCycleGuardError?: GuardErrorConstructor;
}>;

const evaluateParentCycleGuard = (serverBoundary as Api).evaluateParentCycleGuard;
const executeParentCycleGuardedWrite = (serverBoundary as Api).executeParentCycleGuardedWrite;
const ParentCycleGuardError = (serverBoundary as Api).ParentCycleGuardError;

function evaluate(): Evaluate {
  expect(evaluateParentCycleGuard, 'CORE-0036 needs a public server Parent Cycle guard').toBeTypeOf(
    'function',
  );
  return evaluateParentCycleGuard as Evaluate;
}

function execute(): Execute {
  expect(
    executeParentCycleGuardedWrite,
    'CORE-0036 needs a transaction-owning guarded write boundary',
  ).toBeTypeOf('function');
  return executeParentCycleGuardedWrite as Execute;
}

function node(id: string, parentId: string | null, ownCollectionId = collectionId): NodeIdentity {
  return { id, collectionId: ownCollectionId, parentId };
}

function resolver(
  nodes: readonly NodeIdentity[],
  collections: readonly string[] = [collectionId],
): Resolver & {
  resolveCollection: ReturnType<typeof vi.fn<Resolver['resolveCollection']>>;
  resolveNode: ReturnType<typeof vi.fn<Resolver['resolveNode']>>;
} {
  const byId = new Map(nodes.map((value) => [value.id, value]));
  const knownCollections = new Set(collections);
  return {
    resolveCollection: vi.fn(async (id) => (knownCollections.has(id) ? { id } : undefined)),
    resolveNode: vi.fn(async (id) => byId.get(id)),
  };
}

const existingMutations = ['move-node', 'reparent-node', 'restore-node'] as const;

describe(`CORE-0036 server Parent Cycle prevention contract ${evidence}`, () => {
  describe('public production contract', () => {
    it.each([
      ['evaluator', 'evaluateParentCycleGuard'],
      ['guarded write', 'executeParentCycleGuardedWrite'],
      ['typed denial error', 'ParentCycleGuardError'],
    ] as const)('exports the same %s from the server public entry', (_label, name) => {
      expect((serverBoundary as Api)[name]).toBeDefined();
      expect((packageBoundary as Api)[name]).toBe((serverBoundary as Api)[name]);
    });
  });

  describe('valid writes and boundaries', () => {
    it('allows create beneath an authoritative acyclic parent', async () => {
      const state = resolver([node('root', null), node('folder', 'root')]);
      await expect(
        evaluate()(
          { kind: 'create-node', nodeId: 'created', collectionId, parentId: 'folder' },
          state,
        ),
      ).resolves.toEqual({ allowed: true, nodeId: 'created', parentId: 'folder', collectionId });
    });

    it.each(existingMutations)('allows an acyclic %s', async (kind) => {
      const state = resolver([node('root', null), node('source', 'root'), node('target', 'root')]);
      await expect(evaluate()({ kind, nodeId: 'source', parentId: 'target' }, state)).resolves.toEqual({
        allowed: true,
        nodeId: 'source',
        parentId: 'target',
        collectionId,
      });
    });

    it.each([
      ['create', { kind: 'create-node', nodeId: 'created', collectionId, parentId: null }],
      ['existing', { kind: 'move-node', nodeId: 'source', parentId: null }],
    ] as const)('accepts the no-parent boundary for %s without ancestry traversal', async (_label, mutation) => {
      const state = resolver([node('source', 'root')]);
      await expect(evaluate()(mutation, state)).resolves.toMatchObject({ allowed: true, parentId: null });
      expect(state.resolveNode).toHaveBeenCalledTimes(1);
    });

    it('allows an unchanged parent edge', async () => {
      const state = resolver([node('root', null), node('source', 'folder'), node('folder', 'root')]);
      await expect(
        evaluate()({ kind: 'reparent-node', nodeId: 'source', parentId: 'folder' }, state),
      ).resolves.toMatchObject({ allowed: true, parentId: 'folder' });
    });

    it('uses authoritative resolver state instead of stale caller DTO ancestry', async () => {
      const state = resolver([
        node('root', null, 'authoritative-collection'),
        node('source', 'root', 'authoritative-collection'),
        node('target', 'root', 'authoritative-collection'),
      ], ['authoritative-collection']);
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'target' }, state),
      ).resolves.toEqual({
        allowed: true,
        nodeId: 'source',
        parentId: 'target',
        collectionId: 'authoritative-collection',
      });
    });
  });

  describe('cycle prevention', () => {
    it.each([
      ['create', { kind: 'create-node', nodeId: 'source', collectionId, parentId: 'source' }],
      ['move', { kind: 'move-node', nodeId: 'source', parentId: 'source' }],
      ['reparent', { kind: 'reparent-node', nodeId: 'source', parentId: 'source' }],
      ['restore', { kind: 'restore-node', nodeId: 'source', parentId: 'source' }],
    ] as const)('rejects a direct self-cycle on %s', async (_label, mutation) => {
      const state = resolver(mutation.kind === 'create-node' ? [] : [node('source', 'root')]);
      await expect(evaluate()(mutation, state)).resolves.toMatchObject({
        allowed: false,
        code: 'parent_cycle',
        nodeId: 'source',
        parentId: 'source',
        atNodeId: 'source',
        ancestry: ['source', 'source'],
      });
    });

    it.each([
      ['two-node descendant', [node('source', 'root'), node('child', 'source')], 'child'],
      [
        'multi-node descendant',
        [node('source', 'root'), node('child', 'source'), node('grandchild', 'child')],
        'grandchild',
      ],
    ] as const)('rejects a %s cycle', async (_label, nodes, parentId) => {
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId }, resolver(nodes)),
      ).resolves.toMatchObject({ allowed: false, code: 'parent_cycle', atNodeId: 'source' });
    });

    it('fails closed on an existing corrupt ancestry cycle unrelated to the proposed node', async () => {
      const state = resolver([
        node('source', 'root'),
        node('cycle-a', 'cycle-b'),
        node('cycle-b', 'cycle-a'),
      ]);
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'cycle-a' }, state),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'parent_ancestry_cycle',
        atNodeId: 'cycle-a',
        ancestry: ['cycle-a', 'cycle-b', 'cycle-a'],
      });
    });

    it('detects repeated authoritative IDs before resolving the same row again', async () => {
      const state = resolver([
        node('source', 'root'),
        node('repeat-a', 'repeat-b'),
        node('repeat-b', 'repeat-a'),
      ]);
      await evaluate()({ kind: 'restore-node', nodeId: 'source', parentId: 'repeat-a' }, state);
      expect(state.resolveNode.mock.calls.map(([id]) => id)).toEqual([
        'source',
        'repeat-a',
        'repeat-b',
      ]);
    });
  });

  describe('untrusted and incomplete resolver state', () => {
    it.each([
      ['missing existing node', { kind: 'move-node', nodeId: 'missing', parentId: 'root' }, 'node_unresolved'],
      [
        'create collision',
        { kind: 'create-node', nodeId: 'source', collectionId, parentId: 'root' },
        'node_already_exists',
      ],
      [
        'missing parent',
        { kind: 'move-node', nodeId: 'source', parentId: 'missing' },
        'parent_ancestry_unresolved',
      ],
    ] as const)('fails closed for %s', async (_label, mutation, code) => {
      const state = resolver([node('source', 'root'), node('root', null)]);
      await expect(evaluate()(mutation, state)).resolves.toMatchObject({ allowed: false, code });
    });

    it.each([
      ['create collection', { kind: 'create-node', nodeId: 'created', collectionId: 'missing', parentId: 'root' }],
      ['existing node collection', { kind: 'move-node', nodeId: 'source', parentId: 'root' }],
    ] as const)('fails closed when the %s is unresolved', async (_label, mutation) => {
      await expect(evaluate()(mutation, resolver([node('source', 'root')], []))).resolves.toMatchObject({
        allowed: false,
        code: 'collection_unresolved',
      });
    });

    it('rejects a foreign-collection parent', async () => {
      const state = resolver([node('source', 'root'), node('foreign', null, 'other-collection')]);
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'foreign' }, state),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'parent_collection_mismatch',
        atNodeId: 'foreign',
      });
    });

    it.each([
      ['empty mutation node ID', { kind: 'move-node', nodeId: '', parentId: 'root' }],
      ['empty mutation parent ID', { kind: 'move-node', nodeId: 'source', parentId: '' }],
      ['empty create collection ID', { kind: 'create-node', nodeId: 'created', collectionId: '', parentId: 'root' }],
      ['reserved character in node ID', { kind: 'move-node', nodeId: 'source/id', parentId: 'root' }],
      ['whitespace in parent ID', { kind: 'move-node', nodeId: 'source', parentId: 'not valid' }],
      ['oversized collection ID', { kind: 'create-node', nodeId: 'created', collectionId: 'x'.repeat(129), parentId: 'root' }],
    ] as const)('rejects a malformed %s before resolver access', async (_label, mutation) => {
      const state = resolver([]);
      await expect(evaluate()(mutation, state)).resolves.toMatchObject({
        allowed: false,
        code: 'parent_ancestry_malformed',
      });
      expect(state.resolveCollection).not.toHaveBeenCalled();
      expect(state.resolveNode).not.toHaveBeenCalled();
    });

    it.each([
      ['wrong returned ID', { id: 'impostor', collectionId, parentId: null }],
      ['empty collection ID', { id: 'parent', collectionId: '', parentId: null }],
      ['malformed parent ID', { id: 'parent', collectionId, parentId: 7 }],
    ] as const)('rejects a resolver node with %s', async (_label, malformed) => {
      const state = resolver([node('source', 'root')]);
      state.resolveNode.mockImplementation(async (id) =>
        id === 'source' ? node('source', 'root') : (malformed as unknown as NodeIdentity),
      );
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'parent' }, state),
      ).resolves.toMatchObject({ allowed: false, code: 'parent_ancestry_malformed' });
    });

    it('propagates a resolver rejection unchanged and never continues traversal', async () => {
      const failure = new Error('transaction read failed');
      const state = resolver([node('source', 'root')]);
      state.resolveNode.mockImplementationOnce(async () => node('source', 'root'));
      state.resolveNode.mockImplementationOnce(async () => {
        throw failure;
      });
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'target' }, state),
      ).rejects.toBe(failure);
      expect(state.resolveNode).toHaveBeenCalledTimes(2);
    });

    it.each(['resolveCollection', 'resolveNode'] as const)(
      'rejects a non-Promise %s adapter result',
      async (method) => {
        const state = resolver([node('source', 'root')]);
        Object.assign(state, {
          [method]: vi.fn(() => (method === 'resolveCollection' ? { id: collectionId } : node('source', 'root'))),
        });
        const mutation: Mutation =
          method === 'resolveCollection'
            ? { kind: 'create-node', nodeId: 'created', collectionId, parentId: null }
            : { kind: 'move-node', nodeId: 'source', parentId: null };
        await expect(evaluate()(mutation, state)).rejects.toThrow(TypeError);
      },
    );
  });

  describe('bounded iterative traversal and immutability', () => {
    it('handles a deep valid chain without recursive stack exhaustion', async () => {
      const depth = 4_000;
      const nodes = [node('source', 'root'), node('root', null)];
      for (let index = 0; index < depth; index += 1) {
        nodes.push(node(`deep-${index}`, index === depth - 1 ? 'root' : `deep-${index + 1}`));
      }
      await expect(
        evaluate()(
          { kind: 'move-node', nodeId: 'source', parentId: 'deep-0' },
          resolver(nodes),
          { maxDepth: depth + 1 },
        ),
      ).resolves.toMatchObject({ allowed: true });
    });

    it('enforces the exact traversal bound without an out-of-bound resolver read', async () => {
      const state = resolver([
        node('source', 'root'),
        node('first', 'second'),
        node('second', 'third'),
        node('third', null),
      ]);
      await expect(
        evaluate()(
          { kind: 'move-node', nodeId: 'source', parentId: 'first' },
          state,
          { maxDepth: 2 },
        ),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'parent_ancestry_too_deep',
        atNodeId: 'third',
      });
      expect(state.resolveNode.mock.calls.map(([id]) => id)).toEqual(['source', 'first', 'second']);
    });

    it('uses one collection read, one source read, and one read per visited ancestor', async () => {
      const state = resolver([node('source', 'root'), node('first', 'root'), node('root', null)]);
      await evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'first' }, state);
      expect(state.resolveCollection).toHaveBeenCalledExactlyOnceWith(collectionId);
      expect(state.resolveNode.mock.calls.map(([id]) => id)).toEqual(['source', 'first', 'root']);
    });

    it.each([0, -1, 1.5, 4_097, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid maxDepth %s before resolver access',
      async (maxDepth) => {
        const state = resolver([]);
        await expect(
          evaluate()(
            { kind: 'create-node', nodeId: 'created', collectionId, parentId: null },
            state,
            { maxDepth },
          ),
        ).rejects.toThrow(RangeError);
        expect(state.resolveCollection).not.toHaveBeenCalled();
        expect(state.resolveNode).not.toHaveBeenCalled();
      },
    );

    it('does not mutate the mutation or authoritative resolver rows', async () => {
      const mutation = Object.freeze({ kind: 'move-node', nodeId: 'source', parentId: 'folder' } as const);
      const rows = Object.freeze([
        Object.freeze(node('source', 'root')),
        Object.freeze(node('folder', 'root')),
        Object.freeze(node('root', null)),
      ]);
      const beforeMutation = structuredClone(mutation);
      const beforeRows = structuredClone(rows);
      await evaluate()(mutation, resolver(rows));
      expect(mutation).toEqual(beforeMutation);
      expect(rows).toEqual(beforeRows);
    });

    it('returns immutable denial metadata detached from caller input', async () => {
      const mutation = { kind: 'move-node', nodeId: 'source', parentId: 'child' } as const;
      const result = await evaluate()(mutation, resolver([node('source', 'root'), node('child', 'source')]));
      expect(result).toMatchObject({ allowed: false, code: 'parent_cycle' });
      expect(Object.isFrozen(result)).toBe(true);
      if (!result.allowed && result.ancestry !== undefined) expect(Object.isFrozen(result.ancestry)).toBe(true);
      expect(mutation).toEqual({ kind: 'move-node', nodeId: 'source', parentId: 'child' });
    });

    it('returns immutable allowed metadata', async () => {
      const result = await evaluate()(
        { kind: 'move-node', nodeId: 'source', parentId: 'root' },
        resolver([node('source', 'root'), node('root', null)]),
      );
      expect(result).toEqual({ allowed: true, nodeId: 'source', parentId: 'root', collectionId });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  describe('transaction and TOCTOU boundary', () => {
    it('runs authoritative reads and the write once in the identical transaction context', async () => {
      const events: string[] = [];
      const context = resolver([node('source', 'root'), node('target', 'root'), node('root', null)]);
      const resolveNode = context.resolveNode;
      context.resolveNode.mockImplementation(async (id) => {
        events.push(`read:${id}`);
        return resolveNode.getMockImplementation() === undefined ? undefined : undefined;
      });
      const rows = new Map([
        ['source', node('source', 'root')],
        ['target', node('target', 'root')],
        ['root', node('root', null)],
      ]);
      context.resolveNode.mockImplementation(async (id) => {
        events.push(`read:${id}`);
        return rows.get(id);
      });
      const run = vi.fn(async (work: (value: typeof context) => Promise<string>) => work(context));
      const unitOfWork = { run } as unknown as UnitOfWork<typeof context>;
      const write = vi.fn(async (
        received: typeof context,
        checkedMutation: Mutation,
        guardResult: Extract<GuardResult, { allowed: true }>,
      ) => {
        events.push('write');
        expect(received).toBe(context);
        expect(checkedMutation).toEqual({ kind: 'move-node', nodeId: 'source', parentId: 'target' });
        expect(Object.isFrozen(checkedMutation)).toBe(true);
        expect(guardResult).toEqual({
          allowed: true,
          nodeId: 'source',
          parentId: 'target',
          collectionId,
        });
        expect(Object.isFrozen(guardResult)).toBe(true);
        return 'committed';
      });
      await expect(
        execute()({ kind: 'move-node', nodeId: 'source', parentId: 'target' }, unitOfWork, write),
      ).resolves.toBe('committed');
      expect(run).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['read:source', 'read:target', 'read:root', 'write']);
    });

    it('persists the exact snapshotted proposal even when caller input and options mutate', async () => {
      const context = resolver([node('source', 'root'), node('target', 'root'), node('root', null)]);
      const unitOfWork = {
        run: async <Result>(work: (value: typeof context) => Promise<Result>) => work(context),
      };
      const mutation = { kind: 'move-node', nodeId: 'source', parentId: 'target' } as Mutation;
      const options = { maxDepth: 10 };
      const writer = vi.fn(async (_context: typeof context, checkedMutation: Mutation) => checkedMutation);

      const pending = execute()(mutation, unitOfWork, writer, options);
      (mutation as { parentId: string | null }).parentId = 'source';
      options.maxDepth = 0;

      await expect(pending).resolves.toEqual({ kind: 'move-node', nodeId: 'source', parentId: 'target' });
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it('throws a typed denial inside the unit of work and never invokes persistence', async () => {
      const context = resolver([node('source', 'root'), node('child', 'source')]);
      const run = vi.fn(async (work: (value: typeof context) => Promise<unknown>) => work(context));
      const unitOfWork = { run } as unknown as UnitOfWork<typeof context>;
      const write = vi.fn(async () => 'must-not-write');
      const promise = execute()(
        { kind: 'move-node', nodeId: 'source', parentId: 'child' },
        unitOfWork,
        write,
      );
      expect(ParentCycleGuardError).toBeTypeOf('function');
      await expect(promise).rejects.toBeInstanceOf(ParentCycleGuardError as GuardErrorConstructor);
      await expect(promise).rejects.toMatchObject({ denial: { code: 'parent_cycle' } });
      expect(write).not.toHaveBeenCalled();
    });

    it('propagates write failure unchanged after successful guarding', async () => {
      const failure = new Error('write rolled back');
      const context = resolver([node('source', 'root'), node('root', null)]);
      const unitOfWork = { run: <Result>(work: (value: typeof context) => Promise<Result>) => work(context) };
      await expect(
        execute()(
          { kind: 'move-node', nodeId: 'source', parentId: 'root' },
          unitOfWork,
          async () => {
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
    });

    it.each(['unit of work', 'writer'] as const)('rejects a non-Promise %s result', async (boundary) => {
      const context = resolver([node('source', 'root'), node('root', null)]);
      const unitOfWork = {
        run: boundary === 'unit of work'
          ? vi.fn((work: (value: typeof context) => Promise<unknown>) => (
              void work(context), 'not-a-promise'
            ))
          : vi.fn((work: (value: typeof context) => Promise<unknown>) => work(context)),
      } as unknown as UnitOfWork<typeof context>;
      const writer = boundary === 'writer'
        ? (() => 'not-a-promise')
        : async () => 'persisted';
      await expect(
        execute()(
          { kind: 'move-node', nodeId: 'source', parentId: 'root' },
          unitOfWork,
          writer as unknown as (value: typeof context) => Promise<string>,
        ),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('semantic and mutation-policy non-regression', () => {
    it('keeps complete Snapshot Parent Cycles reported as parent_cycle', () => {
      const timestamp = '2026-07-17T06:00:00Z';
      const base = { collectionId, createdAt: timestamp, updatedAt: timestamp, revision: 'r1' };
      const root = {
        ...base,
        id: 'root',
        kind: 'root',
        parentId: null,
        position: null,
        folderRole: 'root',
        title: 'Root',
      } satisfies StrictNode;
      const cyclic = {
        ...base,
        id: 'cyclic',
        kind: 'folder',
        parentId: 'cyclic',
        position: 'A',
        title: 'Cyclic',
      } satisfies StrictNode;
      const snapshot = {
        snapshotId: 'snapshot',
        mode: 'publication',
        complete: true,
        revision: 'r1',
        generatedAt: timestamp,
        page: { nextCursor: null, hasMore: false, sequence: 1 },
        collection: {
          id: collectionId,
          title: 'Collection',
          description: '',
          rootNodeId: 'root',
          visibility: 'private',
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 'r1',
        },
        nodes: [root, cyclic],
        annotations: [],
        attachments: [],
        relations: [],
        tombstones: [],
        warnings: [],
      } as unknown as Snapshot;
      expect(validateSnapshotSemantics(snapshot).issues).toContainEqual(
        expect.objectContaining({ code: 'parent_cycle', path: '/nodes/1/parentId' }),
      );
    });

    it('does not replace the existing node mutation policy with the cycle-only guard', async () => {
      const evaluatePolicy = packageBoundary.evaluateNodeMutationPolicy;
      expect(evaluatePolicy).toBeTypeOf('function');
      expect(evaluate()).not.toBe(evaluatePolicy);
      const state = resolver([node('source', 'root'), node('root', null)]);
      await expect(
        evaluate()({ kind: 'move-node', nodeId: 'source', parentId: 'root' }, state),
      ).resolves.toMatchObject({ allowed: true });
    });
  });
});
