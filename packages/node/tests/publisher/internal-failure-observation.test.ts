import { describe, expect, it } from 'vitest';

import {
  executePublisherGuardedNodeWrite,
  executePublisherNodeDelete,
  executePublisherNodeMove,
  executePublisherOrdinaryNodeCreate,
  type PublisherGuardedNodeWritePorts,
  type PublisherGuardedNodeWriteResult,
  type PublisherInternalFailureObservation,
  type PublisherInternalFailureObserver,
  type PublisherInternalFailureOperation,
} from '../../src/publisher/index.js';
import {
  problemRegistry,
  type GuardedNodeWriteMutation,
  type NodeWriteResolver,
} from '../../src/server/index.js';
import type { StrictNode } from '../../src/types/index.js';

type Candidate = {
  readonly principal: string;
  readonly body: { readonly title: string };
};

type Value = { readonly title: string; readonly nodeId: string };
type GuardedResult = PublisherGuardedNodeWriteResult<Value>;
type GuardedPorts = PublisherGuardedNodeWritePorts<NodeWriteResolver, Candidate, Value>;

const evidence = 'http.problems';
const timestamp = '2026-07-19T00:00:00Z';
const collection = Object.freeze({
  id: 'collection-internal-failure',
  rootNodeId: 'root-internal-failure',
});
const secretMarker = 'SECRET_INTERNAL_CAUSE_TOKEN_do-not-leak';

const rejected = (code: keyof typeof problemRegistry) => ({
  state: 'rejected' as const,
  code,
  ...problemRegistry[code],
});

function root(): Extract<StrictNode, { readonly kind: 'root' }> {
  return {
    id: collection.rootNodeId,
    collectionId: collection.id,
    kind: 'root',
    parentId: null,
    position: null,
    folderRole: 'root',
    title: 'Root',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'revision-root',
  };
}

function bookmark(id: string): Extract<StrictNode, { readonly kind: 'bookmark' }> {
  return {
    id,
    collectionId: collection.id,
    kind: 'bookmark',
    parentId: collection.rootNodeId,
    position: id,
    title: id,
    url: 'https://example.test/',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `revision-${id}`,
  };
}

function resolver(nodes: readonly StrictNode[]): NodeWriteResolver {
  const rows = new Map(nodes.map((node) => [node.id, node]));
  return {
    async resolveCollection(id) {
      return id === collection.id ? collection : undefined;
    },
    async resolveNode(id) {
      return rows.get(id);
    },
    async resolveChildren(parentId, limit) {
      const children = nodes.filter((node) => node.parentId === parentId);
      return { nodes: children.slice(0, limit), hasMore: children.length > limit };
    },
  };
}

function makeGuardedPorts(
  context: NodeWriteResolver,
  change: Partial<GuardedPorts> = {},
): GuardedPorts {
  return {
    unitOfWork: { async run(work) { return work(context); } },
    authenticate: async () => ({
      authenticated: true,
      identityResolution: {
        status: 'authenticated',
        identities: [{ type: 'user', id: 'publisher-alice' }],
      },
    }),
    authorize: async () => ({ authorized: true }),
    conceal: async (_context, _identities, _candidate, _mutation, input) => (
      input.authorized
        ? { allowed: true }
        : { allowed: false, problem: 'insufficient_scope' }
    ),
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    write: async (_context, candidate, plan) => ({
      result: { title: candidate.body.title, nodeId: plan.modifiedNodeIds[0]! },
      modifiedNodeIds: plan.modifiedNodeIds,
      deletedNodeIds: plan.deletedNodeIds,
      deletedNodeCount: plan.deletedNodeCount,
    }),
    ...change,
  };
}

function runGuarded(
  options: {
    readonly candidate?: Candidate;
    readonly mutation?: GuardedNodeWriteMutation;
    readonly context?: NodeWriteResolver;
    readonly ports?: Partial<GuardedPorts>;
  } = {},
): Promise<GuardedResult> {
  const nodes = [root(), bookmark('target')];
  const context = options.context ?? resolver(nodes);
  return executePublisherGuardedNodeWrite(
    options.candidate ?? { principal: 'publisher-key:alice', body: { title: 'Updated' } },
    options.mutation ?? { kind: 'update-node', nodeId: 'target' },
    makeGuardedPorts(context, options.ports),
  );
}

function recordObserver(): {
  readonly observations: PublisherInternalFailureObservation[];
  readonly onInternalFailure: PublisherInternalFailureObserver;
} {
  const observations: PublisherInternalFailureObservation[] = [];
  return {
    observations,
    onInternalFailure(observation) {
      observations.push(observation);
    },
  };
}

function expectGenericInternalError(result: { readonly state: string; readonly code?: string }): void {
  expect(result).toEqual(rejected('internal_error'));
  const wire = JSON.stringify(result);
  expect(wire).not.toMatch(new RegExp(secretMarker, 'u'));
  expect(wire).not.toMatch(/cause/iu);
}

function assertObservation(
  observation: PublisherInternalFailureObservation,
  operation: PublisherInternalFailureOperation,
  cause: unknown,
): void {
  expect(Object.isFrozen(observation)).toBe(true);
  expect(observation).toMatchObject({ operation, code: 'internal_error' });
  if (cause instanceof Error && observation.cause instanceof Error) {
    // Prefer identity; fall back to message when a boundary re-wraps.
    if (observation.cause !== cause) {
      expect(observation.cause.message).toBe(cause.message);
    } else {
      expect(observation.cause).toBe(cause);
    }
  } else {
    expect(observation.cause).toBe(cause);
  }
}

/** Minimal host ports body; only onInternalFailure is exercised for outer-catch paths. */
function outerCatchPorts(onInternalFailure: PublisherInternalFailureObserver): never {
  return {
    onInternalFailure,
    unitOfWork: {
      async run(work: (ctx: never) => Promise<unknown>) {
        return work(null as never);
      },
    },
    application: {
      applyOperations: async () => {
        throw new Error('unreachable application');
      },
    },
    authenticate: async () => ({ authenticated: false }),
    authorize: async () => ({ authorized: true }),
    authorizeRequiredScope: async () => ({ authorized: true }),
    conceal: async () => ({ allowed: true }),
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
  } as never;
}

function nodeDeleteOuterCatchRequest(): never {
  return {
    ifMatch: '"revision-folder-target"',
    query: { recursive: false },
    operation: {
      operationId: 'operation-internal-failure-delete',
      replicaId: 'publisher-server',
      sequence: 1,
      occurredAt: timestamp,
      collectionId: collection.id,
      action: 'delete',
      targetId: 'folder-target',
      baseRevision: 'revision-folder-target',
      payload: { reason: 'publisher-delete' },
    },
  } as never;
}

function hostileObserverReadPorts(ports: object): {
  readonly ports: never;
  readonly observerReads: () => number;
} {
  let reads = 0;
  return {
    ports: new Proxy(ports, {
      get(target, property, receiver) {
        if (property === 'onInternalFailure') {
          reads += 1;
          throw new Error(`${secretMarker}:observer-read`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as never,
    observerReads: () => reads,
  };
}

describe(`Publisher opt-in internal failure observation [review:${evidence}]`, () => {
  describe('executePublisherGuardedNodeWrite (operation: guarded-node-write)', () => {
    it(`returns rejected internal_error without a hook [review:${evidence}]`, async () => {
      const cause = new Error(secretMarker);
      const result = await runGuarded({
        ports: {
          validate: async () => {
            throw cause;
          },
        },
      });
      expectGenericInternalError(result);
    });

    it(`invokes onInternalFailure once with frozen observation and same cause [review:${evidence}]`, async () => {
      const cause = new Error(secretMarker);
      const { observations, onInternalFailure } = recordObserver();
      const result = await runGuarded({
        ports: {
          validate: async () => {
            throw cause;
          },
          onInternalFailure,
        },
      });

      expectGenericInternalError(result);
      expect(observations).toHaveLength(1);
      assertObservation(observations[0]!, 'guarded-node-write', cause);
    });

    it(`invokes onInternalFailure when unitOfWork rejects unexpectedly [review:${evidence}]`, async () => {
      const cause = new Error(`${secretMarker}:unitOfWork`);
      const { observations, onInternalFailure } = recordObserver();
      const result = await runGuarded({
        ports: {
          unitOfWork: {
            async run() {
              throw cause;
            },
          },
          onInternalFailure,
        },
      });

      expectGenericInternalError(result);
      expect(observations).toHaveLength(1);
      assertObservation(observations[0]!, 'guarded-node-write', cause);
    });

    it(`still returns internal_error when the observer throws [review:${evidence}]`, async () => {
      const cause = new Error(secretMarker);
      const result = await runGuarded({
        ports: {
          write: async () => {
            throw cause;
          },
          onInternalFailure: () => {
            throw new Error(`${secretMarker}:observer-sync-throw`);
          },
        },
      });
      expectGenericInternalError(result);
      expect(JSON.stringify(result)).not.toMatch(/observer-sync-throw/u);
    });

    it(`still returns internal_error when the observer rejects asynchronously [review:${evidence}]`, async () => {
      const cause = new Error(secretMarker);
      const result = await runGuarded({
        ports: {
          validate: async () => {
            throw cause;
          },
          onInternalFailure: async () => {
            throw new Error(`${secretMarker}:observer-async-reject`);
          },
        },
      });
      expectGenericInternalError(result);
      expect(JSON.stringify(result)).not.toMatch(/observer-async-reject/u);
    });

    it(`does not invoke onInternalFailure for expected authentication rejection [review:${evidence}]`, async () => {
      const { observations, onInternalFailure } = recordObserver();
      const result = await runGuarded({
        ports: {
          authenticate: async () => ({ authenticated: false }),
          onInternalFailure,
        },
      });
      expect(result).toEqual(rejected('authentication_required'));
      expect(observations).toHaveLength(0);
    });

    it(`does not invoke onInternalFailure for expected authorization concealment [review:${evidence}]`, async () => {
      const { observations, onInternalFailure } = recordObserver();
      const result = await runGuarded({
        ports: {
          authorize: async () => ({ authorized: false, reason: 'no-scope' }),
          conceal: async () => ({ allowed: false, problem: 'insufficient_scope' }),
          onInternalFailure,
        },
      });
      expect(result).toEqual(rejected('insufficient_scope'));
      expect(observations).toHaveLength(0);
    });
  });

  describe('coordinator outer catches (operation strings)', () => {
    it(`ordinary Node create outer catch observes ordinary-node-create [review:${evidence}]`, async () => {
      const { observations, onInternalFailure } = recordObserver();
      // Invalid envelope fails snapshotRequest before guarded write; outer catch maps to internal_error.
      const result = await executePublisherOrdinaryNodeCreate(
        { nodeId: '!!!not-an-opaque-id!!!', operation: { action: 'create' } } as never,
        outerCatchPorts(onInternalFailure),
      );

      expectGenericInternalError(result);
      expect(observations).toHaveLength(1);
      expect(Object.isFrozen(observations[0])).toBe(true);
      expect(observations[0]).toMatchObject({
        operation: 'ordinary-node-create',
        code: 'internal_error',
      });
      expect(observations[0]!.cause).toBeDefined();
      expect(JSON.stringify(result)).not.toMatch(/not-an-opaque-id/u);
    });

    it(`Node move outer catch observes node-move [review:${evidence}]`, async () => {
      const { observations, onInternalFailure } = recordObserver();
      const result = await executePublisherNodeMove(
        { operation: { action: 'move' } } as never,
        outerCatchPorts(onInternalFailure),
      );

      expectGenericInternalError(result);
      expect(observations).toHaveLength(1);
      expect(Object.isFrozen(observations[0])).toBe(true);
      expect(observations[0]).toMatchObject({
        operation: 'node-move',
        code: 'internal_error',
      });
      expect(observations[0]!.cause).toBeDefined();
    });

    it(`Node delete snapshotRequest invalid_document path does not observe [review:${evidence}]`, async () => {
      const { observations, onInternalFailure } = recordObserver();
      const result = await executePublisherNodeDelete(
        { operation: { action: 'delete' }, query: {} } as never,
        outerCatchPorts(onInternalFailure),
      );

      expect(result).toEqual(rejected('invalid_document'));
      expect(observations).toHaveLength(0);
    });

    it(`Node delete unexpected outer failure observes node-delete [review:${evidence}]`, async () => {
      const { observations, onInternalFailure } = recordObserver();
      // Proxy ports pass the request snapshot gate then fail closed in snapshotPorts.
      const hostilePorts = new Proxy({ onInternalFailure }, {});

      const result = await executePublisherNodeDelete(
        nodeDeleteOuterCatchRequest(),
        hostilePorts as never,
      );

      expectGenericInternalError(result);
      expect(observations).toHaveLength(1);
      expect(Object.isFrozen(observations[0])).toBe(true);
      expect(observations[0]).toMatchObject({
        operation: 'node-delete',
        code: 'internal_error',
      });
      expect(observations[0]!.cause).toBeDefined();
    });

    it.each([
      {
        name: 'guarded Node write',
        run: (ports: never) => executePublisherGuardedNodeWrite(
          { principal: 'publisher-key:alice', body: { title: 'Updated' } },
          { kind: 'update-node', nodeId: 'target' },
          ports,
        ),
        ports: () => makeGuardedPorts(resolver([root(), bookmark('target')]), {
          validate: async () => { throw new Error(`${secretMarker}:validation`); },
        }),
      },
      {
        name: 'ordinary Node create',
        run: (ports: never) => executePublisherOrdinaryNodeCreate(
          { nodeId: '!!!not-an-opaque-id!!!', operation: { action: 'create' } } as never,
          ports,
        ),
        ports: () => outerCatchPorts(() => undefined),
      },
      {
        name: 'Node move',
        run: (ports: never) => executePublisherNodeMove(
          { operation: { action: 'move' } } as never,
          ports,
        ),
        ports: () => outerCatchPorts(() => undefined),
      },
      {
        name: 'Node delete',
        run: (ports: never) => executePublisherNodeDelete(nodeDeleteOuterCatchRequest(), ports),
        ports: () => outerCatchPorts(() => undefined),
      },
    ])(
      `keeps internal_error when $name observer property read throws [review:${evidence}]`,
      async ({ run, ports }) => {
        const hostile = hostileObserverReadPorts(ports());
        const result = await run(hostile.ports);

        expectGenericInternalError(result);
        expect(hostile.observerReads()).toBe(1);
        expect(JSON.stringify(result)).not.toContain('observer-read');
      },
    );
  });
});
