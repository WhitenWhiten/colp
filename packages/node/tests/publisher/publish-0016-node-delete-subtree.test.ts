import { describe, expect, it } from 'vitest';

import * as publisherModule from '../../src/publisher/index.js';
import { mapPublisherNodeOperation } from '../../src/publisher/index.js';
import { problemRegistry } from '../../src/server/index.js';
import type {
  DeleteOperationPayload,
  DeleteResult,
  DeletionReceipt,
  Operation,
  PrincipalRef,
  StrictNode,
} from '../../src/types/index.js';

const evidence = 'publisher.node-delete-subtree';
const collectionId = 'collection-publish-0016';
const otherCollectionId = 'collection-other';
const rootId = 'root-publish-0016';
const folderId = 'folder-delete';
const childId = 'bookmark-child';
const nestedId = 'folder-nested';
const grandchildId = 'bookmark-grandchild';
const siblingId = 'bookmark-survivor';
const instant = '2026-07-19T13:00:00Z';
const deletedAt = '2026-07-19T13:00:01Z';
const purgeAfter = '2026-08-18T13:00:01Z';
const deleteRevision = 'delete-revision-publish-0016';
const operationId = 'operation-publish-0016';

type ProblemCode = keyof typeof problemRegistry;
type Result =
  | { readonly state: 'committed'; readonly value: DeleteResult }
  | { readonly state: 'rejected'; readonly code: ProblemCode; readonly status: number; readonly retryable: boolean;
      readonly currentRevision?: string; readonly currentEtag?: string };

interface Request {
  readonly ifMatch?: string | readonly string[] | null;
  readonly query: { readonly recursive?: boolean };
  readonly operation: {
    readonly operationId: string;
    readonly replicaId: string;
    readonly sequence: number;
    readonly occurredAt: string;
    readonly collectionId: string;
    readonly action: 'delete';
    readonly targetId: string;
    readonly baseRevision: string;
    readonly payload: DeleteOperationPayload;
  };
}

interface State {
  readonly nodes: Map<string, StrictNode>;
  readonly parentRevisions: Map<string, string>;
  readonly operations: Operation[];
  readonly deletionLedgers: Map<string, readonly string[]>;
  readonly watermarks: Map<string, Readonly<Watermark>>;
  readonly applicationLedgers: Map<string, Readonly<DeletionApplicationLedger>>;
}

interface Watermark {
  readonly resourceType: 'node';
  readonly targetId: string;
  readonly collectionId: string;
  readonly scope: 'single' | 'subtree';
  readonly deletedAt: string;
  readonly deleteRevision: string;
  readonly operationId: string;
  readonly affectedCount: number;
  readonly memberNodeIds: readonly string[];
}

interface DeletionApplicationLedger {
  readonly operationId: string;
  readonly operationType: 'delete_node' | 'delete_subtree';
  readonly targetId: string;
  readonly collectionId: string;
  readonly deleteRevision: string;
  readonly affectedCount: number;
  readonly deletedNodeIds: readonly string[];
  readonly watermark: Watermark;
  readonly receipt: DeletionReceipt;
}

interface DeletionPlanBinding {
  readonly operationId: string;
  readonly operationType: 'delete_node' | 'delete_subtree';
  readonly targetId: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly memberNodeIds: readonly string[];
  readonly affectedCount: number;
}

interface Context {
  readonly draft: State;
  deletionPlan?: DeletionPlanBinding;
  resolveCollection(id: string): Promise<{ readonly id: string; readonly rootNodeId: string } | undefined>;
  resolveNode(id: string): Promise<StrictNode | undefined>;
  resolveChildren(parentId: string, limit: number): Promise<{
    readonly nodes: readonly StrictNode[];
    readonly hasMore: boolean;
  }>;
  bindNodeDeletionPlan(binding: DeletionPlanBinding): Promise<void>;
  resolveNodeDeletionApplication(operationId: string): Promise<DeletionApplicationLedger | undefined>;
}

interface DeletionApplicationResult {
  readonly receipt: DeletionReceipt;
  readonly watermark: Watermark;
  readonly deletedNodeIds: readonly string[];
}

interface Ports {
  readonly unitOfWork: { run<T>(work: (context: Context) => Promise<T>): Promise<T> };
  authenticate(context: Context, request: Readonly<Request>): Promise<{
    readonly authenticated: true;
    readonly identityResolution: {
      readonly status: 'authenticated';
      readonly identities: readonly PrincipalRef[];
      readonly scopes: readonly string[];
    };
  } | { readonly authenticated: false }>;
  authorize(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    subject: { readonly kind: 'request-target' | 'affected-node'; readonly nodeId?: string;
      readonly plan?: Readonly<Record<string, unknown>> },
  ): Promise<{ readonly authorized: true } | { readonly authorized: false; readonly reason: string }>;
  conceal(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    input: { readonly authorized: boolean; readonly subject: { readonly kind: string; readonly nodeId?: string } },
  ): Promise<{ readonly allowed: true } | {
    readonly allowed: false;
    readonly problem: 'insufficient_scope' | 'resource_not_found';
  }>;
  validate(context: Context, request: Readonly<Request>, mutation: Readonly<Record<string, unknown>>):
    Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  evaluatePolicy(
    context: Context,
    request: Readonly<Request>,
    mutation: Readonly<Record<string, unknown>>,
    nodeId: string,
    plan: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>;
  application: {
    deleteNodes(
      operation: Readonly<Operation>,
      authoritativeNodeIds: readonly string[],
      context: Context,
    ): Promise<DeletionApplicationResult>;
    applyOperations(
      batch: { readonly batchId: string; readonly atomic: true; readonly operations: readonly Operation[] },
      context: Context,
    ): Promise<unknown>;
  };
  authorizeRequiredScope(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<Request>,
    requiredScope: 'nodes:delete',
  ): Promise<{ readonly authorized: true } | { readonly authorized: false; readonly reason: string }>;
}

type ExecuteDelete = (
  request: Request,
  ports: Ports,
  limits?: { readonly maxDepth?: number; readonly maxVisitedNodes?: number },
) => Promise<Result>;

// Black-box contract for the new production export. This keeps the TDD suite
// type-safe without adding a temporary implementation or testing a local fake.
const executePublisherNodeDelete = (publisherModule as unknown as {
  readonly executePublisherNodeDelete: ExecuteDelete;
}).executePublisherNodeDelete;

function root(): StrictNode {
  return {
    id: rootId, collectionId, kind: 'root', parentId: null, position: null,
    folderRole: 'root', title: 'Root', createdAt: instant, updatedAt: instant, revision: 'revision-root',
  };
}

function folder(
  id: string,
  parentId = rootId,
  owner = collectionId,
  constraints?: StrictNode['constraints'],
): StrictNode {
  return {
    id, collectionId: owner, kind: 'folder', parentId, position: `position-${id}`,
    folderRole: 'custom', title: id, createdAt: instant, updatedAt: instant,
    revision: `revision-${id}`, ...(constraints === undefined ? {} : { constraints }),
  };
}

function bookmark(
  id: string,
  parentId = rootId,
  owner = collectionId,
  constraints?: StrictNode['constraints'],
): StrictNode {
  return {
    id, collectionId: owner, kind: 'bookmark', parentId, position: `position-${id}`,
    title: id, url: `https://example.test/${id}`, createdAt: instant, updatedAt: instant,
    revision: `revision-${id}`, ...(constraints === undefined ? {} : { constraints }),
  };
}

function tree(): readonly StrictNode[] {
  return [
    root(), folder(folderId), bookmark(childId, folderId), folder(nestedId, folderId),
    bookmark(grandchildId, nestedId), bookmark(siblingId),
  ];
}

function initialState(nodes: readonly StrictNode[] = tree()): State {
  return {
    nodes: new Map(nodes.map((node) => [node.id, structuredClone(node)])),
    parentRevisions: new Map([[rootId, 'children-root-r1'], [folderId, 'children-folder-r1'], [nestedId, 'children-nested-r1']]),
    operations: [], deletionLedgers: new Map(), watermarks: new Map(),
    applicationLedgers: new Map(),
  };
}

function cloneState(state: State): State {
  return {
    nodes: new Map([...state.nodes].map(([id, node]) => [id, structuredClone(node)])),
    parentRevisions: new Map(state.parentRevisions),
    operations: structuredClone(state.operations),
    deletionLedgers: new Map([...state.deletionLedgers].map(([id, ids]) => [id, [...ids]])),
    watermarks: new Map([...state.watermarks].map(([id, value]) => [id, structuredClone(value)])),
    applicationLedgers: new Map([...state.applicationLedgers].map(([id, value]) => [id, structuredClone(value)])),
  };
}

function request(change: Partial<Request> = {}): Request {
  return {
    ifMatch: `\"revision-${folderId}\"`,
    query: { recursive: true },
    operation: {
      operationId, replicaId: 'publisher-server', sequence: 16, occurredAt: instant,
      collectionId, action: 'delete', targetId: folderId, baseRevision: `revision-${folderId}`,
      payload: { reason: 'publisher-delete' },
    },
    ...change,
  };
}

function receipt(
  targetId: string,
  scope: 'single' | 'subtree',
  affectedCount: number,
  appliedOperationId = operationId,
): DeletionReceipt {
  return {
    resourceType: 'node', targetId, collectionId, scope, deletedAt, deletedBy: 'alice',
    deleteRevision, operationId: appliedOperationId, affectedCount, purgeAfter,
  };
}

function watermark(
  targetId: string,
  scope: 'single' | 'subtree',
  affectedCount: number,
  memberNodeIds: readonly string[] = scope === 'single'
    ? [targetId]
    : [folderId, childId, nestedId, grandchildId],
  appliedOperationId = operationId,
): Watermark {
  return {
    resourceType: 'node', targetId, collectionId, scope, deletedAt, deleteRevision,
    operationId: appliedOperationId, affectedCount, memberNodeIds,
  };
}

class AtomicDeleteAdapter {
  private state: State;
  private tail: Promise<void> = Promise.resolve();
  readonly events: string[] = [];
  commit: 'known' | 'unknown-before' | 'unknown-after' = 'known';
  failAfterMutation = false;
  applicationOverride?: Ports['application']['deleteNodes'];
  childResolverOverride?: Context['resolveChildren'];
  nodeResolverOverride?: (this: Context, id: string) => Promise<StrictNode | undefined>;

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
          const pending = adapter.tail.then(run, run);
          adapter.tail = pending.then(() => undefined, () => undefined);
          return pending;
        },
      },
      authenticate: async () => {
        adapter.events.push('authenticate');
        return { authenticated: true, identityResolution: {
          status: 'authenticated', identities: [{ type: 'user', id: 'alice' }], scopes: ['nodes:delete'],
        } };
      },
      authorizeRequiredScope: async (_context, _identities, _request, requiredScope) => {
        adapter.events.push(`scope:${requiredScope}`);
        return { authorized: true };
      },
      authorize: async (_context, _identities, _candidate, mutation, subject) => {
        adapter.events.push(`authorize:${subject.kind}:${subject.nodeId ?? '-'}:${String(mutation.kind)}`);
        return { authorized: true };
      },
      conceal: async (_context, _identities, _candidate, _mutation, input) => {
        adapter.events.push(`conceal:${input.subject.kind}:${input.subject.nodeId ?? '-'}`);
        return { allowed: true };
      },
      validate: async () => { adapter.events.push('validate'); return { allowed: true }; },
      evaluatePolicy: async (_context, _candidate, _mutation, nodeId) => {
        adapter.events.push(`policy:${nodeId}`);
        return { allowed: true };
      },
      application: {
        deleteNodes: async (operation, authoritativeNodeIds, context) => {
          adapter.events.push(`apply:${authoritativeNodeIds.join(',')}`);
          const target = context.draft.nodes.get(operation.targetId!);
          if (target === undefined || target.parentId === null) throw new Error('missing ordinary target');
          for (const id of authoritativeNodeIds) context.draft.nodes.delete(id);
          context.draft.parentRevisions.set(target.parentId, 'children-root-r2');
          context.draft.operations.push(structuredClone(operation));
          context.draft.deletionLedgers.set(operation.opId, Object.freeze([...authoritativeNodeIds]));
          const scope = operation.type === 'delete_subtree' ? 'subtree' : 'single';
          const durable = watermark(
            operation.targetId!, scope, authoritativeNodeIds.length, authoritativeNodeIds, operation.opId,
          );
          context.draft.watermarks.set(operation.opId, durable);
          if (adapter.failAfterMutation) throw new Error('persistence failure');
          return {
            receipt: receipt(operation.targetId!, scope, authoritativeNodeIds.length, operation.opId),
            watermark: durable,
            deletedNodeIds: Object.freeze([...authoritativeNodeIds]),
          };
        },
        async applyOperations(batch, context) {
          if (batch.atomic !== true || batch.operations.length !== 1) throw new Error('non-canonical batch');
          const operation = batch.operations[0]!;
          const binding = context.deletionPlan;
          if (binding === undefined
            || binding.operationId !== operation.opId
            || binding.operationType !== operation.type
            || binding.targetId !== operation.targetId
            || binding.collectionId !== operation.collectionId
            || binding.affectedCount !== binding.memberNodeIds.length) {
            throw new Error('missing or mismatched Core deletion binding');
          }
          const value = adapter.applicationOverride === undefined
            ? await this.deleteNodes(operation, binding.memberNodeIds, context)
            : await adapter.applicationOverride(operation, binding.memberNodeIds, context);
          const ledger: DeletionApplicationLedger = {
            operationId: operation.opId,
            operationType: operation.type as 'delete_node' | 'delete_subtree',
            targetId: operation.targetId!,
            collectionId: operation.collectionId,
            deleteRevision: value.receipt.deleteRevision,
            affectedCount: value.deletedNodeIds.length,
            deletedNodeIds: value.deletedNodeIds,
            watermark: value.watermark,
            receipt: value.receipt,
          };
          context.draft.applicationLedgers.set(operation.opId, structuredClone(ledger));
          return {
            batchId: batch.batchId,
            results: [{
              opId: operation.opId, sequence: operation.sequence, status: 'applied',
              targetId: operation.targetId, revision: deleteRevision,
              cursor: 'internal-operation-cursor', warnings: [],
            }],
            serverCursor: 'internal-batch-cursor',
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
      async resolveNode(id) {
        adapter.events.push(`node:${id}`);
        return adapter.nodeResolverOverride?.call(this, id) ?? draft.nodes.get(id);
      },
      async resolveChildren(parentId, limit) {
        adapter.events.push(`children:${parentId}:${limit}`);
        if (adapter.childResolverOverride !== undefined) {
          return adapter.childResolverOverride.call(this, parentId, limit);
        }
        const nodes = [...draft.nodes.values()].filter((node) => node.parentId === parentId)
          .sort((left, right) => (left.position ?? '').localeCompare(right.position ?? ''));
        return { nodes: nodes.slice(0, limit), hasMore: nodes.length > limit };
      },
      async bindNodeDeletionPlan(binding) {
        adapter.events.push(`bind:${binding.memberNodeIds.join(',')}`);
        if (this.deletionPlan !== undefined) throw new Error('deletion plan already bound');
        this.deletionPlan = structuredClone(binding);
      },
      async resolveNodeDeletionApplication(id) {
        adapter.events.push(`ledger:${id}`);
        return draft.applicationLedgers.get(id);
      },
    };
  }
}

const rejected = (code: ProblemCode) => ({ state: 'rejected', code, ...problemRegistry[code] });
const noDelete = (state: State) => {
  expect(state.operations).toEqual([]);
  expect(state.deletionLedgers).toEqual(new Map());
  expect(state.watermarks).toEqual(new Map());
  expect(state.applicationLedgers).toEqual(new Map());
};

describe(`PUBLISH-0016 Node delete subtree [evidence:${evidence}]`, () => {
  it(`[success] [transaction] recursively deletes the exact authoritative multi-level subtree [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    const state = adapter.snapshot();
    const deletedIds = [folderId, childId, nestedId, grandchildId];

    expect(result).toEqual({ state: 'committed', value: { receipt: receipt(folderId, 'subtree', 4) } });
    expect(state.nodes).toEqual(new Map([[rootId, root()], [siblingId, bookmark(siblingId)]]));
    expect(state.parentRevisions.get(rootId)).toBe('children-root-r2');
    expect(state.operations).toEqual([{
      opId: operationId, replicaId: 'publisher-server', sequence: 16, type: 'delete_subtree',
      occurredAt: instant, collectionId, targetId: folderId, baseRevision: `revision-${folderId}`,
      payload: { reason: 'publisher-delete' },
    }]);
    expect(state.deletionLedgers.get(operationId)).toEqual(deletedIds);
    expect(state.watermarks.get(operationId)).toEqual(watermark(folderId, 'subtree', 4));
    expect(result).not.toHaveProperty('value.cursor');
    expect(result).not.toHaveProperty('value.serverCursor');
  });

  it.each([
    ['Bookmark leaf', bookmark(childId), [root(), bookmark(childId), bookmark(siblingId)]],
    ['empty Folder', folder(folderId), [root(), folder(folderId), bookmark(siblingId)]],
  ] as const)(`[success] [boundary] non-recursive deletion supports %s with single scope [evidence:${evidence}]`, async (_label, target, nodes) => {
    const adapter = new AtomicDeleteAdapter(initialState(nodes));
    const command = request({
      ifMatch: `\"${target.revision}\"`, query: {},
      operation: { ...request().operation, targetId: target.id, baseRevision: target.revision },
    });
    const result = await executePublisherNodeDelete(command, adapter.ports());
    expect(result).toEqual({ state: 'committed', value: { receipt: receipt(target.id, 'single', 1) } });
    expect(adapter.snapshot().operations[0]?.type).toBe('delete_node');
    expect(adapter.snapshot().deletionLedgers.get(operationId)).toEqual([target.id]);
    expect(adapter.snapshot().nodes.has(siblingId)).toBe(true);
  });

  it.each([
    ['omitted', {}, 'delete_node'],
    ['false', { recursive: false }, 'delete_node'],
    ['true', { recursive: true }, 'delete_subtree'],
  ] as const)(`[boundary] maps exact recursive query %s to %s [evidence:${evidence}]`, async (_label, query, expectedType) => {
    const nodes = expectedType === 'delete_node' ? [root(), folder(folderId), bookmark(siblingId)] : tree();
    const adapter = new AtomicDeleteAdapter(initialState(nodes));
    await executePublisherNodeDelete(request({ query }), adapter.ports());
    expect(adapter.snapshot().operations).toHaveLength(1);
    expect(adapter.snapshot().operations[0]?.type).toBe(expectedType);
  });

  it.each([
    ['unknown query member', { query: { recursive: true, cursor: 'caller-cursor' } }],
    ['string recursive', { query: { recursive: 'true' } }],
    ['numeric recursive', { query: { recursive: 1 } }],
    ['caller descendants', { descendants: [childId] }],
    ['operation descendants', { operation: { ...request().operation, descendants: [childId] } }],
  ])(`[negative] [boundary] rejects %s before graph traversal or persistence [evidence:${evidence}]`, async (_label, change) => {
    const adapter = new AtomicDeleteAdapter();
    const result = await executePublisherNodeDelete({ ...request(), ...change } as never, adapter.ports());
    expect(result).toEqual(rejected('invalid_document'));
    expect(adapter.events.some((event) => event.startsWith('children:'))).toBe(false);
    noDelete(adapter.snapshot());
  });

  it(`[negative] [boundary] requires nodes:delete and does not accept nodes:write as a substitute [evidence:${evidence}]`, async () => {
    const writeOnly = new AtomicDeleteAdapter();
    const denied = await executePublisherNodeDelete(request(), writeOnly.ports({
      authenticate: async () => ({ authenticated: true, identityResolution: {
        status: 'authenticated', identities: [{ type: 'user', id: 'alice' }], scopes: ['nodes:write'],
      } }),
      authorizeRequiredScope: async (_context, _identities, _request, requiredScope) => (
        requiredScope === 'nodes:delete'
          ? { authorized: false, reason: 'required scope absent' }
          : { authorized: true }
      ),
      conceal: async () => ({ allowed: false, problem: 'insufficient_scope' }),
    }));
    expect(denied).toEqual(rejected('insufficient_scope'));
    expect(writeOnly.events.some((event) => event.startsWith('children:'))).toBe(false);
    noDelete(writeOnly.snapshot());

    const deleteOnly = new AtomicDeleteAdapter();
    await executePublisherNodeDelete(request(), deleteOnly.ports({
      authenticate: async () => ({ authenticated: true, identityResolution: {
        status: 'authenticated', identities: [{ type: 'user', id: 'alice' }], scopes: ['nodes:delete'],
      } }),
      authorizeRequiredScope: async (_context, _identities, _request, requiredScope) => (
        requiredScope === 'nodes:delete'
          ? { authorized: true }
          : { authorized: false, reason: 'unexpected scope' }
      ),
    }));
    expect(deleteOnly.snapshot().operations[0]?.type).toBe('delete_subtree');
  });

  it.each([
    ['visible denial', 'insufficient_scope'],
    ['concealed denial', 'resource_not_found'],
  ] as const)(`[negative] [boundary] applies target concealment for %s [evidence:${evidence}]`, async (_label, code) => {
    const adapter = new AtomicDeleteAdapter();
    const result = await executePublisherNodeDelete(request(), adapter.ports({
      authorize: async () => ({ authorized: false, reason: 'secret authorization reason' }),
      conceal: async () => ({ allowed: false, problem: code }),
    }));
    expect(result).toEqual(rejected(code));
    noDelete(adapter.snapshot());
  });

  it.each([
    ['missing', undefined, 'precondition_required'],
    ['null', null, 'precondition_required'],
    ['malformed repeated', [`\"revision-${folderId}\"`, `revision-${folderId}`], 'precondition_failed'],
    ['bare', `revision-${folderId}`, 'precondition_failed'],
    ['weak', `W/\"revision-${folderId}\"`, 'precondition_failed'],
    ['stale', '"revision-stale"', 'precondition_failed'],
  ] as const)(`[negative] [boundary] rejects %s Node If-Match atomically [evidence:${evidence}]`, async (_label, ifMatch, code) => {
    const adapter = new AtomicDeleteAdapter();
    const command = { ...request(), ifMatch } as Request;
    if (ifMatch === undefined) delete (command as { ifMatch?: Request['ifMatch'] }).ifMatch;
    const result = await executePublisherNodeDelete(command, adapter.ports());
    expect(result).toEqual({
      ...rejected(code), currentRevision: `revision-${folderId}`, currentEtag: `\"revision-${folderId}\"`,
    });
    noDelete(adapter.snapshot());
  });

  it(`[negative] [boundary] forbids Root deletion for either query mode [evidence:${evidence}]`, async () => {
    for (const query of [{}, { recursive: true }]) {
      const adapter = new AtomicDeleteAdapter();
      const result = await executePublisherNodeDelete(request({
        ifMatch: '"revision-root"', query,
        operation: { ...request().operation, targetId: rootId, baseRevision: 'revision-root' },
      }), adapter.ports());
      expect(result).toEqual(rejected('invalid_document'));
      noDelete(adapter.snapshot());
    }
  });

  it(`[negative] [boundary] rejects a non-empty Folder without recursive=true [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    const result = await executePublisherNodeDelete(request({ query: {} }), adapter.ports());
    expect(result).toEqual(rejected('folder_not_empty'));
    noDelete(adapter.snapshot());
  });

  it(`[transaction] ignores adapter descendant hints and traverses authoritative relations [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    const ports = adapter.ports() as Ports & { descendants?: readonly string[] };
    ports.descendants = [folderId, 'attacker-selected-only'];
    (ports.application as Ports['application'] & { descendants?: readonly string[] }).descendants = [childId];
    await executePublisherNodeDelete(request(), ports);
    expect(adapter.snapshot().deletionLedgers.get(operationId)).toEqual([folderId, childId, nestedId, grandchildId]);
    expect(adapter.snapshot().nodes.has(siblingId)).toBe(true);
  });

  it.each([
    ['cycle', (adapter: AtomicDeleteAdapter) => {
      adapter.childResolverOverride = async (parentId) => parentId === folderId
        ? { nodes: [folder(nestedId, folderId)], hasMore: false }
        : { nodes: [folder(folderId, nestedId)], hasMore: false };
    }, 'internal_error'],
    ['cross Collection child', (adapter: AtomicDeleteAdapter) => {
      adapter.childResolverOverride = async (parentId) => parentId === folderId
        ? { nodes: [bookmark(childId, folderId, otherCollectionId)], hasMore: false }
        : { nodes: [], hasMore: false };
    }, 'invalid_document'],
    ['malformed parent relation', (adapter: AtomicDeleteAdapter) => {
      adapter.childResolverOverride = async (parentId) => parentId === folderId
        ? { nodes: [bookmark(childId, nestedId)], hasMore: false }
        : { nodes: [], hasMore: false };
    }, 'internal_error'],
    ['partial page', (adapter: AtomicDeleteAdapter) => {
      adapter.childResolverOverride = async () => ({ nodes: [], hasMore: true });
    }, 'payload_too_large'],
  ] as const)(`[negative] [boundary] rejects authoritative traversal %s [evidence:${evidence}]`, async (_label, arrange, code) => {
    const adapter = new AtomicDeleteAdapter();
    arrange(adapter);
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected(code));
    noDelete(adapter.snapshot());
  });

  it(`[negative] [boundary] rejects traversal beyond depth and member ceilings [evidence:${evidence}]`, async () => {
    const depth = new AtomicDeleteAdapter();
    const depthResult = await executePublisherNodeDelete(request(), depth.ports(), { maxDepth: 1 });
    expect(depthResult).toEqual(rejected('payload_too_large'));
    noDelete(depth.snapshot());

    const members = new AtomicDeleteAdapter();
    const memberResult = await executePublisherNodeDelete(request(), members.ports(), { maxVisitedNodes: 3 });
    expect(memberResult).toEqual(rejected('payload_too_large'));
    noDelete(members.snapshot());
  });

  it.each([
    ['member authorization', childId, 'authorize'],
    ['member policy', nestedId, 'policy'],
  ] as const)(`[negative] [transaction] rolls back on per-member %s denial [evidence:${evidence}]`, async (_label, deniedId, gate) => {
    const adapter = new AtomicDeleteAdapter();
    const result = await executePublisherNodeDelete(request(), adapter.ports({
      authorize: async (_context, _identities, _candidate, _mutation, subject) => (
        gate === 'authorize' && subject.nodeId === deniedId
          ? { authorized: false, reason: 'member denied' }
          : { authorized: true }
      ),
      conceal: async (_context, _identities, _candidate, _mutation, input) => (
        input.authorized ? { allowed: true } : { allowed: false, problem: 'insufficient_scope' }
      ),
      evaluatePolicy: async (_context, _candidate, _mutation, nodeId) => (
        gate === 'policy' && nodeId === deniedId
          ? { allowed: false, reason: 'policy denied' }
          : { allowed: true }
      ),
    }));
    expect(result).toEqual(rejected('insufficient_scope'));
    noDelete(adapter.snapshot());
  });

  it.each([
    ['target constraint', folder(folderId, rootId, collectionId, { readOnly: true, reason: 'locked target' })],
    ['descendant constraint', bookmark(childId, folderId, collectionId, { readOnly: true, reason: 'locked child' })],
  ] as const)(`[negative] [transaction] enforces per-member read-only for %s [evidence:${evidence}]`, async (_label, replacement) => {
    const nodes = tree().map((node) => node.id === replacement.id ? replacement : node);
    const adapter = new AtomicDeleteAdapter(initialState(nodes));
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected('node_read_only'));
    noDelete(adapter.snapshot());
  });

  it(`[transaction] authorizes and checks policy for every derived member before application [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    await executePublisherNodeDelete(request(), adapter.ports());
    for (const id of [folderId, childId, nestedId, grandchildId]) {
      expect(adapter.events).toContain(`authorize:affected-node:${id}:delete-subtree`);
      expect(adapter.events).toContain(`policy:${id}`);
    }
    const applyIndex = adapter.events.findIndex((event) => event.startsWith('apply:'));
    expect(applyIndex).toBeGreaterThan(adapter.events.lastIndexOf(`policy:${grandchildId}`));
  });

  it.each([
    ['missing member', [folderId, childId, nestedId]],
    ['extra member', [folderId, childId, nestedId, grandchildId, siblingId]],
    ['duplicate member', [folderId, childId, nestedId, grandchildId, childId]],
    ['mismatched member', [folderId, childId, nestedId, siblingId]],
  ] as const)(`[negative] [transaction] rolls back an application ledger with %s [evidence:${evidence}]`, async (_label, reported) => {
    const adapter = new AtomicDeleteAdapter();
    const ordinary = adapter.ports().application.deleteNodes;
    adapter.applicationOverride = async (operation, members, context) => {
      const value = await ordinary(operation, members, context);
      context.draft.deletionLedgers.set(operation.opId, reported);
      return { ...value, deletedNodeIds: reported };
    };
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected('internal_error'));
    expect(adapter.snapshot().nodes.has(folderId)).toBe(true);
    noDelete(adapter.snapshot());
  });

  it.each([
    ['receipt affectedCount', (value: DeletionApplicationResult) => ({ ...value, receipt: { ...value.receipt, affectedCount: 3 } })],
    ['receipt scope', (value: DeletionApplicationResult) => ({ ...value, receipt: { ...value.receipt, scope: 'single' as const } })],
    ['receipt target ID', (value: DeletionApplicationResult) => ({ ...value, receipt: { ...value.receipt, targetId: childId } })],
    ['receipt revision', (value: DeletionApplicationResult) => ({ ...value, receipt: { ...value.receipt, deleteRevision: 'wrong-revision' } })],
    ['receipt operation ID', (value: DeletionApplicationResult) => ({ ...value, receipt: { ...value.receipt, operationId: 'wrong-operation' } })],
    ['watermark count', (value: DeletionApplicationResult) => ({ ...value, watermark: { ...value.watermark, affectedCount: 3 } })],
    ['watermark identity', (value: DeletionApplicationResult) => ({ ...value, watermark: { ...value.watermark, targetId: childId } })],
    ['watermark missing member', (value: DeletionApplicationResult) => ({
      ...value, watermark: { ...value.watermark, memberNodeIds: [folderId, childId, nestedId] },
    })],
    ['watermark extra member', (value: DeletionApplicationResult) => ({
      ...value, watermark: { ...value.watermark, memberNodeIds: [...value.watermark.memberNodeIds, siblingId] },
    })],
    ['watermark duplicate member', (value: DeletionApplicationResult) => ({
      ...value, watermark: { ...value.watermark, memberNodeIds: [...value.watermark.memberNodeIds, childId] },
    })],
  ] as const)(`[negative] [transaction] rolls back mismatched %s [evidence:${evidence}]`, async (_label, mutate) => {
    const adapter = new AtomicDeleteAdapter();
    const ordinary = adapter.ports().application.deleteNodes;
    adapter.applicationOverride = async (operation, members, context) => mutate(await ordinary(operation, members, context));
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected('internal_error'));
    noDelete(adapter.snapshot());
  });

  it(`[negative] [transaction] detects resolver TOCTOU and rolls back [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    let targetReads = 0;
    adapter.nodeResolverOverride = async function (id) {
      const current = this.draft.nodes.get(id);
      if (id !== folderId || current === undefined || ++targetReads === 1) return current;
      return { ...current, collectionId: otherCollectionId } as StrictNode;
    };
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected('internal_error'));
    expect(adapter.snapshot().nodes.get(folderId)?.collectionId).toBe(collectionId);
    noDelete(adapter.snapshot());
  });

  it(`[concurrency] serializes racers so only one matching Node revision can delete [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    const first = executePublisherNodeDelete(request(), adapter.ports());
    const second = executePublisherNodeDelete(request({
      operation: { ...request().operation, operationId: 'operation-racer', sequence: 17 },
    }), adapter.ports());
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.state === 'committed')).toHaveLength(1);
    expect(results.filter((result) => result.state === 'rejected')).toHaveLength(1);
    expect(adapter.snapshot().operations).toHaveLength(1);
    expect(adapter.snapshot().deletionLedgers.size).toBe(1);
  });

  it.each(['unknown-before', 'unknown-after'] as const)(`[transaction] fails closed for %s commit outcome [evidence:${evidence}]`, async (commit) => {
    const adapter = new AtomicDeleteAdapter();
    adapter.commit = commit;
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected('internal_error'));
    const state = adapter.snapshot();
    if (commit === 'unknown-before') noDelete(state);
    else {
      expect(state.operations).toHaveLength(1);
      expect(state.deletionLedgers.get(operationId)).toEqual([folderId, childId, nestedId, grandchildId]);
    }
  });

  it(`[negative] [transaction] rolls back a persistence failure after draft mutation [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    adapter.failAfterMutation = true;
    const result = await executePublisherNodeDelete(request(), adapter.ports());
    expect(result).toEqual(rejected('internal_error'));
    expect(adapter.snapshot().nodes.has(folderId)).toBe(true);
    noDelete(adapter.snapshot());
  });

  it(`[negative] [boundary] snapshots request input across asynchronous gates [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    const command = request();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = executePublisherNodeDelete(command, adapter.ports({
      validate: async () => { entered(); await gate; return { allowed: true }; },
    }));
    await started;
    (command.query as { recursive?: boolean }).recursive = false;
    (command.operation as { targetId: string }).targetId = siblingId;
    release();
    const result = await pending;
    expect(result).toMatchObject({ state: 'committed', value: { receipt: { targetId: folderId, scope: 'subtree' } } });
    expect(adapter.snapshot().nodes.has(siblingId)).toBe(true);
  });

  it(`[negative] [boundary] fails closed on hostile Promise, Proxy, and accessor ports [evidence:${evidence}]`, async () => {
    const adapter = new AtomicDeleteAdapter();
    await expect(executePublisherNodeDelete(request(), adapter.ports({
      authenticate: (() => ({ then: () => undefined })) as never,
    }))).resolves.toEqual(rejected('internal_error'));
    await expect(executePublisherNodeDelete(request(), new Proxy(adapter.ports(), {})))
      .resolves.toEqual(rejected('internal_error'));
    const accessor = adapter.ports();
    Object.defineProperty(accessor, 'authorize', {
      enumerable: true, get() { throw new Error('hostile accessor'); },
    });
    await expect(executePublisherNodeDelete(request(), accessor)).resolves.toEqual(rejected('internal_error'));
    await Promise.resolve();
    noDelete(adapter.snapshot());
  });

  it(`[regression] preserves P5/P11/P13 and Core canonical delete guards [evidence:${evidence}]`, () => {
    const single = mapPublisherNodeOperation(request({ query: {} }).operation);
    expect(single).toEqual({
      opId: operationId, replicaId: 'publisher-server', sequence: 16, type: 'delete_node',
      occurredAt: instant, collectionId, targetId: folderId, baseRevision: `revision-${folderId}`,
      payload: { reason: 'publisher-delete' },
    });
    expect(Object.isFrozen(single)).toBe(true);
    expect(mapPublisherNodeOperation({ ...request().operation, action: 'delete_subtree' } as never)).toEqual({
      opId: operationId, replicaId: 'publisher-server', sequence: 16, type: 'delete_subtree',
      occurredAt: instant, collectionId, targetId: folderId, baseRevision: `revision-${folderId}`,
      payload: { reason: 'publisher-delete' },
    });
  });
});
