import { describe, expect, it, vi } from 'vitest';

import * as publisherModule from '../../src/publisher/index.js';
import { problemRegistry } from '../../src/server/index.js';
import type {
  MoveOperationPayload,
  NodeMoveResult,
  Operation,
  OperationResult,
  PrincipalRef,
  StrictNode,
} from '../../src/types/index.js';

const collectionId = 'collection-publish-0015';
const otherCollectionId = 'collection-other';
const rootId = 'root-publish-0015';
const sourceId = 'folder-source';
const targetId = 'folder-target';
const nodeId = 'node-moving';
const instant = '2026-07-19T12:00:00Z';

type ProblemCode = keyof typeof problemRegistry;
type MoveResult =
  | { readonly state: 'committed'; readonly value: NodeMoveResult }
  | { readonly state: 'rejected'; readonly code: ProblemCode; readonly status: number; readonly retryable: boolean };

interface Request {
  readonly ifMatch?: string | readonly string[] | null | undefined;
  readonly operation: {
    readonly operationId: string;
    readonly replicaId: string;
    readonly sequence: number;
    readonly occurredAt: string;
    readonly collectionId: string;
    readonly action: 'move';
    readonly targetId: string;
    readonly baseRevision: string;
    readonly payload: MoveOperationPayload;
  };
}

interface State {
  readonly nodes: Map<string, StrictNode>;
  readonly childrenRevisions: Map<string, string>;
  readonly operations: Operation[];
}

interface Context {
  readonly draft: State;
  resolveCollection(id: string): Promise<{ readonly id: string; readonly rootNodeId: string } | undefined>;
  resolveNode(id: string): Promise<StrictNode | undefined>;
  resolveChildren(parentId: string, limit: number): Promise<{ readonly nodes: readonly StrictNode[]; readonly hasMore: boolean }>;
  resolveMovePositionContext(parentId: string): Promise<{
    readonly parentId: string;
    readonly childrenRevision: string;
    readonly children: readonly StrictNode[];
  } | undefined>;
}

interface Ports {
  readonly unitOfWork: { run<T>(work: (context: Context) => Promise<T>): Promise<T> };
  authenticate(context: Context, request: Readonly<Request>): Promise<{
    readonly authenticated: true;
    readonly identityResolution: { readonly status: 'authenticated'; readonly identities: readonly PrincipalRef[] };
  } | { readonly authenticated: false }>;
  authorize(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    subject: {
      readonly kind: 'request-target' | 'affected-node';
      readonly nodeId?: string;
      readonly plan?: Readonly<Record<string, unknown>>;
    },
  ): Promise<{ readonly authorized: true } | { readonly authorized: false; readonly reason: string }>;
  authorizeNodeIdentity?(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    nodeId: string,
  ): Promise<{ readonly authorized: true } | { readonly authorized: false; readonly reason: string }>;
  conceal(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    input: { readonly authorized: boolean; readonly subject: { readonly kind: string; readonly nodeId?: string } },
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly problem: 'insufficient_scope' | 'resource_not_found' }>;
  validate(
    context: Context,
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  evaluatePolicy(
    context: Context,
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    nodeId: string,
    plan: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  application: {
    applyOperations(
      batch: { readonly batchId: string; readonly atomic: true; readonly operations: readonly Operation[] },
      context: Context,
    ): Promise<{ readonly batchId: string; readonly results: readonly OperationResult[]; readonly serverCursor: string }>;
  };
}

type ExecuteMove = (
  request: Request,
  ports: Ports,
  limits?: { readonly maxDepth?: number; readonly maxVisitedNodes?: number },
) => Promise<MoveResult>;
// This local shape makes the test a black-box contract for the new export while
// allowing the test file to typecheck before the production task lands.
const executePublisherNodeMove = (publisherModule as unknown as {
  readonly executePublisherNodeMove: ExecuteMove;
}).executePublisherNodeMove;

function folder(id: string, parentId = rootId, owner = collectionId, revision = `node-revision-${id}`): StrictNode {
  return {
    id, collectionId: owner, kind: 'folder', parentId, position: `position-${id}`,
    folderRole: 'custom', title: id, createdAt: instant, updatedAt: instant, revision,
  };
}

function root(id = rootId, owner = collectionId): StrictNode {
  return {
    id, collectionId: owner, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: id, createdAt: instant, updatedAt: instant, revision: `node-revision-${id}`,
  };
}

function bookmark(id: string, parentId: string, owner = collectionId, position = `position-${id}`): StrictNode {
  return {
    id, collectionId: owner, kind: 'bookmark', parentId, position, title: id,
    url: `https://example.test/${id}`, createdAt: instant, updatedAt: instant, revision: `node-revision-${id}`,
  };
}

function initialState(nodes: readonly StrictNode[] = [
  root(), folder(sourceId), folder(targetId), bookmark(nodeId, sourceId),
  bookmark('anchor-after', targetId, collectionId, 'a'), bookmark('anchor-before', targetId, collectionId, 'c'),
]): State {
  return {
    nodes: new Map(nodes.map((node) => [node.id, structuredClone(node)])),
    childrenRevisions: new Map([[sourceId, 'children-source-r1'], [targetId, 'children-target-r1'], [rootId, 'children-root-r1']]),
    operations: [],
  };
}

function cloneState(state: State): State {
  return {
    nodes: new Map([...state.nodes].map(([id, node]) => [id, structuredClone(node)])),
    childrenRevisions: new Map(state.childrenRevisions),
    operations: structuredClone(state.operations),
  };
}

function request(change: Partial<Request> = {}, payloadChange: Partial<MoveOperationPayload> = {}): Request {
  const payload: MoveOperationPayload = {
    newParentId: targetId,
    afterId: 'anchor-after',
    beforeId: 'anchor-before',
    baseSourceParentRevision: 'children-source-r1',
    baseTargetParentRevision: 'children-target-r1',
    ...payloadChange,
  };
  return {
    ifMatch: `"node-revision-${nodeId}"`,
    operation: {
      operationId: 'operation-publish-0015', replicaId: 'publisher-server', sequence: 15,
      occurredAt: instant, collectionId, action: 'move', targetId: nodeId,
      baseRevision: `node-revision-${nodeId}`, payload,
    },
    ...change,
  };
}

class AtomicMoveAdapter {
  private state: State;
  private tail: Promise<void> = Promise.resolve();
  readonly events: string[] = [];
  commit: 'known' | 'unknown-before' | 'unknown-after' = 'known';
  failApplication = false;
  retainMovedNodeInSourceContext = false;
  transformPosition = 'b';

  constructor(state = initialState()) { this.state = cloneState(state); }
  snapshot(): State { return cloneState(this.state); }

  ports(change: Partial<Ports> = {}): Ports {
    const adapter = this;
    const defaults: Ports = {
      unitOfWork: {
        run<T>(work: (context: Context) => Promise<T>): Promise<T> {
          const run = async (): Promise<T> => {
            adapter.events.push('transaction');
            const draft = cloneState(adapter.state);
            const value = await work(adapter.context(draft));
            if (adapter.commit === 'unknown-before') throw new Error('commit outcome unknown');
            adapter.state = draft;
            if (adapter.commit === 'unknown-after') throw new Error('commit outcome unknown');
            return value;
          };
          const value = adapter.tail.then(run, run);
          adapter.tail = value.then(() => undefined, () => undefined);
          return value;
        },
      },
      authenticate: async () => {
        adapter.events.push('authenticate');
        return { authenticated: true, identityResolution: {
          status: 'authenticated', identities: [{ type: 'user', id: 'alice' }],
        } };
      },
      authorize: async (_context, _identities, _request, _mutation, subject) => {
        adapter.events.push(`authorize:${subject.kind}:${subject.nodeId ?? '-'}`);
        return { authorized: true };
      },
      authorizeNodeIdentity: async () => ({ authorized: true }),
      conceal: async (_context, _identities, _request, _mutation, input) => {
        adapter.events.push(`conceal:${input.subject.kind}:${input.subject.nodeId ?? '-'}`);
        return { allowed: true };
      },
      validate: async () => { adapter.events.push('validate'); return { allowed: true }; },
      evaluatePolicy: async () => { adapter.events.push('policy'); return { allowed: true }; },
      application: {
        applyOperations: async (batch, context) => {
          adapter.events.push('apply');
          const operation = batch.operations[0]!;
          const moving = context.draft.nodes.get(operation.targetId!)!;
          const move = operation.payload as MoveOperationPayload;
          const oldParentId = moving.parentId!;
          if (moving.kind === 'root') throw new Error('Root reached move application');
          const updated = {
            ...moving, parentId: move.newParentId, position: adapter.transformPosition,
            updatedAt: '2026-07-19T12:00:01Z', revision: 'node-revision-moved-r2',
          } as StrictNode;
          context.draft.nodes.set(updated.id, updated);
          const sourceRevision = oldParentId === move.newParentId ? 'children-same-r2' : 'children-source-r2';
          const targetRevision = oldParentId === move.newParentId ? sourceRevision : 'children-target-r2';
          context.draft.childrenRevisions.set(oldParentId, sourceRevision);
          context.draft.childrenRevisions.set(move.newParentId, targetRevision);
          context.draft.operations.push(structuredClone(operation));
          if (adapter.failApplication) throw new Error('persistence failure after draft mutation');
          return {
            batchId: batch.batchId,
            results: [{
              opId: operation.opId, sequence: operation.sequence, status: 'applied', targetId: updated.id,
              revision: updated.revision, cursor: 'cursor-publish-0015', transform: { position: adapter.transformPosition }, warnings: [],
            }],
            serverCursor: 'cursor-publish-0015',
          };
        },
      },
    };
    return { ...defaults, ...change };
  }

  private context(draft: State): Context {
    const adapter = this;
    return {
      draft,
      async resolveCollection(id) {
        adapter.events.push(`collection:${id}`);
        if (id === collectionId) return { id, rootNodeId: rootId };
        if (id === otherCollectionId) return { id, rootNodeId: 'other-root' };
        return undefined;
      },
      async resolveNode(id) { adapter.events.push(`node:${id}`); return draft.nodes.get(id); },
      async resolveChildren(parentId, limit) {
        adapter.events.push(`children:${parentId}`);
        const nodes = [...draft.nodes.values()].filter((node) => node.parentId === parentId)
          .sort((left, right) => (left.position ?? '').localeCompare(right.position ?? ''));
        return { nodes: nodes.slice(0, limit), hasMore: nodes.length > limit };
      },
      async resolveMovePositionContext(parentId) {
        adapter.events.push(`position:${parentId}`);
        const childrenRevision = draft.childrenRevisions.get(parentId);
        if (childrenRevision === undefined) return undefined;
        const children = [...draft.nodes.values()].filter((node) => node.parentId === parentId)
          .sort((left, right) => (left.position ?? '').localeCompare(right.position ?? ''));
        if (adapter.retainMovedNodeInSourceContext && parentId === sourceId
          && !children.some((node) => node.id === nodeId)) {
          const moved = draft.nodes.get(nodeId);
          if (moved !== undefined) children.push({ ...moved, parentId: sourceId } as StrictNode);
        }
        return { parentId, childrenRevision, children };
      },
    };
  }
}

const rejected = (code: ProblemCode) => ({ state: 'rejected', code, ...problemRegistry[code] });

describe('PUBLISH-0015 Node Move concurrency boundary [evidence:publisher.node-move-concurrency]', () => {
  it('commits a cross-Parent move with the canonical Operation and exact transformed receipt [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const result = await executePublisherNodeMove(request(), adapter.ports());
    const state = adapter.snapshot();

    const expectedNode: StrictNode = {
      id: nodeId, collectionId, kind: 'bookmark', parentId: targetId, position: 'b', title: nodeId,
      url: `https://example.test/${nodeId}`, createdAt: instant, updatedAt: '2026-07-19T12:00:01Z',
      revision: 'node-revision-moved-r2',
    };
    expect(result).toEqual({ state: 'committed', value: {
      node: expectedNode, sourceParentRevision: 'children-source-r2',
      targetParentRevision: 'children-target-r2', position: 'b', warnings: [],
    } });
    expect(state.nodes.get(nodeId)).toEqual(expectedNode);
    expect(state.childrenRevisions).toEqual(new Map([
      [sourceId, 'children-source-r2'], [targetId, 'children-target-r2'], [rootId, 'children-root-r1'],
    ]));
    expect(state.operations).toEqual([{
      opId: 'operation-publish-0015', replicaId: 'publisher-server', sequence: 15, type: 'move_node',
      occurredAt: instant, collectionId, targetId: nodeId, baseRevision: `node-revision-${nodeId}`,
      payload: {
        newParentId: targetId, afterId: 'anchor-after', beforeId: 'anchor-before',
        baseSourceParentRevision: 'children-source-r1', baseTargetParentRevision: 'children-target-r1',
      },
    }]);
    expect(adapter.events.indexOf('apply')).toBeGreaterThan(adapter.events.indexOf(`position:${targetId}`));
  });

  it('supports same-Parent reorder only with both equal revisions and returns the same updated revision twice [evidence:publisher.node-move-concurrency]', async () => {
    const state = initialState([root(), folder(sourceId), bookmark(nodeId, sourceId), bookmark('anchor-after', sourceId, collectionId, 'a')]);
    state.childrenRevisions.set(sourceId, 'children-same-r1');
    const adapter = new AtomicMoveAdapter(state);
    const command = request({}, {
      newParentId: sourceId, afterId: 'anchor-after', beforeId: null,
      baseSourceParentRevision: 'children-same-r1', baseTargetParentRevision: 'children-same-r1',
    });
    const result = await executePublisherNodeMove(command, adapter.ports());

    expect(result).toMatchObject({ state: 'committed', value: {
      sourceParentRevision: 'children-same-r2', targetParentRevision: 'children-same-r2', position: 'b',
      node: { id: nodeId, parentId: sourceId, position: 'b' },
    } });
    expect(adapter.snapshot().operations[0]).toMatchObject({ type: 'move_node', payload: command.operation.payload });
  });

  it.each([
    ['missing', undefined, 'precondition_required'],
    ['null', null, 'precondition_required'],
    ['empty repeated field', [], 'precondition_required'],
    ['empty', '', 'precondition_failed'],
    ['bare', `node-revision-${nodeId}`, 'precondition_failed'],
    ['weak', `W/"node-revision-${nodeId}"`, 'precondition_failed'],
    ['stale', '"node-revision-stale"', 'precondition_failed'],
  ] as const)('rejects %s Node If-Match before position or application with the exact 428/412 Problem [evidence:publisher.node-move-concurrency]', async (_label, ifMatch, code) => {
    const adapter = new AtomicMoveAdapter();
    const result = await executePublisherNodeMove(request({ ifMatch }), adapter.ports());
    expect(result).toEqual({
      ...rejected(code),
      currentRevision: `node-revision-${nodeId}`,
      currentEtag: `"node-revision-${nodeId}"`,
    });
    expect(adapter.events).not.toContain('apply');
    expect(adapter.events.some((event) => event.startsWith('position:'))).toBe(false);
  });

  it.each([
    ['missing source', { baseSourceParentRevision: undefined }, 'precondition_required'],
    ['missing target', { baseTargetParentRevision: undefined }, 'precondition_required'],
    ['malformed source', { baseSourceParentRevision: '' }, 'precondition_failed'],
    ['malformed target', { baseTargetParentRevision: ' target revision ' }, 'precondition_failed'],
    ['stale source', { baseSourceParentRevision: 'children-source-old' }, 'position_context_stale'],
    ['stale target', { baseTargetParentRevision: 'children-target-old' }, 'position_context_stale'],
  ] as const)('rejects %s Children Revision atomically [evidence:publisher.node-move-concurrency]', async (_label, change, code) => {
    const adapter = new AtomicMoveAdapter();
    const command = request({}, change as Partial<MoveOperationPayload>);
    const result = await executePublisherNodeMove(command, adapter.ports());
    expect(result).toEqual(rejected(code));
    expect(adapter.snapshot().operations).toEqual([]);
    if (code === 'position_context_stale') {
      expect(result).toEqual({ state: 'rejected', code, status: 409, retryable: true });
      expect(adapter.events).toContain(`position:${sourceId}`);
      expect(adapter.events).toContain(`position:${targetId}`);
    }
  });

  it('rejects unequal same-Parent Source/Target values even when each independently names a plausible revision [evidence:publisher.node-move-concurrency]', async () => {
    const state = initialState([root(), folder(sourceId), bookmark(nodeId, sourceId)]);
    state.childrenRevisions.set(sourceId, 'children-same-r1');
    const adapter = new AtomicMoveAdapter(state);
    const result = await executePublisherNodeMove(request({}, {
      newParentId: sourceId, afterId: null, beforeId: null,
      baseSourceParentRevision: 'children-same-r1', baseTargetParentRevision: 'children-same-r2',
    }), adapter.ports());
    expect(result).toEqual(rejected('position_context_stale'));
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it('rejects an oversized complete position context with stable 413 before application [evidence:publisher.node-move-concurrency]', async () => {
    const extraChildren = Array.from(
      { length: 8 },
      (_, index) => bookmark(`extra-${index}`, targetId, collectionId, `z${index}`),
    );
    const adapter = new AtomicMoveAdapter(initialState([
      root(), folder(sourceId), folder(targetId), bookmark(nodeId, sourceId),
      bookmark('anchor-after', targetId, collectionId, 'a'),
      bookmark('anchor-before', targetId, collectionId, 'c'),
      ...extraChildren,
    ]));

    const result = await executePublisherNodeMove(
      request(),
      adapter.ports(),
      { maxVisitedNodes: 7 },
    );

    expect(result).toEqual(rejected('payload_too_large'));
    expect(adapter.events).toContain(`position:${targetId}`);
    expect(adapter.events).not.toContain('apply');
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it('accepts a complete position context exactly at maxVisitedNodes [evidence:publisher.node-move-concurrency]', async () => {
    const exactLimitSiblings = Array.from(
      // The target has 19 children before the Move and exactly 20 after it.
      { length: 17 },
      (_, index) => bookmark(`limit-sibling-${index}`, targetId, collectionId, `m${index}`),
    );
    const adapter = new AtomicMoveAdapter(initialState([
      root(), folder(sourceId), folder(targetId), bookmark(nodeId, sourceId),
      bookmark('anchor-after', targetId, collectionId, 'a'),
      bookmark('anchor-before', targetId, collectionId, 'c'),
      ...exactLimitSiblings,
    ]));

    const result = await executePublisherNodeMove(request(), adapter.ports(), { maxVisitedNodes: 20 });

    expect(result).toMatchObject({ state: 'committed' });
    expect(adapter.events).toContain('apply');
    expect(adapter.snapshot().operations).toHaveLength(1);
  });

  it('serializes concurrent moves so only the first matching revision set commits [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const first = executePublisherNodeMove(request(), adapter.ports());
    const second = executePublisherNodeMove(request({ operation: { ...request().operation, operationId: 'operation-racer', sequence: 16 } }), adapter.ports());
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toContainEqual(expect.objectContaining({ state: 'committed' }));
    expect(outcomes).toContainEqual({
      ...rejected('precondition_failed'),
      currentRevision: 'node-revision-moved-r2',
      currentEtag: '"node-revision-moved-r2"',
    });
    expect(adapter.snapshot().operations).toHaveLength(1);
  });

  it.each([
    ['source Node absent', initialState([root(), folder(sourceId), folder(targetId)]), 'resource_not_found'],
    ['source Parent absent', initialState([root(), folder(targetId), bookmark(nodeId, 'missing-source')]), 'resource_not_found'],
    ['source Parent is not Root/Folder', initialState([root(), bookmark(sourceId, rootId), folder(targetId), bookmark(nodeId, sourceId)]), 'invalid_document'],
    ['source Parent crosses Collection', initialState([root(), folder(sourceId, 'other-root', otherCollectionId), folder(targetId), bookmark(nodeId, sourceId)]), 'invalid_document'],
    ['source Node crosses Collection', initialState([root(), folder(sourceId), folder(targetId), bookmark(nodeId, sourceId, otherCollectionId)]), 'invalid_document'],
    ['target absent', initialState([root(), folder(sourceId), bookmark(nodeId, sourceId)]), 'resource_not_found'],
    ['target is Bookmark', initialState([root(), folder(sourceId), bookmark(nodeId, sourceId), bookmark(targetId, rootId)]), 'invalid_document'],
    ['cross Collection target', initialState([root(), folder(sourceId), bookmark(nodeId, sourceId), folder(targetId, 'other-root', otherCollectionId)]), 'invalid_document'],
  ] as const)('rejects %s without persisting [evidence:publisher.node-move-concurrency]', async (_label, state, code) => {
    const adapter = new AtomicMoveAdapter(state);
    const result = await executePublisherNodeMove(request(), adapter.ports());
    expect(result).toEqual(rejected(code));
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it('forbids moving the Collection Root through this endpoint [evidence:publisher.node-move-concurrency]', async () => {
    const state = initialState([root(), folder(targetId)]);
    const adapter = new AtomicMoveAdapter(state);
    const rootRequest = request({
      ifMatch: '"node-revision-root-publish-0015"',
      operation: { ...request().operation, targetId: rootId, baseRevision: 'node-revision-root-publish-0015' },
    });
    expect(await executePublisherNodeMove(rootRequest, adapter.ports())).toEqual(rejected('invalid_document'));
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it('accepts the Collection Root as a target Parent while preserving the ordinary source Node [evidence:publisher.node-move-concurrency]', async () => {
    const state = initialState([root(), folder(sourceId), bookmark(nodeId, sourceId)]);
    const adapter = new AtomicMoveAdapter(state);
    const result = await executePublisherNodeMove(request({}, {
      newParentId: rootId, afterId: null, beforeId: null,
      baseSourceParentRevision: 'children-source-r1', baseTargetParentRevision: 'children-root-r1',
    }), adapter.ports());
    expect(result).toMatchObject({ state: 'committed', value: { node: { id: nodeId, parentId: rootId } } });
    expect(adapter.snapshot().operations[0]).toMatchObject({ type: 'move_node', payload: { newParentId: rootId } });
  });

  it.each([
    ['after belongs to source', { afterId: 'source-only', beforeId: null }],
    ['before is absent', { afterId: null, beforeId: 'missing-anchor' }],
    ['anchors are nonadjacent', { afterId: 'anchor-after', beforeId: 'nonadjacent' }],
    ['anchors are reversed', { afterId: 'anchor-before', beforeId: 'anchor-after' }],
  ] as const)('returns position_context_stale when %s [evidence:publisher.node-move-concurrency]', async (_label, anchors) => {
    const state = initialState([
      ...initialState().nodes.values(),
      bookmark('source-only', sourceId, collectionId, 'q'),
      bookmark('nonadjacent', targetId, collectionId, 'z'),
    ]);
    const adapter = new AtomicMoveAdapter(state);
    expect(await executePublisherNodeMove(request({}, anchors), adapter.ports())).toEqual({
      state: 'rejected', code: 'position_context_stale', status: 409, retryable: true,
    });
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it.each([
    ['authorization denial', sourceId, 'insufficient_scope'],
    ['authorization concealment', sourceId, 'resource_not_found'],
    ['authorization denial', targetId, 'insufficient_scope'],
    ['authorization concealment', targetId, 'resource_not_found'],
    ['authorization denial', 'anchor-after', 'insufficient_scope'],
    ['authorization concealment', 'anchor-after', 'resource_not_found'],
    ['authorization denial', 'anchor-before', 'insufficient_scope'],
    ['authorization concealment', 'anchor-before', 'resource_not_found'],
    ['visibility concealment', sourceId, 'resource_not_found'],
    ['visibility concealment', targetId, 'resource_not_found'],
    ['visibility concealment', 'anchor-after', 'resource_not_found'],
    ['visibility concealment', 'anchor-before', 'resource_not_found'],
  ] as const)('applies %s to participant %s without leaking graph or revision state [evidence:publisher.node-move-concurrency]', async (mode, deniedId, code) => {
    const adapter = new AtomicMoveAdapter();
    const inspected: string[] = [];
    const ports = adapter.ports({
      authorize: async (_context, _identities, _request, _mutation, subject) => {
        inspected.push(`authorize:${subject.kind}:${subject.nodeId ?? '-'}`);
        return mode !== 'visibility concealment' && subject.kind === 'affected-node' && subject.nodeId === deniedId
          ? { authorized: false, reason: 'classified participant policy' }
          : { authorized: true };
      },
      conceal: async (_context, _identities, _request, _mutation, input) => {
        inspected.push(`conceal:${input.subject.kind}:${input.subject.nodeId ?? '-'}`);
        const selected = input.subject.kind === 'affected-node' && input.subject.nodeId === deniedId;
        return (!input.authorized || (mode === 'visibility concealment' && selected))
          ? { allowed: false, problem: code }
          : { allowed: true };
      },
    });
    const result = await executePublisherNodeMove(request(), ports);
    expect(result).toEqual(rejected(code));
    expect(inspected).toContain(`authorize:affected-node:${deniedId}`);
    expect(inspected).toContain(`conceal:affected-node:${deniedId}`);
    expect(JSON.stringify(result)).not.toMatch(/anchor|revision|classified|\bsource\b|\btarget\b|participant/iu);
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it.each([
    ['source', nodeId],
    ['target Parent', targetId],
    ['after anchor', 'anchor-after'],
    ['before anchor', 'anchor-before'],
  ] as const)('conceals an unauthorized %s before graph reads [evidence:publisher.node-move-concurrency]', async (_label, deniedId) => {
    for (const exists of [true, false]) {
      const state = initialState();
      if (!exists) state.nodes.delete(deniedId);
      const adapter = new AtomicMoveAdapter(state);
      const identityChecks: string[] = [];
      const ports = adapter.ports({
        authorizeNodeIdentity: async (_context, _identities, _request, _mutation, id) => {
          identityChecks.push(id);
          return id === deniedId ? { authorized: false, reason: 'private identity' } : { authorized: true };
        },
        conceal: async (_context, _identities, _request, _mutation, input) => {
          if (input.authorized) return { allowed: true as const };
          expect(input.subject).toMatchObject({ kind: 'node-identity', nodeId: deniedId });
          return { allowed: false as const, problem: 'resource_not_found' as const };
        },
      });
      const result = await executePublisherNodeMove(request(), ports);
      expect(result).toEqual(rejected('resource_not_found'));
      expect(identityChecks).toContain(deniedId);
      expect(adapter.events.some((event) => /^(node|children|position|collection):/u.test(event))).toBe(false);
      expect(adapter.snapshot().operations).toEqual([]);
    }
  });

  it.each([
    ['missing', undefined],
    ['throws', async () => { throw new Error('private identity state'); }],
    ['non-boolean', async () => ({ authorized: 'yes' } as never)],
  ] as const)('fails closed and conceals when the identity port is %s [evidence:publisher.node-move-concurrency]', async (_label, identityPort) => {
    const adapter = new AtomicMoveAdapter();
    const ports = adapter.ports({
      conceal: async (_context, _identities, _request, _mutation, input) => (
        input.authorized ? { allowed: true } : { allowed: false, problem: 'resource_not_found' }
      ),
    });
    if (identityPort === undefined) {
      delete (ports as { authorizeNodeIdentity?: Ports['authorizeNodeIdentity'] }).authorizeNodeIdentity;
    } else if (typeof identityPort === 'function') {
      ports.authorizeNodeIdentity = identityPort;
    }
    const result = await executePublisherNodeMove(request(), ports);
    expect(result).toEqual(rejected('resource_not_found'));
    expect(adapter.events.some((event) => /^(node|children|position|collection):/u.test(event))).toBe(false);
  });

  it('captures the identity method and invokes it with the host receiver [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const ports = adapter.ports() as Ports & { identityAllowed?: boolean };
    ports.identityAllowed = true;
    const seen: string[] = [];
    ports.authorizeNodeIdentity = async function (this: Ports & { identityAllowed?: boolean }, _context, _identities, _request, _mutation, id) {
      seen.push(id);
      return this.identityAllowed === true
        ? { authorized: true as const }
        : { authorized: false as const, reason: 'identity gate' };
    };
    const pending = executePublisherNodeMove(request(), ports);
    ports.authorizeNodeIdentity = async () => ({ authorized: false, reason: 'replacement must not run' });
    await expect(pending).resolves.toMatchObject({ state: 'committed' });
    expect(seen).toEqual([nodeId, targetId, 'anchor-after', 'anchor-before']);
  });

  it('checks authorization and concealment before preconditions, graph details, read-only state, and position context [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const result = await executePublisherNodeMove(request({ ifMatch: undefined }), adapter.ports({
      authorize: async () => ({ authorized: false, reason: 'secret resource' }),
      conceal: async () => ({ allowed: false, problem: 'resource_not_found' }),
    }));
    expect(result).toEqual(rejected('resource_not_found'));
    expect(adapter.events.some((event) => /^(node|children|position):/u.test(event))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/secret|precondition|revision|read.?only/iu);
  });

  it("rejects a move beneath the Node's own descendant as a cycle [evidence:publisher.node-move-concurrency]", async () => {
    const state = initialState([root(), folder(sourceId), folder(nodeId, sourceId), folder(targetId, nodeId)]);
    const adapter = new AtomicMoveAdapter(state);
    expect(await executePublisherNodeMove(request(), adapter.ports())).toEqual(rejected('invalid_document'));
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it.each([
    ['moving Node', nodeId],
    ['source Parent', sourceId],
    ['target Parent', targetId],
  ] as const)('rejects a read-only %s only after authorization and concealment [evidence:publisher.node-move-concurrency]', async (_label, lockedId) => {
    const nodes = [root(), folder(sourceId), folder(targetId), bookmark(nodeId, sourceId)].map((node) => node.id === lockedId
      ? { ...node, constraints: { readOnly: true, reason: 'legal hold' } } as StrictNode
      : node);
    const adapter = new AtomicMoveAdapter(initialState(nodes));
    const result = await executePublisherNodeMove(request({}, { afterId: null, beforeId: null }), adapter.ports());
    expect(result).toEqual(rejected('node_read_only'));
    expect(adapter.events).toContain(`authorize:affected-node:${lockedId}`);
    expect(adapter.events).toContain(`conceal:affected-node:${lockedId}`);
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it('authorizes a read-only anchor as position context without treating the unmodified sibling as a mutation veto [evidence:publisher.node-move-concurrency]', async () => {
    const lockedAnchor = {
      ...bookmark('anchor-after', targetId, collectionId, 'a'),
      constraints: { readOnly: true, reason: 'retained sibling' },
    } as StrictNode;
    const adapter = new AtomicMoveAdapter(initialState([
      root(), folder(sourceId), folder(targetId), bookmark(nodeId, sourceId),
      lockedAnchor, bookmark('anchor-before', targetId, collectionId, 'c'),
    ]));
    const result = await executePublisherNodeMove(request(), adapter.ports());
    expect(result).toMatchObject({ state: 'committed', value: { position: 'b' } });
    expect(adapter.events).toContain('authorize:affected-node:anchor-after');
  });

  it('rolls back every mutation on application failure and treats unknown commit as internal_error [evidence:publisher.node-move-concurrency]', async () => {
    const failed = new AtomicMoveAdapter();
    failed.failApplication = true;
    const before = failed.snapshot();
    expect(await executePublisherNodeMove(request(), failed.ports())).toEqual(rejected('internal_error'));
    expect(failed.snapshot()).toEqual(before);

    for (const commit of ['unknown-before', 'unknown-after'] as const) {
      const unknown = new AtomicMoveAdapter();
      unknown.commit = commit;
      const unknownBefore = unknown.snapshot();
      expect(await executePublisherNodeMove(request(), unknown.ports())).toEqual(rejected('internal_error'));
      if (commit === 'unknown-before') expect(unknown.snapshot()).toEqual(unknownBefore);
    }
  });

  it('snapshots caller input and resolver values to close caller/resolver TOCTOU [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const command = request();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ports = adapter.ports({ authenticate: async () => { await gate; return {
      authenticated: true, identityResolution: {
        status: 'authenticated', identities: [{ type: 'user', id: 'alice' }],
      },
    }; } });
    const pending = executePublisherNodeMove(command, ports);
    (command.operation.payload as { newParentId: string }).newParentId = 'attacker-parent';
    (ports as { application: Ports['application'] }).application = { applyOperations: vi.fn() };
    release();
    const result = await pending;
    expect(result).toMatchObject({ state: 'committed', value: { node: { parentId: targetId } } });
    expect(adapter.snapshot().operations[0]).toMatchObject({ payload: { newParentId: targetId } });
  });

  it('revalidates authoritative resolver identities after application and rolls back a resolver TOCTOU swap [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const ports = adapter.ports();
    const realApplication = ports.application;
    const result = await executePublisherNodeMove(request(), adapter.ports({
      application: {
        applyOperations: async (batch, context) => {
          const receipt = await realApplication.applyOperations(batch, context);
          const target = context.draft.nodes.get(targetId)!;
          context.draft.nodes.set(targetId, { ...target, collectionId: otherCollectionId } as StrictNode);
          return receipt;
        },
      },
    }));
    expect(result).toEqual(rejected('internal_error'));
    expect(adapter.snapshot().operations).toEqual([]);
  });

  it('rolls back when the authoritative source context still contains the cross-Parent moved Node [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    adapter.retainMovedNodeInSourceContext = true;
    const before = adapter.snapshot();

    expect(await executePublisherNodeMove(request(), adapter.ports())).toEqual(rejected('internal_error'));
    expect(adapter.events).toContain('apply');
    expect(adapter.snapshot()).toEqual(before);
  });

  it.each([
    ['null ports', null],
    ['Proxy ports', new Proxy({}, {})],
    ['accessor application', Object.defineProperty({}, 'application', { get() { throw new Error('getter'); } })],
  ] as const)('fails closed for %s [evidence:publisher.node-move-concurrency]', async (_label, hostile) => {
    await expect(executePublisherNodeMove(request(), hostile as unknown as Ports)).resolves.toEqual(rejected('internal_error'));
  });

  it('rejects thenable/non-native-Promise ports and malformed application receipts [evidence:publisher.node-move-concurrency]', async () => {
    const thenable = new AtomicMoveAdapter();
    const thenableResult = await executePublisherNodeMove(request(), thenable.ports({
      authenticate: (() => ({ then: (resolve: (value: unknown) => void) => resolve({ authenticated: true, identities: [] }) })) as unknown as Ports['authenticate'],
    }));
    expect(thenableResult).toEqual(rejected('internal_error'));

    const malformed = new AtomicMoveAdapter();
    const result = await executePublisherNodeMove(request(), malformed.ports({
      application: { applyOperations: async () => ({ batchId: 'wrong', results: [], serverCursor: 'cursor' }) },
    }));
    expect(result).toEqual(rejected('internal_error'));
    expect(malformed.snapshot().operations).toEqual([]);
  });

  it('uses one transaction context for security, both Parent reads, position validation, and application [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const base = adapter.ports();
    const contexts = new Set<Context>();
    const ports = adapter.ports({
      authenticate: async (context, command) => {
        contexts.add(context);
        return base.authenticate(context, command);
      },
      authorize: async (context, identities, command, mutation, subject) => {
        contexts.add(context);
        return base.authorize(context, identities, command, mutation, subject);
      },
      conceal: async (context, identities, command, mutation, input) => {
        contexts.add(context);
        return base.conceal(context, identities, command, mutation, input);
      },
      validate: async (context, command, mutation) => {
        contexts.add(context);
        return base.validate(context, command, mutation);
      },
      evaluatePolicy: async (context, command, mutation, policyNodeId, plan) => {
        contexts.add(context);
        return base.evaluatePolicy(context, command, mutation, policyNodeId, plan);
      },
      application: {
        applyOperations: async (batch, context) => {
          contexts.add(context);
          return base.application.applyOperations(batch, context);
        },
      },
    });
    expect(await executePublisherNodeMove(request(), ports)).toMatchObject({ state: 'committed' });
    expect(contexts.size).toBe(1);
    expect(adapter.events).toEqual(expect.arrayContaining([
      'transaction', `node:${nodeId}`, `node:${sourceId}`, `node:${targetId}`,
      `position:${sourceId}`, `position:${targetId}`, 'apply',
    ]));
    expect(adapter.events.indexOf('apply')).toBeGreaterThan(adapter.events.indexOf(`position:${targetId}`));
    expect(adapter.events.indexOf(`position:${sourceId}`)).toBeGreaterThan(adapter.events.indexOf('authorize:affected-node:anchor-before'));
  });

  it('retains PUBLISH-0006/0008/0011/0013/0014 and Core contracts at the composed boundary [evidence:publisher.node-move-concurrency]', async () => {
    const adapter = new AtomicMoveAdapter();
    const subjects: string[] = [];
    const plans: Readonly<Record<string, unknown>>[] = [];
    const result = await executePublisherNodeMove(request(), adapter.ports({
      authorize: async (_context, _identities, _request, _mutation, subject) => {
        subjects.push(`${subject.kind}:${subject.nodeId ?? '-'}`);
        if (subject.plan !== undefined) plans.push(subject.plan);
        return { authorized: true };
      },
    }));
    expect(result).toMatchObject({ state: 'committed' });
    expect(subjects).toEqual(expect.arrayContaining([
      'request-target:-', `affected-node:${nodeId}`, `affected-node:${sourceId}`, `affected-node:${targetId}`,
      'affected-node:anchor-after', 'affected-node:anchor-before',
    ]));
    expect(new Set(subjects).size).toBe(6);
    expect(plans).not.toHaveLength(0);
    expect(plans.every((plan) => Object.isFrozen(plan))).toBe(true);
    expect(plans[0]).toMatchObject({
      collectionId,
      mutation: {
        kind: 'move-node', nodeId, parentId: targetId, afterId: 'anchor-after', beforeId: 'anchor-before',
      },
      authorizationNodeIds: [nodeId, sourceId, targetId, 'anchor-after', 'anchor-before'],
      modifiedNodeIds: [nodeId, sourceId, targetId],
      deletedNodeIds: [],
      deletedNodeCount: 0,
    });
    expect(adapter.snapshot().operations).toEqual([expect.objectContaining({ type: 'move_node' })]);
  });
});
