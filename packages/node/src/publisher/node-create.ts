import { types as nodeTypes } from 'node:util';

import { createValidatorRegistry } from '../schema/index.js';
import type {
  GuardedNodeKind,
  GuardedNodeWritePlan,
  NodeWriteLimits,
  NodeWriteResolver,
} from '../server/node-write-guard.js';
import { getProblemDefinition } from '../server/problems.js';
import {
  reserveServerIds,
  type ServerIdReservation,
  type ServerIdReservationTransaction,
} from '../shared/server-id-reservations.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import type { CreateNodeOperationPayload, StrictNode } from '../types/index.js';
import {
  applyPublisherOperations,
  mapPublisherNodeOperation,
  type PublisherNodeOperationRequest,
  type PublisherOperationApplicationPort,
  type PublisherOperationBatch,
} from './operation-application.js';
import { notifyPublisherInternalFailureFromPorts } from './internal-failure.js';
import {
  executePublisherGuardedNodeWrite,
  type PublisherGuardedNodeWritePorts,
  type PublisherGuardedNodeWriteResult,
} from './node-write.js';

/**
 * Server-resolved identity plus the canonical POST /nodes body and Operation
 * metadata. The server ID is deliberately outside nodeCreateRequest because it
 * is never caller-controlled Node content.
 */
export type PublisherOrdinaryNodeCreateOperation = Extract<
  PublisherNodeOperationRequest,
  { readonly action: 'create' }
>;

export interface PublisherOrdinaryNodeCreateRequest {
  readonly nodeId: string;
  readonly operation: PublisherOrdinaryNodeCreateOperation;
}

/** One transaction supplies both authoritative Core reads and the ID ledger. */
export interface PublisherOrdinaryNodeCreateTransaction
  extends NodeWriteResolver, ServerIdReservationTransaction {}

type GuardPorts<Context extends PublisherOrdinaryNodeCreateTransaction> = Omit<
  PublisherGuardedNodeWritePorts<Context, PublisherOrdinaryNodeCreateRequest, StrictNode>,
  'write'
>;

/**
 * Framework-neutral ordinary Node-create application port. applyOperations
 * MUST use the supplied transaction and MUST NOT open or commit another one.
 * Authentication, graph expansion, read-only policy and affected-node checks
 * remain owned by executePublisherGuardedNodeWrite and the Core guard.
 */
export interface PublisherOrdinaryNodeCreatePorts<
  Context extends PublisherOrdinaryNodeCreateTransaction,
> extends GuardPorts<Context> {
  readonly application: PublisherOperationApplicationPort<Context>;
}

const validators = createValidatorRegistry();

/**
 * Creates one non-Root Node through the PUBLISH-0013 security/Core guard and
 * PUBLISH-0011 canonical Operation path in one transaction.
 *
 * Idempotency replay remains outside this callback: only a newly claimed
 * request may enter this function. Consequently a replay never attempts the
 * permanent reservation again, while every actual creation reserves first.
 */
export async function executePublisherOrdinaryNodeCreate<
  Context extends PublisherOrdinaryNodeCreateTransaction,
>(
  request: PublisherOrdinaryNodeCreateRequest,
  ports: PublisherOrdinaryNodeCreatePorts<Context>,
  limits: NodeWriteLimits = {},
): Promise<PublisherGuardedNodeWriteResult<StrictNode>> {
  try {
    return await executeOrdinaryNodeCreate(request, ports, limits);
  } catch (error) {
    await notifyPublisherInternalFailureFromPorts(
      ports,
      'ordinary-node-create',
      error,
    );
    return Object.freeze({
      state: 'rejected' as const,
      code: 'internal_error' as const,
      ...getProblemDefinition('internal_error'),
    });
  }
}

async function executeOrdinaryNodeCreate<Context extends PublisherOrdinaryNodeCreateTransaction>(
  request: PublisherOrdinaryNodeCreateRequest,
  ports: PublisherOrdinaryNodeCreatePorts<Context>,
  limits: NodeWriteLimits,
): Promise<PublisherGuardedNodeWriteResult<StrictNode>> {
  const command = snapshotRequest(request);
  const checkedPorts = snapshotPorts(ports);
  const mutation = Object.freeze({
    kind: 'create-node' as const,
    nodeId: command.nodeId,
    collectionId: command.operation.collectionId,
    nodeKind: command.operation.payload.node.kind as GuardedNodeKind,
    parentId: command.operation.payload.parentId,
  });

  return executePublisherGuardedNodeWrite(command, mutation, {
    unitOfWork: checkedPorts.unitOfWork,
    authenticate: checkedPorts.authenticate,
    authorize: checkedPorts.authorize,
    conceal: checkedPorts.conceal,
    validate: checkedPorts.validate,
    evaluatePolicy: checkedPorts.evaluatePolicy,
    write: async (context, candidate, plan) => {
      assertCreatePlan(plan, candidate);
      const before = await resolveCreateReferences(context, candidate);

      await reserveNodeId(context, candidate.nodeId);

      const operation = mapPublisherNodeOperation(candidate.operation);
      const batch: PublisherOperationBatch = Object.freeze({
        batchId: candidate.operation.operationId,
        atomic: true,
        operations: Object.freeze([operation] as [typeof operation]),
      });
      const applicationResult = await applyPublisherOperations(
        checkedPorts.application,
        batch,
        context,
      );
      const result = applicationResult.results[0];
      if (result === undefined
        || result.status !== 'applied'
        || result.targetId !== candidate.nodeId) {
        throw new TypeError('Publisher Node create Operation did not apply to the reserved Node ID.');
      }

      const after = await resolveCreateReferences(context, candidate, true);
      if (!sameCollection(before.collection, after.collection)
        || !sameNodeIdentity(before.parent, after.parent)) {
        throw new TypeError('Publisher Node create authoritative references changed during application.');
      }
      const node = after.node;
      if (node === undefined
        || node.id !== candidate.nodeId
        || node.collectionId !== candidate.operation.collectionId
        || node.parentId !== candidate.operation.payload.parentId
        || node.kind !== candidate.operation.payload.node.kind
        || (node as { readonly kind: string }).kind === 'root'
        || !containsExactNodeCreatePayload(node, candidate.operation.payload.node)
        || node.revision !== result.revision) {
        throw new TypeError('Publisher Node create returned a mismatched authoritative Node.');
      }
      return Object.freeze({
        result: node,
        modifiedNodeIds: plan.modifiedNodeIds,
        deletedNodeIds: plan.deletedNodeIds,
        deletedNodeCount: plan.deletedNodeCount,
      });
    },
  }, limits);
}

function snapshotRequest(request: PublisherOrdinaryNodeCreateRequest): PublisherOrdinaryNodeCreateRequest {
  assertPlainSource(request, 'Publisher ordinary Node create request');
  const command = immutableJsonData(request, 'Publisher ordinary Node create request');
  const keys = Reflect.ownKeys(command);
  if (keys.length !== 2 || !Object.hasOwn(command, 'nodeId') || !Object.hasOwn(command, 'operation')) {
    throw new TypeError('Publisher ordinary Node create request contains unknown or missing fields.');
  }
  if (!validators.validate('opaqueId', command.nodeId).valid) {
    throw new TypeError('Publisher ordinary Node create ID must be a canonical opaque ID.');
  }
  if (command.operation === null || typeof command.operation !== 'object'
    || command.operation.action !== 'create') {
    throw new TypeError('Publisher ordinary Node create requires a create Operation request.');
  }
  // immutableJsonData deliberately creates null-prototype objects. Rebuild the
  // request envelope as a plain object for the existing canonical mapper while
  // retaining the already detached, frozen nested payload/source snapshots.
  const operation = Object.freeze({ ...command.operation }) as PublisherOrdinaryNodeCreateOperation;
  const createRequest = operation.payload as CreateNodeOperationPayload;
  if (createRequest === null || typeof createRequest !== 'object'
    || !Object.hasOwn(createRequest, 'parentId')
    || createRequest.parentId === null
    || typeof createRequest.parentId !== 'string') {
    throw new TypeError('Publisher ordinary Node create requires a non-null parentId.');
  }
  const node = createRequest.node as { readonly kind?: unknown; readonly folderRole?: unknown };
  if (node?.kind === 'root' || node?.folderRole === 'root') {
    throw new TypeError('Publisher ordinary Node create cannot create a Root.');
  }
  if (!validators.validate('nodeCreateRequest', createRequest).valid) {
    throw new TypeError('Publisher ordinary Node create body is not a canonical nodeCreateRequest.');
  }
  // Mapping validates and snapshots all Operation context fields without
  // granting the adapter a mutation capability.
  mapPublisherNodeOperation(operation);
  return Object.freeze({ nodeId: command.nodeId, operation });
}

interface SnapshottedPorts<Context extends PublisherOrdinaryNodeCreateTransaction>
  extends GuardPorts<Context> {
  readonly application: PublisherOperationApplicationPort<Context>;
}

function snapshotPorts<Context extends PublisherOrdinaryNodeCreateTransaction>(
  ports: PublisherOrdinaryNodeCreatePorts<Context>,
): SnapshottedPorts<Context> {
  assertPortObject(ports, 'Publisher ordinary Node create ports');
  const unitOfWork = dataValue(ports, 'unitOfWork');
  const application = dataValue(ports, 'application');
  assertPortObject(unitOfWork, 'Publisher ordinary Node create unit of work');
  assertPortObject(application, 'Publisher ordinary Node create application');
  const run = bindMethod<GuardPorts<Context>['unitOfWork']['run']>(unitOfWork, 'run');
  const applyOperations = bindMethod<PublisherOperationApplicationPort<Context>['applyOperations']>(
    application,
    'applyOperations',
  );
  return Object.freeze({
    unitOfWork: Object.freeze({ run }),
    authenticate: bindMethod(ports, 'authenticate'),
    authorize: bindMethod(ports, 'authorize'),
    conceal: bindMethod(ports, 'conceal'),
    validate: bindMethod(ports, 'validate'),
    evaluatePolicy: bindMethod(ports, 'evaluatePolicy'),
    application: Object.freeze({
      applyOperations(batch: PublisherOperationBatch, context: Context) {
        return requirePromise(applyOperations(batch, context), 'Publisher ordinary Node create application');
      },
    }),
  }) as SnapshottedPorts<Context>;
}

function assertCreatePlan(
  plan: GuardedNodeWritePlan,
  request: PublisherOrdinaryNodeCreateRequest,
): void {
  const mutation = plan.mutation;
  const expectedModified = new Set([request.nodeId, request.operation.payload.parentId]);
  if (mutation.kind !== 'create-node'
    || mutation.nodeId !== request.nodeId
    || mutation.collectionId !== request.operation.collectionId
    || mutation.parentId !== request.operation.payload.parentId
    || mutation.nodeKind !== request.operation.payload.node.kind
    || plan.collectionId !== request.operation.collectionId
    || plan.modifiedNodeIds.length !== expectedModified.size
    || !plan.modifiedNodeIds.every((id) => expectedModified.delete(id))
    || expectedModified.size !== 0
    || plan.deletedNodeIds.length !== 0
    || plan.deletedNodeCount !== 0) {
    throw new TypeError('Publisher ordinary Node create received a mismatched Core plan.');
  }
}

interface CreateReferences {
  readonly collection: { readonly id: string; readonly rootNodeId: string };
  readonly parent: StrictNode;
  readonly node?: StrictNode;
}

async function resolveCreateReferences<Context extends PublisherOrdinaryNodeCreateTransaction>(
  context: Context,
  request: PublisherOrdinaryNodeCreateRequest,
  requireCreatedNode = false,
): Promise<CreateReferences> {
  assertPortObject(context, 'Publisher ordinary Node create transaction');
  const resolveCollection = bindMethod<NodeWriteResolver['resolveCollection']>(context, 'resolveCollection');
  const resolveNode = bindMethod<NodeWriteResolver['resolveNode']>(context, 'resolveNode');
  const collectionCandidate = await requirePromise(
    resolveCollection(request.operation.collectionId),
    'Publisher ordinary Node create Collection resolver',
  );
  const parentCandidate = await requirePromise(
    resolveNode(request.operation.payload.parentId),
    'Publisher ordinary Node create Parent resolver',
  );
  const nodeCandidate = await requirePromise(
    resolveNode(request.nodeId),
    'Publisher ordinary Node create Node resolver',
  );
  const collection = snapshotCollection(collectionCandidate, request.operation.collectionId);
  const parent = snapshotNode(parentCandidate, 'Parent');
  if (parent.id !== request.operation.payload.parentId
    || parent.collectionId !== collection.id
    || (parent.kind !== 'root' && parent.kind !== 'folder')
    || (parent.kind === 'root' && parent.id !== collection.rootNodeId)) {
    throw new TypeError('Publisher ordinary Node create Parent is not an authoritative same-Collection Root or Folder.');
  }
  if (!requireCreatedNode && nodeCandidate !== undefined) {
    throw new TypeError('Publisher ordinary Node create ID became occupied before reservation.');
  }
  if (requireCreatedNode && nodeCandidate === undefined) {
    throw new TypeError('Publisher ordinary Node create application did not resolve the created Node.');
  }
  const node = nodeCandidate === undefined ? undefined : snapshotNode(nodeCandidate, 'created Node');
  return Object.freeze({ collection, parent, ...(node === undefined ? {} : { node }) });
}

async function reserveNodeId<Context extends PublisherOrdinaryNodeCreateTransaction>(
  context: Context,
  nodeId: string,
): Promise<void> {
  const reservationStore = dataValue(context, 'idReservations');
  assertPortObject(reservationStore, 'Publisher ordinary Node create ID reservation store');
  const reserveAll = bindMethod<ServerIdReservationTransaction['idReservations']['reserveAll']>(
    reservationStore,
    'reserveAll',
  );
  await reserveServerIds(
    Object.freeze({
      idReservations: Object.freeze({
        reserveAll(reservations: readonly ServerIdReservation[]) {
          return requirePromise(
            reserveAll(reservations),
            'Publisher ordinary Node create ID reservation store',
          );
        },
      }),
    }),
    [{ id: nodeId, resourceType: 'node' }],
  );
}

function snapshotCollection(candidate: unknown, collectionId: string): CreateReferences['collection'] {
  assertPlainSource(candidate, 'Publisher ordinary Node create Collection');
  const collection = immutableJsonData(candidate, 'Publisher ordinary Node create Collection') as {
    readonly id?: unknown;
    readonly rootNodeId?: unknown;
  };
  if (Reflect.ownKeys(collection).length !== 2
    || !validators.validate('opaqueId', collection.id).valid
    || !validators.validate('opaqueId', collection.rootNodeId).valid
    || collection.id !== collectionId) {
    throw new TypeError('Publisher ordinary Node create Collection resolver returned a mismatched identity.');
  }
  return Object.freeze({ id: collection.id as string, rootNodeId: collection.rootNodeId as string });
}

function snapshotNode(candidate: unknown, label: string): StrictNode {
  assertPlainSource(candidate, `Publisher ordinary Node create ${label}`);
  const node = immutableJsonData(candidate, `Publisher ordinary Node create ${label}`) as StrictNode;
  if (!validators.validate('node', node).valid || node.redacted === true) {
    throw new TypeError(`Publisher ordinary Node create ${label} resolver returned a malformed authoritative Node.`);
  }
  return node;
}

function sameCollection(
  left: CreateReferences['collection'],
  right: CreateReferences['collection'],
): boolean {
  return left.id === right.id && left.rootNodeId === right.rootNodeId;
}

function sameNodeIdentity(left: StrictNode, right: StrictNode): boolean {
  return left.id === right.id
    && left.collectionId === right.collectionId
    && left.kind === right.kind
    && left.parentId === right.parentId;
}

function containsExactNodeCreatePayload(
  node: StrictNode,
  payload: CreateNodeOperationPayload['node'],
): boolean {
  return Reflect.ownKeys(payload).every((key) => (
    typeof key === 'string'
    && Object.hasOwn(node, key)
    && equalJsonData(
      (node as unknown as Record<string, unknown>)[key],
      (payload as unknown as Record<string, unknown>)[key],
    )
  ));
}

function equalJsonData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJsonData(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key)
      && equalJsonData(leftRecord[key], rightRecord[key]));
}

function assertPlainSource(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} cannot contain a Proxy.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype && prototype !== null) {
      throw new TypeError(`${label} arrays must have a plain prototype.`);
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new TypeError(`${label} arrays must be dense and contain no extra properties.`);
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain data.`);
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)
      || (key !== 'length' && !descriptor.enumerable)) {
      throw new TypeError(`${label} cannot contain accessors or hidden members.`);
    }
    if (key !== 'length') assertPlainSource(descriptor.value, label, seen);
  }
}

function assertPortObject(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} is required and cannot be a Proxy.`);
  }
}

function dataValue(owner: object, name: string): unknown {
  const descriptor = findDataProperty(owner, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`Publisher ordinary Node create ${name} must be a data property.`);
  }
  return descriptor.value;
}

function bindMethod<Method extends (...args: any[]) => unknown>(owner: object, name: string): Method {
  const method = dataValue(owner, name);
  if (typeof method !== 'function' || nodeTypes.isProxy(method)) {
    throw new TypeError(`Publisher ordinary Node create ${name} must be a non-Proxy data method.`);
  }
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

function findDataProperty(owner: object, name: string): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) {
      throw new TypeError('Publisher ordinary Node create port prototype cannot be a Proxy.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return candidate;
}
