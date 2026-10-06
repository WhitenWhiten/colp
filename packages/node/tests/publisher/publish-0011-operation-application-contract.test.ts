import { describe, expect, it, vi } from 'vitest';

import {
  applyPublisherOperations,
  mapPublisherNodeOperation,
  mapPublisherOperation,
  type PublisherNodeOperationRequest,
  type PublisherOperationApplicationPort,
  type PublisherOperationBatch,
  type PublisherSidecarOperationRequest,
  type PublisherWritableOperation,
} from '../../src/publisher/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type { Operation, OperationResult } from '../../src/types/index.js';

const evidence = 'publisher.operation-application';
const validators = createValidatorRegistry();

const envelope = {
  operationId: 'op-publish-0011',
  replicaId: 'publisher-server',
  sequence: 41,
  collectionId: 'collection-a',
  occurredAt: '2026-07-19T10:00:00Z',
} as const;

const nodeCases: readonly [
  PublisherNodeOperationRequest['action'],
  Operation['type'],
  PublisherNodeOperationRequest['payload'],
][] = [
  ['create', 'create_node', {
    parentId: 'root-a',
    node: { kind: 'folder', title: 'Folder', folderRole: 'custom', extensions: {} },
  }],
  ['update_content', 'update_node_content', {
    base: { title: 'Before' }, value: { title: 'After' },
  }],
  ['move', 'move_node', {
    newParentId: 'folder-b',
    baseSourceParentRevision: 'children-r1',
    baseTargetParentRevision: 'children-r2',
  }],
  ['reorder_children', 'reorder_children', {
    parentId: 'folder-a', childIds: ['node-a', 'node-b'], baseChildrenRevision: 'children-r1',
  }],
  ['delete', 'delete_node', { reason: 'publisher-delete' }],
  ['delete_subtree', 'delete_subtree', { reason: 'publisher-delete' }],
  ['restore', 'restore_node', { newParentId: 'folder-a', reason: 'publisher-restore' }],
];

function nodeRequest(
  action: PublisherNodeOperationRequest['action'] = 'update_content',
  sequence: number = envelope.sequence,
): PublisherNodeOperationRequest {
  const entry = nodeCases.find(([candidate]) => candidate === action);
  if (entry === undefined) throw new Error(`Unknown test action: ${action}`);
  const payload = structuredClone(entry[2]);
  if (action === 'create') {
    return { ...envelope, operationId: `${envelope.operationId}-${sequence}`, sequence, action, baseRevision: null, payload } as PublisherNodeOperationRequest;
  }
  return {
    ...envelope,
    operationId: `${envelope.operationId}-${sequence}`,
    sequence,
    action,
    targetId: 'node-a',
    baseRevision: 'node-r1',
    payload,
  } as PublisherNodeOperationRequest;
}

function nodeOperation(action: PublisherNodeOperationRequest['action'] = 'update_content', sequence: number = envelope.sequence): PublisherWritableOperation {
  return mapPublisherNodeOperation(nodeRequest(action, sequence));
}

function applied(operation: PublisherWritableOperation, overrides: Partial<OperationResult> = {}): OperationResult {
  return {
    opId: operation.opId,
    sequence: operation.sequence,
    status: 'applied',
    ...('targetId' in operation ? { targetId: operation.targetId } : { targetId: 'server-node-a' }),
    revision: `revision-${operation.sequence}`,
    cursor: `cursor-${operation.sequence}`,
    warnings: [],
    ...overrides,
  } as OperationResult;
}

function batch(...operations: PublisherWritableOperation[]): PublisherOperationBatch {
  if (operations.length === 0) operations.push(nodeOperation());
  return { batchId: 'publisher-batch-1', atomic: true, operations: operations as [PublisherWritableOperation, ...PublisherWritableOperation[]] };
}

function successfulPort(
  implementation?: (candidate: PublisherOperationBatch, context: unknown) => unknown,
): PublisherOperationApplicationPort<unknown> & { applyOperations: ReturnType<typeof vi.fn> } {
  const applyOperations = vi.fn(async (candidate: PublisherOperationBatch, context: unknown) => implementation?.(candidate, context) ?? ({
    batchId: candidate.batchId,
    results: candidate.operations.map((operation) => applied(operation)),
    serverCursor: 'cursor-server',
  }));
  return { applyOperations };
}

function excludedOperation(
  type: 'create_collection' | 'update_collection_metadata' | 'delete_collection' | 'restore_collection' | 'publish_release',
): Operation {
  const common = {
    opId: `op-excluded-${type}`,
    replicaId: 'publisher-server',
    sequence: 61,
    occurredAt: envelope.occurredAt,
  } as const;
  if (type === 'create_collection') {
    return {
      ...common,
      sequence: 1,
      type,
      baseRevision: null,
      payload: {
        collection: { kind: 'knowledge_collection', title: 'Collection', visibility: 'private' },
        root: { title: 'Root', folderRole: 'root' },
      },
    };
  }
  const payload = type === 'update_collection_metadata'
    ? { base: { title: 'Before' }, value: { title: 'After' } }
    : type === 'restore_collection' || type === 'publish_release'
      ? {}
      : { reason: 'publisher-delete' };
  return {
    ...common,
    collectionId: 'collection-a',
    targetId: 'collection-a',
    baseRevision: 'collection-r1',
    type,
    payload,
  } as Operation;
}

const sidecarCreates = {
  annotation: {
    annotation: {
      format: 'plain', type: 'note', value: 'note',
      subject: { type: 'node', id: 'node-a' }, visibility: 'private', extensions: {},
    },
  },
  attachment: {
    attachment: {
      subject: { type: 'node', id: 'node-a' }, rel: 'enclosure', title: 'file.txt',
      mimeType: 'text/plain', url: 'https://example.test/file.txt', visibility: 'private', extensions: {},
    },
  },
  relation: {
    relation: {
      type: 'supports', fromNodeId: 'node-a', toNodeId: 'node-b', visibility: 'private', extensions: {},
    },
  },
} as const;

describe(`PUBLISH-0011 unified Publisher Operation application path [evidence:${evidence}]`, () => {
  it.each(nodeCases)(`maps Node %s to canonical %s [evidence:${evidence}]`, (action, expectedType) => {
    const operation = nodeOperation(action);
    expect(operation.type).toBe(expectedType);
    expect(operation.collectionId).toBe(envelope.collectionId);
    expect(operation.baseRevision).toBe(action === 'create' ? null : 'node-r1');
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.payload)).toBe(true);
  });

  it.each([
    ['annotation', 'create_annotation'],
    ['attachment', 'create_attachment'],
    ['relation', 'create_relation'],
  ] as const)(`routes %s writes through the same canonical mapper as %s [evidence:${evidence}]`, (sidecar, expectedType) => {
    const request = {
      ...envelope,
      operationId: `${envelope.operationId}-${sidecar}`,
      sidecar,
      action: 'create',
      baseRevision: null,
      payload: sidecarCreates[sidecar],
    } as PublisherSidecarOperationRequest;
    expect(mapPublisherOperation(request)).toMatchObject({ type: expectedType, collectionId: 'collection-a' });
  });

  it(`rejects illegal Node envelopes, Root creation, and mismatched typed updates [evidence:${evidence}]`, () => {
    expect(() => mapPublisherNodeOperation({ ...nodeRequest('create'), targetId: 'node-a' } as never)).toThrow();
    expect(() => mapPublisherNodeOperation({ ...nodeRequest('create'), baseRevision: 'revision-a' } as never)).toThrow();
    expect(() => mapPublisherNodeOperation({ ...nodeRequest('move'), targetId: undefined } as never)).toThrow();
    expect(() => mapPublisherNodeOperation({ ...nodeRequest('delete'), baseRevision: null } as never)).toThrow();
    expect(() => mapPublisherNodeOperation({ ...nodeRequest('create'), payload: { parentId: 'root-a', node: { kind: 'folder', title: 'Root', folderRole: 'root' } } } as never)).toThrow();
    expect(() => mapPublisherNodeOperation({ ...nodeRequest('update_content'), payload: { base: { title: 'a' }, value: { tags: ['b'] } } } as never)).toThrow();
    expect(() => mapPublisherNodeOperation({ ...nodeRequest(), action: 'publish_release' } as never)).toThrow();
  });

  it(`invokes exactly one applyOperations capability with an immutable atomic snapshot [evidence:${evidence}]`, async () => {
    const operation = nodeOperation('move');
    const candidate = batch(operation);
    const context = { principalId: 'principal-a', transport: 'http' };
    const port = successfulPort((received, receivedContext) => {
      expect(received).not.toBe(candidate);
      expect(received.operations).not.toBe(candidate.operations);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.operations)).toBe(true);
      expect(Object.isFrozen(received.operations[0]!.payload)).toBe(true);
      expect(receivedContext).toBe(context);
      return undefined;
    });
    const result = await applyPublisherOperations(port, candidate, context);
    expect(port.applyOperations).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ batchId: 'publisher-batch-1', serverCursor: 'cursor-server' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
  });

  it.each(['http', 'sync', 'mcp'])(`uses the same application capability for %s composition [evidence:${evidence}]`, async (transport) => {
    const port = successfulPort();
    await expect(applyPublisherOperations(port, batch(nodeOperation()), { transport })).resolves.toMatchObject({ batchId: 'publisher-batch-1' });
    expect(port.applyOperations).toHaveBeenCalledOnce();
    expect(port.applyOperations.mock.calls[0]?.[1]).toEqual({ transport });
  });

  it(`does not expose or invoke a transport-specific direct resource mutation path [evidence:${evidence}]`, async () => {
    const resources = vi.fn(() => { throw new Error('direct resource path invoked'); });
    const port = { ...successfulPort(), resources };
    await expect(applyPublisherOperations(port, batch(nodeOperation()), {})).resolves.toMatchObject({ results: [{ status: 'applied' }] });
    expect(resources).not.toHaveBeenCalled();
    expect(Object.keys(port).sort()).toEqual(['applyOperations', 'resources']);
  });

  it(`rejects non-atomic, empty, duplicate, malformed, and extra-field batches before invoking the port [evidence:${evidence}]`, async () => {
    const port = successfulPort();
    const operation = nodeOperation();
    await expect(applyPublisherOperations(port, { ...batch(operation), atomic: false }, {})).rejects.toThrow(/must be atomic/u);
    await expect(applyPublisherOperations(port, { ...batch(operation), operations: [] } as never, {})).rejects.toThrow(/at least one/u);
    await expect(applyPublisherOperations(port, batch(operation, operation), {})).rejects.toThrow(/repeats/u);
    await expect(applyPublisherOperations(port, { ...batch(operation), unexpected: true } as never, {})).rejects.toThrow(/unknown or missing/u);
    await expect(applyPublisherOperations(port, { ...batch(operation), operations: [{ ...operation, sequence: 0 }] } as never, {})).rejects.toThrow(/canonical/u);
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it.each([
    'create_collection', 'update_collection_metadata', 'delete_collection', 'restore_collection', 'publish_release',
  ] as const)(`excludes the exceptional %s path from generic applyOperations [evidence:${evidence}]`, async (type) => {
    const port = successfulPort();
    const operation = excludedOperation(type);
    expect(validators.validate('operation', operation)).toEqual({ valid: true, errors: [] });
    await expect(applyPublisherOperations(port, batch(operation as PublisherWritableOperation), {})).rejects.toThrow();
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it(`propagates application failures and rejects missing, throwing, and non-Promise ports fail closed [evidence:${evidence}]`, async () => {
    const candidate = batch(nodeOperation());
    await expect(applyPublisherOperations(null as never, candidate, {})).rejects.toThrow(/port is required/u);
    await expect(applyPublisherOperations({ applyOperations: (() => ({ ok: true })) as never }, candidate, {})).rejects.toThrow(/must return a Promise/u);
    await expect(applyPublisherOperations({ applyOperations: async () => { throw new Error('transaction rolled back'); } }, candidate, {})).rejects.toThrow(/transaction rolled back/u);
    await expect(applyPublisherOperations({ applyOperations: (() => { throw new Error('sync failure'); }) as never }, candidate, {})).rejects.toThrow(/sync failure/u);
  });

  it.each([
    ['wrong batch', (candidate: PublisherOperationBatch) => ({ batchId: 'other', results: candidate.operations.map((operation) => applied(operation)), serverCursor: 'cursor' })],
    ['partial results', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: [], serverCursor: 'cursor' })],
    ['wrong opId', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: [applied(candidate.operations[0]!, { opId: 'other' })], serverCursor: 'cursor' })],
    ['wrong sequence', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: [applied(candidate.operations[0]!, { sequence: 99 })], serverCursor: 'cursor' })],
    ['wrong target', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: [applied(candidate.operations[0]!, { targetId: 'node-other' })], serverCursor: 'cursor' })],
    ['invalid result schema', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: [{ opId: candidate.operations[0]!.opId, sequence: candidate.operations[0]!.sequence, status: 'applied', warnings: [] }], serverCursor: 'cursor' })],
    ['extra result field', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: candidate.operations.map((operation) => applied(operation)), serverCursor: 'cursor', extra: true })],
    ['invalid server cursor', (candidate: PublisherOperationBatch) => ({ batchId: candidate.batchId, results: candidate.operations.map((operation) => applied(operation)), serverCursor: '' })],
  ] as const)(`rejects %s adapter output without returning partial success [evidence:${evidence}]`, async (_label, resultFactory) => {
    const candidate = batch(nodeOperation());
    const port = successfulPort((received) => resultFactory(received));
    await expect(applyPublisherOperations(port, candidate, {})).rejects.toThrow();
  });

  it(`rejects reordered multi-operation results and accepts registered conflict/rejection outcomes [evidence:${evidence}]`, async () => {
    const first = nodeOperation('move', 51);
    const second = nodeOperation('delete', 52);
    const candidate = batch(first, second);
    const reordered = successfulPort((received) => ({
      batchId: received.batchId,
      results: [applied(received.operations[1]!), applied(received.operations[0]!)],
      serverCursor: 'cursor',
    }));
    await expect(applyPublisherOperations(reordered, candidate, {})).rejects.toThrow(/misordered/u);

    const decisions = successfulPort((received) => ({
      batchId: received.batchId,
      results: [
        { opId: first.opId, sequence: first.sequence, status: 'conflicted', targetId: 'node-a', cursor: 'cursor-51', conflictId: 'conflict-51', warnings: [] },
        { opId: second.opId, sequence: second.sequence, status: 'rejected', targetId: 'node-a', code: 'node_read_only', warnings: [] },
      ],
      serverCursor: 'cursor-52',
    }));
    await expect(applyPublisherOperations(decisions, candidate, {})).resolves.toMatchObject({
      results: [{ status: 'conflicted' }, { status: 'rejected', code: 'node_read_only' }],
    });
  });

  it(`snapshots caller data so later mutation cannot alter the applied Operation [evidence:${evidence}]`, async () => {
    const mutableOperation = structuredClone(nodeOperation('move')) as PublisherWritableOperation;
    const candidate = batch(mutableOperation);
    let captured: PublisherOperationBatch | undefined;
    const port = successfulPort((received) => { captured = received; return undefined; });
    await applyPublisherOperations(port, candidate, {});
    (candidate.operations[0]!.payload as { newParentId: string }).newParentId = 'attacker-parent';
    expect((captured?.operations[0]!.payload as { newParentId: string }).newParentId).toBe('folder-b');
  });
});
