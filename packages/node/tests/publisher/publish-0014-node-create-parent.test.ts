import { describe, expect, it, vi } from 'vitest';

import {
  executePublisherOrdinaryNodeCreate,
  mapPublisherNodeOperation,
  type PublisherGuardedNodeWriteResult,
  type PublisherNodeOperationRequest,
  type PublisherOrdinaryNodeCreatePorts,
  type PublisherOrdinaryNodeCreateRequest,
  type PublisherOrdinaryNodeCreateTransaction,
  type ServerIdResourceType,
} from '../../src/publisher/index.js';
import {
  problemRegistry,
} from '../../src/server/index.js';
import type {
  CreateNodeOperationPayload,
  Operation,
  OperationResult,
  StrictNode,
} from '../../src/types/index.js';

const collectionId = 'collection-publish-0014';
const rootId = 'root-publish-0014';
const nodeId = 'node-publish-0014';
const instant = '2026-07-19T12:00:00Z';

type Candidate = PublisherOrdinaryNodeCreateRequest;
type Result = PublisherGuardedNodeWriteResult<StrictNode>;
type Context = PublisherOrdinaryNodeCreateTransaction & { readonly draft: State };
type Ports = PublisherOrdinaryNodeCreatePorts<Context>;

interface State {
  readonly collections: Map<string, { readonly id: string; readonly rootNodeId: string }>;
  readonly nodes: Map<string, StrictNode>;
  readonly reservations: Map<string, ServerIdResourceType>;
  readonly operations: Operation[];
}

function root(
  id = rootId,
  owner = collectionId,
  constraints?: StrictNode['constraints'],
): Extract<StrictNode, { readonly kind: 'root' }> {
  return {
    id,
    collectionId: owner,
    kind: 'root',
    parentId: null,
    position: null,
    folderRole: 'root',
    title: 'Root',
    createdAt: instant,
    updatedAt: instant,
    revision: `revision-${id}`,
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function folder(id = 'folder-publish-0014', owner = collectionId): Extract<StrictNode, { readonly kind: 'folder' }> {
  return {
    id,
    collectionId: owner,
    kind: 'folder',
    parentId: owner === collectionId ? rootId : 'other-root',
    position: `position-${id}`,
    folderRole: 'custom',
    title: 'Folder',
    createdAt: instant,
    updatedAt: instant,
    revision: `revision-${id}`,
  };
}

function leaf(
  kind: 'bookmark' | 'separator' | 'alias',
  id = `${kind}-parent`,
): StrictNode {
  const common = {
    id,
    collectionId,
    parentId: rootId,
    position: `position-${id}`,
    createdAt: instant,
    updatedAt: instant,
    revision: `revision-${id}`,
  } as const;
  if (kind === 'bookmark') return { ...common, kind, title: 'Bookmark', url: 'https://example.test/' };
  if (kind === 'alias') return { ...common, kind, title: 'Alias', targetNodeId: rootId };
  return { ...common, kind };
}

function emptyState(nodes: readonly StrictNode[] = [root()]): State {
  return {
    collections: new Map([[collectionId, { id: collectionId, rootNodeId: rootId }]]),
    nodes: new Map(nodes.map((node) => [node.id, structuredClone(node)])),
    reservations: new Map(nodes.map((node) => [node.id, 'node' as const])),
    operations: [],
  };
}

function cloneState(state: State): State {
  return {
    collections: new Map(state.collections),
    nodes: new Map([...state.nodes].map(([id, node]) => [id, structuredClone(node)])),
    reservations: new Map(state.reservations),
    operations: structuredClone(state.operations),
  };
}

function payload(parentId: string = rootId): CreateNodeOperationPayload {
  return {
    parentId,
    afterId: null,
    beforeId: null,
    node: {
      kind: 'bookmark',
      title: 'Created bookmark',
      url: 'https://example.test/created',
      tags: [],
      extensions: {},
    },
  };
}

function candidate(createPayload: CreateNodeOperationPayload = payload(), id = nodeId): Candidate {
  return {
    nodeId: id,
    operation: {
      operationId: 'operation-publish-0014',
      replicaId: 'publisher-server',
      sequence: 14,
      occurredAt: instant,
      collectionId,
      action: 'create',
      baseRevision: null,
      payload: createPayload,
    },
  };
}

function operationRequest(value: Candidate = candidate()): PublisherNodeOperationRequest {
  return value.operation;
}

class AtomicNodeCreateAdapter {
  private state: State;
  private tail: Promise<void> = Promise.resolve();
  commit: 'known' | 'unknown-before' | 'unknown-after' = 'known';
  failWrite = false;
  runCalls = 0;
  readonly contexts: Context[] = [];
  readonly selectedNodeId: string;
  applicationCalls = 0;

  constructor(initial: State = emptyState(), selectedNodeId = nodeId) {
    this.state = cloneState(initial);
    this.selectedNodeId = selectedNodeId;
  }

  snapshot(): State {
    return cloneState(this.state);
  }

  unitOfWork(): Ports['unitOfWork'] {
    return {
      run: <T>(work: (context: Context) => Promise<T>): Promise<T> => {
        const run = async (): Promise<T> => {
          this.runCalls += 1;
          const draft = cloneState(this.state);
          const context = this.context(draft);
          this.contexts.push(context);
          const result = await work(context);
          if (this.commit === 'unknown-before') throw new Error('commit outcome unknown');
          this.state = draft;
          if (this.commit === 'unknown-after') throw new Error('commit outcome unknown');
          return result;
        };
        const result = this.tail.then(run, run);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
      },
    };
  }

  private context(draft: State): Context {
    return {
      draft,
      idReservations: {
        async reserveAll(reservations) {
          const conflict = reservations.find(({ id }) => draft.reservations.has(id));
          if (conflict !== undefined) {
            return {
              state: 'conflict' as const,
              conflict: {
                requested: conflict,
                existing: {
                  id: conflict.id,
                  resourceType: draft.reservations.get(conflict.id) as ServerIdResourceType,
                },
              },
            };
          }
          for (const reservation of reservations) draft.reservations.set(reservation.id, reservation.resourceType);
          return { state: 'reserved' as const };
        },
      },
      async resolveCollection(id) {
        return draft.collections.get(id);
      },
      async resolveNode(id) {
        return draft.nodes.get(id);
      },
      async resolveChildren(parentId, limit) {
        const nodes = [...draft.nodes.values()].filter((node) => node.parentId === parentId);
        return { nodes: nodes.slice(0, limit), hasMore: nodes.length > limit };
      },
    };
  }

  application(): Ports['application'] {
    return {
      applyOperations: async (batch, context) => {
      this.applicationCalls += 1;
      if (this.failWrite) throw new Error('injected persistence failure');
      const operation = batch.operations[0];
      if (operation === undefined || operation.type !== 'create_node') throw new Error('expected create_node');
      const requestPayload = operation.payload;
      const createdId = this.selectedNodeId;
      const created = {
        id: createdId,
        collectionId: operation.collectionId,
        parentId: requestPayload.parentId,
        position: `position-${createdId}`,
        createdAt: instant,
        updatedAt: instant,
        revision: `revision-${createdId}`,
        ...requestPayload.node,
      } as StrictNode;
      context.draft.nodes.set(createdId, created);
      context.draft.operations.push(operation);
      return {
        batchId: batch.batchId,
        results: [{
          opId: operation.opId,
          sequence: operation.sequence,
          status: 'applied' as const,
          targetId: createdId,
          revision: created.revision,
          cursor: 'cursor-publish-0014',
          warnings: [],
        }],
        serverCursor: 'cursor-publish-0014',
      };
      },
    };
  }
}

function makePorts(adapter: AtomicNodeCreateAdapter, change: Partial<Ports> = {}): Ports {
  return {
    unitOfWork: adapter.unitOfWork(),
    authenticate: async () => ({
      authenticated: true,
      identityResolution: {
        status: 'authenticated',
        identities: [{ type: 'user', id: 'publisher-alice' }],
      },
    }),
    authorize: async () => ({ authorized: true }),
    authorizeNodeIdentity: async () => ({ authorized: true }),
    conceal: async (_context, _identities, _candidate, _mutation, input) => (
      input.authorized ? { allowed: true } : { allowed: false, problem: 'insufficient_scope' }
    ),
    validate: async () => ({ allowed: true }),
    evaluatePolicy: async () => ({ allowed: true }),
    application: adapter.application(),
    ...change,
  };
}

function publish(
  adapter: AtomicNodeCreateAdapter,
  value: Candidate = candidate(),
  ports: Partial<Ports> = {},
): Promise<Result> {
  return executePublisherOrdinaryNodeCreate(value, makePorts(adapter, ports));
}

function rejected(code: keyof typeof problemRegistry) {
  return { state: 'rejected' as const, code, ...problemRegistry[code] };
}

function expectNoCreate(state: State, id = nodeId): void {
  expect(state.nodes.has(id)).toBe(false);
  expect(state.reservations.has(id)).toBe(false);
  expect(state.operations).toEqual([]);
}

describe(`PUBLISH-0014 ordinary Node create Parent boundary [evidence:publisher.node-create-parent]`, () => {
  it.each([
    ['Root', [root()] as StrictNode[], rootId],
    ['Folder', [root(), folder()] as StrictNode[], 'folder-publish-0014'],
  ])(`creates beneath an authoritative same-Collection %s [evidence:publisher.node-create-parent]`, async (_kind, parents, parentId) => {
    const adapter = new AtomicNodeCreateAdapter(emptyState(parents));
    const value = candidate(payload(parentId));
    const result = await publish(adapter, value);

    expect(result).toMatchObject({
      state: 'committed',
      value: { id: nodeId, collectionId, parentId, kind: 'bookmark' },
    });
    const state = adapter.snapshot();
    expect(state.nodes.get(nodeId)).toMatchObject({ parentId, collectionId, kind: 'bookmark' });
    expect(state.reservations.get(nodeId)).toBe('node');
    expect(state.operations).toHaveLength(1);
    expect(adapter.runCalls).toBe(1);
  });

  it.each([
    ['null', null],
    ['missing', undefined],
  ])(`rejects a %s parentId before persistence [evidence:publisher.node-create-parent]`, async (_name, parentId) => {
    const adapter = new AtomicNodeCreateAdapter();
    const invalid = candidate({ ...payload(), parentId } as never);
    await expect(publish(adapter, invalid)).resolves.toEqual(rejected('internal_error'));
    expect(adapter.runCalls).toBe(0);
    expectNoCreate(adapter.snapshot());
  });

  it.each([
    ['Root node kind', { kind: 'root', title: 'Illegal Root', folderRole: 'root' }],
    ['root folderRole', { kind: 'folder', title: 'Illegal Root role', folderRole: 'root' }],
  ])(`rejects %s payloads without creating a second Root [evidence:publisher.node-create-parent]`, async (_name, node) => {
    const adapter = new AtomicNodeCreateAdapter();
    const invalid = candidate({ ...payload(), node } as never);
    await expect(publish(adapter, invalid)).resolves.toEqual(rejected('internal_error'));
    expect(adapter.runCalls).toBe(0);
    expect([...adapter.snapshot().nodes.values()].filter((value) => value.kind === 'root')).toHaveLength(1);
    expectNoCreate(adapter.snapshot());
  });

  it(`rejects a Parent from another Collection [evidence:publisher.node-create-parent]`, async () => {
    const other = folder('other-folder', 'other-collection');
    const state = emptyState([root(), other]);
    state.collections.set('other-collection', { id: 'other-collection', rootNodeId: 'other-root' });
    const adapter = new AtomicNodeCreateAdapter(state);
    const value = candidate(payload(other.id));
    await expect(publish(adapter, value)).resolves.toEqual(rejected('invalid_document'));
    expectNoCreate(adapter.snapshot());
  });

  it.each(['bookmark', 'separator', 'alias'] as const)(`rejects a %s Parent [evidence:publisher.node-create-parent]`, async (kind) => {
    const parent = leaf(kind);
    const adapter = new AtomicNodeCreateAdapter(emptyState([root(), parent]));
    const value = candidate(payload(parent.id));
    await expect(publish(adapter, value)).resolves.toEqual(rejected('invalid_document'));
    expectNoCreate(adapter.snapshot());
  });

  it.each([
    ['missing Collection', { resolveCollection: async () => undefined }],
    ['missing Parent', { resolveNode: async () => undefined }],
    ['malformed Collection', { resolveCollection: async () => ({ id: collectionId, rootNodeId: '' }) }],
    ['malformed Parent', { resolveNode: async () => ({ id: rootId, kind: 'root' }) as never }],
  ])(`fails closed for a %s authoritative read [evidence:publisher.node-create-parent]`, async (_name, resolverChange) => {
    const adapter = new AtomicNodeCreateAdapter();
    const base = adapter.unitOfWork();
    const unitOfWork: Ports['unitOfWork'] = {
      async run(work) {
        return base.run((context) => work(Object.assign(Object.create(Object.getPrototypeOf(context)), context, resolverChange)));
      },
    };
    const result = await publish(adapter, candidate(), { unitOfWork });
    expect(result.state).toBe('rejected');
    expectNoCreate(adapter.snapshot());
  });

  it(`rejects a pre-existing Node and a global non-Node ID reservation [evidence:publisher.node-create-parent]`, async () => {
    const existingNodeState = emptyState([root(), { ...folder(nodeId), parentId: rootId }]);
    const existingNode = new AtomicNodeCreateAdapter(existingNodeState);
    await expect(publish(existingNode)).resolves.toEqual(rejected('revision_conflict'));
    expect(existingNode.snapshot().operations).toEqual([]);

    const reservedState = emptyState();
    reservedState.reservations.set(nodeId, 'relation');
    const globallyReserved = new AtomicNodeCreateAdapter(reservedState);
    await expect(publish(globallyReserved)).resolves.toEqual(rejected('internal_error'));
    expect(globallyReserved.snapshot().reservations.get(nodeId)).toBe('relation');
    expect(globallyReserved.snapshot().operations).toEqual([]);
  });

  it(`uses the same transaction context for authoritative reads, authorization, and creation [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    const seen: Context[] = [];
    const result = await publish(adapter, candidate(), {
      authenticate: async (context) => { seen.push(context); return {
        authenticated: true,
        identityResolution: { status: 'authenticated', identities: [{ type: 'user', id: 'alice' }] },
      }; },
      authorize: async (context) => { seen.push(context); return { authorized: true }; },
      conceal: async (context) => { seen.push(context); return { allowed: true }; },
      evaluatePolicy: async (context) => { seen.push(context); return { allowed: true }; },
      application: {
        applyOperations: async (batch, context) => {
          seen.push(context);
          return adapter.application().applyOperations(batch, context);
        },
      },
    });
    expect(result.state).toBe('committed');
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((context) => context === adapter.contexts[0])).toBe(true);
  });

  it(`keeps the server-resolved Node ID outside canonical nodeCreateRequest and validates it at application [evidence:publisher.node-create-parent]`, async () => {
    const selectedId = 'server-selected-node';
    const adapter = new AtomicNodeCreateAdapter(emptyState(), selectedId);
    let appliedOperation!: Operation;
    const application = adapter.application();
    const result = await publish(adapter, candidate(payload(), selectedId), {
      application: {
        applyOperations: async (batch, context) => {
          appliedOperation = batch.operations[0]!;
          return application.applyOperations(batch, context);
        },
      },
    });
    expect(result).toMatchObject({ state: 'committed', value: { id: selectedId } });
    expect(appliedOperation).not.toHaveProperty('targetId');
    expect(appliedOperation.payload).toEqual(payload());
    expect(adapter.snapshot().reservations.get(selectedId)).toBe('node');
  });

  it(`exposes the exact immutable Core create plan to affected authorization [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    const plans: unknown[] = [];
    const result = await publish(adapter, candidate(), {
      authorize: async (_context, _identities, _candidate, _mutation, subject) => {
        if (subject.kind === 'affected-node') plans.push(subject.plan);
        return { authorized: true };
      },
    });
    expect(result.state).toBe('committed');
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((plan) => Object.isFrozen(plan))).toBe(true);
    expect(plans[0]).toEqual({
      mutation: {
        kind: 'create-node', nodeId, collectionId, nodeKind: 'bookmark', parentId: rootId,
      },
      collectionId,
      modifiedNodeIds: [nodeId, rootId],
      deletedNodeIds: [],
      deletedNodeCount: 0,
      authorizationNodeIds: [nodeId, rootId],
    });
  });

  it.each([
    ['unauthenticated', 'authentication_required' as const],
    ['visible unauthorized', 'insufficient_scope' as const],
    ['concealed unauthorized', 'resource_not_found' as const],
  ])(`applies %s precedence before Parent disclosure [evidence:publisher.node-create-parent]`, async (mode, code) => {
    const adapter = new AtomicNodeCreateAdapter();
    const resolveSpy = vi.fn(async () => { throw new Error('Parent existence must remain concealed'); });
    const base = adapter.unitOfWork();
    const unitOfWork: Ports['unitOfWork'] = {
      run: (work) => base.run((context) => work({ ...context, resolveNode: resolveSpy })),
    };
    const ports: Partial<Ports> = mode === 'unauthenticated'
      ? { unitOfWork, authenticate: async () => ({ authenticated: false }) }
      : {
        unitOfWork,
        authorize: async () => ({ authorized: false, reason: 'private policy' }),
        conceal: async () => ({
          allowed: false,
          problem: mode === 'concealed unauthorized' ? 'resource_not_found' : 'insufficient_scope',
        }),
      };
    await expect(publish(adapter, candidate(payload('secret-parent')), ports))
      .resolves.toEqual(rejected(code));
    expect(resolveSpy).not.toHaveBeenCalled();
    expectNoCreate(adapter.snapshot());
  });

  it.each([
    ['missing identity port', 'missing'],
    ['identity exception', 'throws'],
    ['non-boolean identity decision', 'non-boolean'],
  ] as const)(`conceals %s before reading an existing or missing Parent [evidence:publisher.node-create-parent]`, async (_label, mode) => {
    const runCase = async (parentExists: boolean) => {
      const parent = folder('private-parent');
      const adapter = new AtomicNodeCreateAdapter(emptyState(parentExists ? [root(), parent] : [root()]));
      const base = adapter.unitOfWork();
      const resolveNode = vi.fn(async () => { throw new Error('Parent existence must remain concealed'); });
      const resolveCollection = vi.fn(async () => { throw new Error('Collection existence must remain concealed'); });
      const unitOfWork: Ports['unitOfWork'] = {
        run: (work) => base.run((context) => work({ ...context, resolveNode, resolveCollection })),
      };
      const ports = makePorts(adapter, {
        unitOfWork,
        conceal: async (_context, _identities, _candidate, _mutation, input) => {
          if (input.authorized) return { allowed: true as const };
          expect(input.subject).toMatchObject({ kind: 'node-identity', nodeId: parent.id });
          return { allowed: false as const, problem: 'resource_not_found' as const };
        },
      });
      if (mode === 'missing') {
        delete (ports as { authorizeNodeIdentity?: Ports['authorizeNodeIdentity'] }).authorizeNodeIdentity;
      } else if (mode === 'throws') {
        ports.authorizeNodeIdentity = async () => { throw new Error('private identity state'); };
      } else {
        ports.authorizeNodeIdentity = async () => ({ authorized: 'yes' } as never);
      }
      const result = await executePublisherOrdinaryNodeCreate(candidate(payload(parent.id)), ports);
      expect(resolveNode).not.toHaveBeenCalled();
      expect(resolveCollection).not.toHaveBeenCalled();
      expect(adapter.snapshot().operations).toEqual([]);
      return result;
    };

    await expect(runCase(true)).resolves.toEqual(rejected('resource_not_found'));
    await expect(runCase(false)).resolves.toEqual(rejected('resource_not_found'));
  });

  it(`snapshots the identity method while preserving its receiver and captures the proposed ID [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    const ports = makePorts(adapter) as Ports & { identityAllowed?: boolean };
    ports.identityAllowed = true;
    const seen: string[] = [];
    ports.authorizeNodeIdentity = async function (this: Ports & { identityAllowed?: boolean }, _context, _identities, _candidate, _mutation, id) {
      seen.push(id);
      return this.identityAllowed === true
        ? { authorized: true as const }
        : { authorized: false as const, reason: 'identity gate' };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ports.authenticate = async () => { await gate; return {
      authenticated: true,
      identityResolution: { status: 'authenticated', identities: [{ type: 'user', id: 'publisher-alice' }] },
    }; };
    const pending = executePublisherOrdinaryNodeCreate(candidate(), ports);
    ports.authorizeNodeIdentity = async () => ({ authorized: false, reason: 'replacement must not run' });
    release();
    await expect(pending).resolves.toMatchObject({ state: 'committed', value: { id: nodeId } });
    expect(seen).toEqual([rootId, nodeId]);
  });

  it(`preserves PUBLISH-0013 read-only precedence after authorization and concealment [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter(emptyState([root(rootId, collectionId, { readOnly: true })]));
    const authorize = vi.fn(async () => ({ authorized: true as const }));
    const conceal = vi.fn(async () => ({ allowed: true as const }));
    await expect(publish(adapter, candidate(), { authorize, conceal }))
      .resolves.toEqual(rejected('node_read_only'));
    expect(authorize).toHaveBeenCalled();
    expect(conceal).toHaveBeenCalled();
    expectNoCreate(adapter.snapshot());
  });

  it(`snapshots caller input across asynchronous authorization gates [evidence:publisher.node-create-parent]`, async () => {
    const parent = folder();
    const adapter = new AtomicNodeCreateAdapter(emptyState([root(), parent]));
    const value = candidate(payload(parent.id));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = publish(adapter, value, {
      authorize: async (_context, _identities, _candidate, _mutation, subject) => {
        if (subject.kind === 'affected-node') { started(); await gate; }
        return { authorized: true };
      },
    });
    await entered;
    (value as { nodeId: string }).nodeId = 'attacker-node';
    (value.operation.payload as { parentId: string }).parentId = 'attacker-parent';
    release();
    await expect(pending).resolves.toMatchObject({
      state: 'committed', value: { id: nodeId, parentId: 'folder-publish-0014' },
    });
    expect(adapter.snapshot().nodes.has('attacker-node')).toBe(false);
  });

  it(`rejects resolver TOCTOU when the authoritative Parent changes during application [evidence:publisher.node-create-parent]`, async () => {
    const parent = folder();
    const adapter = new AtomicNodeCreateAdapter(emptyState([root(), parent]));
    const application = adapter.application();
    const result = await publish(adapter, candidate(payload(parent.id)), {
      application: {
        applyOperations: async (batch, context) => {
          const applied = await application.applyOperations(batch, context);
          const authoritativeParent = context.draft.nodes.get(parent.id);
          if (authoritativeParent === undefined) throw new Error('missing test Parent');
          (authoritativeParent as { collectionId: string }).collectionId = 'other-collection';
          return applied;
        },
      },
    });
    expect(result).toEqual(rejected('internal_error'));
    expectNoCreate(adapter.snapshot());
    expect(adapter.snapshot().nodes.get(parent.id)?.collectionId).toBe(collectionId);
  });

  it(`rolls back Node, reservation, and Operation on persistence failure [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    adapter.failWrite = true;
    await expect(publish(adapter)).resolves.toEqual(rejected('internal_error'));
    expectNoCreate(adapter.snapshot());
  });

  it(`rejects a mismatched created Node body and rolls back every effect [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    const application = adapter.application();
    const result = await publish(adapter, candidate(), {
      application: {
        applyOperations: async (batch, context) => {
          const receipt = await application.applyOperations(batch, context) as {
            readonly batchId: string;
            readonly results: readonly OperationResult[];
            readonly serverCursor: string;
          };
          const created = context.draft.nodes.get(nodeId);
          if (created === undefined || created.kind !== 'bookmark') throw new Error('missing created bookmark');
          (created as { title: string }).title = 'Substituted title';
          return receipt;
        },
      },
    });
    expect(result).toEqual(rejected('internal_error'));
    expectNoCreate(adapter.snapshot());
  });

  it.each([
    ['target ID', { targetId: 'different-node' }],
    ['revision', { revision: 'different-revision' }],
  ])(`rejects an application receipt with a mismatched %s [evidence:publisher.node-create-parent]`, async (_label, replacement) => {
    const adapter = new AtomicNodeCreateAdapter();
    const application = adapter.application();
    const result = await publish(adapter, candidate(), {
      application: {
        applyOperations: async (batch, context) => {
          const receipt = await application.applyOperations(batch, context) as {
            readonly batchId: string;
            readonly results: readonly OperationResult[];
            readonly serverCursor: string;
          };
          return {
            ...receipt,
            results: [{ ...receipt.results[0]!, ...replacement }],
          };
        },
      },
    });
    expect(result).toEqual(rejected('internal_error'));
    expectNoCreate(adapter.snapshot());
  });

  it(`keeps a committed Node ID permanently reserved after deletion [evidence:publisher.node-create-parent]`, async () => {
    const first = new AtomicNodeCreateAdapter();
    await expect(publish(first)).resolves.toMatchObject({ state: 'committed' });
    const deleted = first.snapshot();
    deleted.nodes.delete(nodeId);
    deleted.operations.length = 0;
    const retry = new AtomicNodeCreateAdapter(deleted);
    await expect(publish(retry)).resolves.toEqual(rejected('internal_error'));
    expect(retry.snapshot().reservations.get(nodeId)).toBe('node');
    expect(retry.applicationCalls).toBe(0);
  });

  it.each(['unknown-before', 'unknown-after'] as const)(`fails closed for %s commit outcome [evidence:publisher.node-create-parent]`, async (commit) => {
    const adapter = new AtomicNodeCreateAdapter();
    adapter.commit = commit;
    await expect(publish(adapter)).resolves.toEqual(rejected('internal_error'));
    const state = adapter.snapshot();
    if (commit === 'unknown-before') expectNoCreate(state);
    else {
      expect(state.nodes.has(nodeId)).toBe(true);
      expect(state.reservations.get(nodeId)).toBe('node');
      expect(state.operations).toHaveLength(1);
    }
  });

  it(`serializes concurrent creates so one global Node identity wins [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    const [first, second] = await Promise.all([publish(adapter), publish(adapter)]);
    expect([first.state, second.state].sort()).toEqual(['committed', 'rejected']);
    expect(adapter.snapshot().nodes.get(nodeId)).toBeDefined();
    expect(adapter.snapshot().operations).toHaveLength(1);
  });

  it(`fails closed on malformed thenable and Proxy ports without detached persistence [evidence:publisher.node-create-parent]`, async () => {
    const adapter = new AtomicNodeCreateAdapter();
    await expect(publish(adapter, candidate(), {
      authenticate: (() => ({ then: () => undefined })) as never,
    })).resolves.toEqual(rejected('internal_error'));
    await expect(publish(adapter, candidate(), {
      unitOfWork: { run: (() => Promise.resolve(rejected('resource_not_found'))) as never },
    })).resolves.toEqual(rejected('internal_error'));
    await expect(publish(adapter, candidate(), {
      authorize: new Proxy(async () => ({ authorized: true as const }), {}),
    })).resolves.toEqual(rejected('internal_error'));
    await expect(executePublisherOrdinaryNodeCreate(candidate(), new Proxy(makePorts(adapter), {})))
      .resolves.toEqual(rejected('internal_error'));
    const accessorPorts = makePorts(adapter);
    Object.defineProperty(accessorPorts, 'authorize', {
      enumerable: true,
      get() { throw new Error('accessor must not execute'); },
    });
    await expect(executePublisherOrdinaryNodeCreate(candidate(), accessorPorts))
      .resolves.toEqual(rejected('internal_error'));
    await Promise.resolve();
    expectNoCreate(adapter.snapshot());
  });

  it(`retains PUBLISH-0011 canonical mapping and Core parent-guard regressions [evidence:publisher.node-create-parent]`, () => {
    const operation = mapPublisherNodeOperation(operationRequest());
    expect(operation).toMatchObject({
      type: 'create_node', collectionId, baseRevision: null,
      payload: { parentId: rootId, node: { kind: 'bookmark' } },
    });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(() => mapPublisherNodeOperation({
      ...operationRequest(),
      payload: { ...payload(), node: { kind: 'folder', title: 'Root', folderRole: 'root' } },
    } as never)).toThrow();
  });
});
