import { createValidatorRegistry } from '../schema/index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import { assertSyncTypedUpdateOperationPayload } from '../sync/typed-operations.js';
import type { SyncTypedUpdateOperation } from '../sync/typed-operations.js';
import type { Operation, OperationResult } from '../types/index.js';
import type {
  CreateNodeOperationPayload,
  DeleteOperationPayload,
  MoveOperationPayload,
  NodeContentUpdateOperationPayload,
  ReorderOperationPayload,
  RestoreOperationPayload,
} from '../types/generated.js';
import {
  mapPublisherSidecarOperation,
  type PublisherOperationContext,
  type PublisherSidecarOperationRequest,
} from './operation-mapping.js';

export type PublisherNodeAction =
  | 'create'
  | 'update_content'
  | 'move'
  | 'reorder_children'
  | 'delete'
  | 'delete_subtree'
  | 'restore';

export type PublisherNodePayload =
  | CreateNodeOperationPayload
  | NodeContentUpdateOperationPayload
  | MoveOperationPayload
  | ReorderOperationPayload
  | DeleteOperationPayload
  | RestoreOperationPayload;

export type PublisherNodeOperationRequest = PublisherOperationContext & (
  | { readonly action: 'create'; readonly payload: CreateNodeOperationPayload }
  | { readonly action: 'update_content'; readonly payload: NodeContentUpdateOperationPayload }
  | { readonly action: 'move'; readonly payload: MoveOperationPayload }
  | { readonly action: 'reorder_children'; readonly payload: ReorderOperationPayload }
  | { readonly action: 'delete' | 'delete_subtree'; readonly payload: DeleteOperationPayload }
  | { readonly action: 'restore'; readonly payload: RestoreOperationPayload }
);

export type PublisherOperationRequest =
  | PublisherNodeOperationRequest
  | PublisherSidecarOperationRequest;

export type PublisherWritableOperation = Exclude<
  Operation,
  { readonly type: 'create_collection' | 'update_collection_metadata' | 'delete_collection' | 'restore_collection' | 'publish_release' }
>;

export interface PublisherOperationBatch {
  readonly batchId: string;
  readonly atomic: boolean;
  readonly operations: readonly [PublisherWritableOperation, ...PublisherWritableOperation[]];
}

export interface PublisherOperationBatchResult {
  readonly batchId: string;
  readonly results: readonly OperationResult[];
  readonly serverCursor: string;
}

/**
 * The sole mutation capability exposed to Publisher transports for Node and
 * Sidecar writes. Implementations are application services, not persistence
 * adapters: they own authorization, conflict handling and a real transaction
 * containing business state, Operation receipts, Audit and Outbox writes.
 * Atomic batches MUST commit all durable effects or reject the promise.
 */
export interface PublisherOperationApplicationPort<Context = unknown> {
  applyOperations(batch: PublisherOperationBatch, context: Context): Promise<unknown>;
}

const validators = createValidatorRegistry();
const NODE_TYPES = new Map<PublisherNodeAction, Operation['type']>([
  ['create', 'create_node'],
  ['update_content', 'update_node_content'],
  ['move', 'move_node'],
  ['reorder_children', 'reorder_children'],
  ['delete', 'delete_node'],
  ['delete_subtree', 'delete_subtree'],
  ['restore', 'restore_node'],
]);
const PUBLISHER_OPERATION_TYPES = new Set<Operation['type']>([
  'create_node',
  'update_node_content',
  'move_node',
  'reorder_children',
  'delete_node',
  'delete_subtree',
  'restore_node',
  'create_annotation',
  'update_annotation',
  'delete_annotation',
  'create_attachment',
  'update_attachment',
  'delete_attachment',
  'create_relation',
  'update_relation',
  'delete_relation',
]);

function plain(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object.`);
  }
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function assertCanonicalOperation(operation: unknown): asserts operation is Operation {
  const validation = validators.validate('operation', operation);
  if (!validation.valid) throw new TypeError('Publisher write is not a valid canonical Operation.');
  const typed = operation as Operation;
  if (typed.type === 'update_node_content'
    || typed.type === 'update_annotation'
    || typed.type === 'update_attachment'
    || typed.type === 'update_relation') {
    assertSyncTypedUpdateOperationPayload(typed as SyncTypedUpdateOperation);
  }
}

/** Converts a Publisher Node intent into the canonical Operation vocabulary. */
export function mapPublisherNodeOperation(request: PublisherNodeOperationRequest): PublisherWritableOperation {
  plain(request, 'Publisher Node Operation request');
  const type = NODE_TYPES.get(request.action);
  if (type === undefined) throw new TypeError('Publisher Node Operation action is unknown.');
  const create = request.action === 'create';
  if (create && (request.baseRevision !== null || request.targetId !== undefined)) {
    throw new TypeError('Create Node operations require null baseRevision and no targetId.');
  }
  if (!create && (typeof request.baseRevision !== 'string' || typeof request.targetId !== 'string')) {
    throw new TypeError('Node mutations require targetId and baseRevision.');
  }
  const operation = {
    opId: request.operationId,
    replicaId: request.replicaId,
    sequence: request.sequence,
    type,
    occurredAt: request.occurredAt,
    collectionId: request.collectionId,
    ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
    baseRevision: request.baseRevision,
    payload: request.payload,
    ...(request.dependencies === undefined ? {} : { dependencies: request.dependencies }),
    ...(request.source === undefined ? {} : { source: request.source }),
  };
  assertCanonicalOperation(operation);
  if (!PUBLISHER_OPERATION_TYPES.has(operation.type)) {
    throw new TypeError('Publisher Node mapping produced an excluded Operation type.');
  }
  return immutableJsonData(operation as PublisherWritableOperation, 'Publisher Node Operation');
}

/** Canonical mapping entry point shared by Publisher HTTP and MCP adapters. */
export function mapPublisherOperation(request: PublisherOperationRequest): PublisherWritableOperation {
  plain(request, 'Publisher Operation request');
  if (Object.hasOwn(request, 'sidecar')) {
    const operation = mapPublisherSidecarOperation(request as PublisherSidecarOperationRequest);
    if (!PUBLISHER_OPERATION_TYPES.has(operation.type)) {
      throw new TypeError('Publisher Sidecar mapping produced an excluded Operation type.');
    }
    return immutableJsonData(operation as PublisherWritableOperation, 'Publisher Sidecar Operation');
  }
  return mapPublisherNodeOperation(request as PublisherNodeOperationRequest);
}

function immutableBatch(candidate: PublisherOperationBatch): PublisherOperationBatch {
  plain(candidate, 'Publisher Operation batch');
  const batch = immutableJsonData(candidate, 'Publisher Operation batch');
  if (Object.keys(batch).length !== 3
    || !Object.hasOwn(batch, 'batchId')
    || !Object.hasOwn(batch, 'atomic')
    || !Object.hasOwn(batch, 'operations')) {
    throw new TypeError('Publisher Operation batch contains unknown or missing fields.');
  }
  nonEmpty(batch.batchId, 'Publisher Operation batchId');
  if (batch.atomic !== true) {
    throw new TypeError('Publisher Operation batch must be atomic.');
  }
  if (!Array.isArray(batch.operations) || batch.operations.length === 0) {
    throw new TypeError('Publisher Operation batch must contain at least one Operation.');
  }
  const operationIds = new Set<string>();
  const operations = batch.operations.map((operation) => {
    assertCanonicalOperation(operation);
    if (!PUBLISHER_OPERATION_TYPES.has(operation.type)) {
      throw new TypeError('Publisher Operation batch contains a Collection or Release operation.');
    }
    if (operationIds.has(operation.opId)) throw new TypeError('Publisher Operation batch repeats an Operation ID.');
    operationIds.add(operation.opId);
    return immutableJsonData(operation, 'Publisher canonical Operation') as PublisherWritableOperation;
  }) as unknown as [PublisherWritableOperation, ...PublisherWritableOperation[]];
  return Object.freeze({
    batchId: batch.batchId,
    atomic: batch.atomic,
    operations: Object.freeze(operations),
  });
}

function validateResult(candidate: unknown, batch: PublisherOperationBatch): PublisherOperationBatchResult {
  plain(candidate, 'Publisher applyOperations result');
  const result = immutableJsonData(candidate, 'Publisher applyOperations result');
  if (Object.keys(result).length !== 3
    || !Object.hasOwn(result, 'batchId')
    || !Object.hasOwn(result, 'results')
    || !Object.hasOwn(result, 'serverCursor')) {
    throw new TypeError('applyOperations returned unknown or missing result fields.');
  }
  if (result.batchId !== batch.batchId) throw new TypeError('applyOperations returned the wrong batchId.');
  nonEmpty(result.serverCursor, 'applyOperations serverCursor');
  if (!Array.isArray(result.results) || result.results.length !== batch.operations.length) {
    throw new TypeError('applyOperations returned a partial Operation result set.');
  }
  const results = result.results.map((operationResult, index) => {
    const validation = validators.validate('operationResult', operationResult);
    if (!validation.valid) throw new TypeError('applyOperations returned an invalid Operation result.');
    const operation = batch.operations[index]!;
    const typed = operationResult as OperationResult;
    if (typed.opId !== operation.opId || typed.sequence !== operation.sequence) {
      throw new TypeError('applyOperations returned misordered or unrelated Operation results.');
    }
    if ('targetId' in operation && typed.targetId !== undefined && typed.targetId !== operation.targetId) {
      throw new TypeError('applyOperations returned a result for the wrong target resource.');
    }
    return immutableJsonData(typed, 'Publisher Operation result');
  });
  return Object.freeze({
    batchId: batch.batchId,
    results: Object.freeze(results),
    serverCursor: result.serverCursor,
  });
}

/**
 * Validates and snapshots a canonical batch, then invokes exactly one mutation
 * method. HTTP, Sync and MCP adapters can share this boundary and cannot inject
 * a transport-specific resource mutation callback.
 */
export async function applyPublisherOperations<Context>(
  application: PublisherOperationApplicationPort<Context>,
  candidate: PublisherOperationBatch,
  context: Context,
): Promise<PublisherOperationBatchResult> {
  if (application === null || typeof application !== 'object'
    || typeof application.applyOperations !== 'function') {
    throw new TypeError('Publisher Operation application port is required.');
  }
  const batch = immutableBatch(candidate);
  const pending = application.applyOperations(batch, context);
  if (pending === null || typeof pending !== 'object' || typeof pending.then !== 'function') {
    throw new TypeError('Publisher applyOperations must return a Promise.');
  }
  const result = await pending;
  return validateResult(result, batch);
}
