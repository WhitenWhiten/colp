import { types as nodeTypes } from 'node:util';

import { createValidatorRegistry } from '../schema/index.js';
import type {
  GuardedNodeWritePlan,
  NodeWriteLimits,
  NodeWriteResolver,
} from '../server/node-write-guard.js';
import {
  getProblemDefinition,
  mapPublisherPreconditionToProblem,
  mapPublisherWriteConflictToProblem,
} from '../server/problems.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import type {
  DeleteResult,
  DeletionReceipt,
  NodeDeleteQuery,
  PrincipalRef,
  StrictNode,
} from '../types/index.js';
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
  type PublisherNodeWriteAuthorizationDecision,
} from './node-write.js';
import {
  evaluatePublisherWritePrecondition,
  type PublisherWritePreconditionFailure,
  type PublisherWritePreconditionSatisfied,
} from './preconditions.js';

export const PUBLISHER_NODE_DELETE_SCOPE = 'nodes:delete' as const;
export type PublisherNodeDeleteRequiredScope = typeof PUBLISHER_NODE_DELETE_SCOPE;

export type PublisherNodeDeleteOperation = Extract<
  PublisherNodeOperationRequest,
  { readonly action: 'delete' | 'delete_subtree' }
> & { readonly action: 'delete'; readonly targetId: string };

/** Canonical DELETE /nodes/{nodeId} input after HTTP query decoding. */
export interface PublisherNodeDeleteRequest {
  readonly operation: PublisherNodeDeleteOperation;
  readonly query: NodeDeleteQuery;
  readonly ifMatch?: string | readonly string[] | null;
}

/**
 * Durable, transaction-local deletion evidence produced by Operation
 * application. `memberNodeIds` identifies the exact internal Watermark range;
 * it is never a wire Sync cursor or a caller-provided descendants list.
 */
export interface PublisherNodeDeletionWatermark {
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

/** Read-back ledger written atomically by the canonical Operation application. */
export interface PublisherNodeDeletionApplicationLedger {
  readonly operationId: string;
  readonly operationType: 'delete_node' | 'delete_subtree';
  readonly targetId: string;
  readonly collectionId: string;
  readonly deleteRevision: string;
  readonly affectedCount: number;
  readonly deletedNodeIds: readonly string[];
  readonly watermark: PublisherNodeDeletionWatermark;
  readonly receipt: DeletionReceipt;
}

/** Core-derived input consumed by the canonical deletion Operation application. */
export interface PublisherNodeDeletionPlanBinding {
  readonly operationId: string;
  readonly operationType: 'delete_node' | 'delete_subtree';
  readonly targetId: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly memberNodeIds: readonly string[];
  readonly affectedCount: number;
}

/**
 * The resolver and ledger read MUST share the same serializable transaction or
 * locked snapshot used by applyOperations. The ledger must describe committed
 * business-state writes, not an adapter prediction.
 */
export interface PublisherNodeDeleteTransaction extends NodeWriteResolver {
  /**
   * Bind the already-authorized Core plan for one subsequent Operation call.
   * The application MUST consume this exact binding once and MUST NOT traverse
   * caller/adapter descendants or substitute another member set.
   */
  bindNodeDeletionPlan(binding: PublisherNodeDeletionPlanBinding): Promise<void>;
  resolveNodeDeletionApplication(
    operationId: string,
  ): Promise<PublisherNodeDeletionApplicationLedger | undefined>;
}

type DeleteWriterResult =
  | { readonly state: 'deleted'; readonly value: DeleteResult }
  | { readonly state: 'precondition'; readonly failure: PublisherWritePreconditionFailure }
  | { readonly state: 'revision-conflict'; readonly precondition: PublisherWritePreconditionSatisfied };

type GuardPorts<Context extends PublisherNodeDeleteTransaction> = Omit<
  PublisherGuardedNodeWritePorts<Context, PublisherNodeDeleteRequest, DeleteWriterResult>,
  'authorize' | 'write'
>;

/**
 * Framework-neutral Node DELETE composition. The host remains responsible for
 * any outer HTTP idempotency key/replay boundary; this API does not claim that a
 * canonical Operation ID alone supplies that boundary.
 */
export interface PublisherNodeDeletePorts<Context extends PublisherNodeDeleteTransaction>
  extends GuardPorts<Context> {
  readonly application: PublisherOperationApplicationPort<Context>;
  authorizeRequiredScope(
    context: Context,
    identities: readonly PrincipalRef[],
    request: Readonly<PublisherNodeDeleteRequest>,
    requiredScope: PublisherNodeDeleteRequiredScope,
  ): Promise<PublisherNodeWriteAuthorizationDecision>;
  authorize: PublisherGuardedNodeWritePorts<
    Context,
    PublisherNodeDeleteRequest,
    DeleteWriterResult
  >['authorize'];
}

export type PublisherNodeDeleteResult =
  | { readonly state: 'committed'; readonly value: DeleteResult }
  | ({ readonly state: 'rejected' } & {
      readonly code: 'authentication_required' | 'insufficient_scope' | 'resource_not_found'
        | 'node_read_only' | 'invalid_document' | 'payload_too_large' | 'internal_error'
        | 'precondition_required' | 'precondition_failed' | 'revision_conflict'
        | 'folder_not_empty';
      readonly status: number;
      readonly retryable: boolean;
      readonly currentRevision?: string;
      readonly currentEtag?: string;
    });

const validators = createValidatorRegistry();

/**
 * Runs security, Core traversal/policy, canonical Operation application,
 * Watermark/receipt verification and post-state reads in one unit of work.
 */
export async function executePublisherNodeDelete<Context extends PublisherNodeDeleteTransaction>(
  request: PublisherNodeDeleteRequest,
  ports: PublisherNodeDeletePorts<Context>,
  limits: NodeWriteLimits = {},
): Promise<PublisherNodeDeleteResult> {
  let command: PublisherNodeDeleteRequest;
  try {
    command = snapshotRequest(request);
  } catch {
    return rejectedProblem('invalid_document');
  }
  try {
    const checkedPorts = snapshotPorts(ports);
    const recursive = command.query.recursive === true;
    const operationType = recursive ? 'delete_subtree' as const : 'delete_node' as const;
    const mutationKind = recursive ? 'delete-subtree' as const : 'delete-node' as const;

    const guarded = await executePublisherGuardedNodeWrite<
      PublisherNodeDeleteRequest,
      Context,
      DeleteWriterResult
    >(command, Object.freeze({
      kind: mutationKind,
      nodeId: command.operation.targetId,
    }), {
      unitOfWork: checkedPorts.unitOfWork,
      authenticate: checkedPorts.authenticate,
      authorize: async (context, identities, candidate, mutation, subject) => {
        if (subject.kind === 'request-target') {
          const scope = inspectAuthorization(await requirePromise(
            checkedPorts.authorizeRequiredScope(
              context,
              identities,
              candidate,
              PUBLISHER_NODE_DELETE_SCOPE,
            ),
            'Publisher Node Delete required-scope authorization',
          ));
          if (!scope.authorized) return scope;
        }
        return checkedPorts.authorize(context, identities, candidate, mutation, subject);
      },
      conceal: checkedPorts.conceal,
      beforeBusinessConflict: async (context, candidate, _mutation, plan) => {
        assertDeletePlan(plan, candidate, operationType);
        const readers = snapshotTransactionReaders(context);
        const targetCandidate = await requirePromise(
          readers.resolveNode(candidate.operation.targetId),
          'Publisher Node Delete conflict precondition target resolver',
        );
        const target = snapshotNode(targetCandidate, 'conflict precondition target');
        if (target.collectionId !== plan.collectionId) {
          throw new TypeError('Publisher Node Delete target changed Collection before conflict mapping.');
        }
        const precondition = evaluatePublisherWritePrecondition({
          existingResource: true,
          ifMatch: candidate.ifMatch,
          currentRevision: target.revision,
          currentEtag: `"${target.revision}"`,
        });
        return precondition.state === 'rejected'
          ? Object.freeze({ state: 'precondition' as const, failure: precondition })
          : undefined;
      },
      validate: checkedPorts.validate,
      evaluatePolicy: checkedPorts.evaluatePolicy,
      write: async (context, candidate, plan) => {
        assertDeletePlan(plan, candidate, operationType);
        const readers = snapshotTransactionReaders(context);
        const beforeTarget = snapshotNode(
          await requirePromise(readers.resolveNode(candidate.operation.targetId), 'Publisher Node Delete target resolver'),
          'target',
        );
        if (beforeTarget.collectionId !== plan.collectionId) {
          throw new TypeError('Publisher Node Delete target changed Collection after Core planning.');
        }
        const parentId = survivingParentId(plan);
        const beforeParent = snapshotNode(
          await requirePromise(readers.resolveNode(parentId), 'Publisher Node Delete Parent resolver'),
          'Parent',
        );
        if (beforeParent.collectionId !== plan.collectionId
          || (beforeParent.kind !== 'root' && beforeParent.kind !== 'folder')) {
          throw new TypeError('Publisher Node Delete surviving Parent is not authoritative.');
        }

        const precondition = evaluatePublisherWritePrecondition({
          existingResource: true,
          ifMatch: candidate.ifMatch,
          currentRevision: beforeTarget.revision,
          currentEtag: `"${beforeTarget.revision}"`,
        });
        if (precondition.state === 'rejected') {
          return writerResult(Object.freeze({ state: 'precondition', failure: precondition }), plan);
        }
        if (candidate.operation.baseRevision !== beforeTarget.revision) {
          return writerResult(Object.freeze({ state: 'revision-conflict', precondition }), plan);
        }

        const binding: PublisherNodeDeletionPlanBinding = Object.freeze({
          operationId: candidate.operation.operationId,
          operationType,
          targetId: candidate.operation.targetId,
          collectionId: plan.collectionId,
          parentId,
          memberNodeIds: Object.freeze([...plan.deletedNodeIds]),
          affectedCount: plan.deletedNodeCount,
        });
        await requirePromise(
          readers.bindNodeDeletionPlan(binding),
          'Publisher Node Delete Core-plan binding',
        );

        const operation = mapDeleteOperation(candidate, operationType);
        if (operation.type !== operationType) {
          throw new TypeError('Publisher Node Delete mapped to the wrong canonical Operation type.');
        }
        const batch: PublisherOperationBatch = Object.freeze({
          batchId: operation.opId,
          atomic: true,
          operations: Object.freeze([operation] as [typeof operation]),
        });
        const application = await applyPublisherOperations(checkedPorts.application, batch, context);
        const operationResult = application.results[0];
        if (operationResult === undefined
          || operationResult.status !== 'applied'
          || operationResult.targetId !== operation.targetId
          || operationResult.revision === undefined) {
          throw new TypeError('Publisher Node Delete Operation was not applied exactly once.');
        }

        const ledger = snapshotLedger(await requirePromise(
          readers.resolveNodeDeletionApplication(operation.opId),
          'Publisher Node Delete application-ledger resolver',
        ));
        assertLedger(ledger, plan, operationType, operation.opId, operationResult.revision);

        for (const nodeId of plan.deletedNodeIds) {
          const deleted = await requirePromise(
            readers.resolveNode(nodeId),
            'Publisher Node Delete post-state resolver',
          );
          if (deleted !== undefined) {
            throw new TypeError('Publisher Node Delete authoritative post-state retains a planned member.');
          }
        }
        const afterParent = snapshotNode(
          await requirePromise(readers.resolveNode(parentId), 'Publisher Node Delete post-state Parent resolver'),
          'post-state Parent',
        );
        if (!sameStructuralNode(beforeParent, afterParent)) {
          throw new TypeError('Publisher Node Delete did not preserve its authoritative Parent identity.');
        }

        return writerResult(Object.freeze({
          state: 'deleted',
          value: Object.freeze({ receipt: ledger.receipt }),
        }), plan);
      },
    }, limits);
    return mapGuardedResult(guarded);
  } catch (error) {
    await notifyPublisherInternalFailureFromPorts(
      ports,
      'node-delete',
      error,
    );
    return rejected('internal_error');
  }
}

interface SnapshottedPorts<Context extends PublisherNodeDeleteTransaction>
  extends GuardPorts<Context> {
  readonly application: PublisherOperationApplicationPort<Context>;
  readonly authorizeRequiredScope: PublisherNodeDeletePorts<Context>['authorizeRequiredScope'];
  readonly authorize: PublisherNodeDeletePorts<Context>['authorize'];
}

function snapshotPorts<Context extends PublisherNodeDeleteTransaction>(
  ports: PublisherNodeDeletePorts<Context>,
): SnapshottedPorts<Context> {
  assertPortObject(ports, 'Publisher Node Delete ports');
  const application = dataValue(ports, 'application');
  assertPortObject(application, 'Publisher Node Delete application');
  const applyOperations = bindMethod<PublisherOperationApplicationPort<Context>['applyOperations']>(
    application,
    'applyOperations',
  );
  return Object.freeze({
    unitOfWork: dataValue(ports, 'unitOfWork') as SnapshottedPorts<Context>['unitOfWork'],
    authenticate: bindMethod<SnapshottedPorts<Context>['authenticate']>(ports, 'authenticate'),
    authorize: bindMethod<SnapshottedPorts<Context>['authorize']>(ports, 'authorize'),
    authorizeRequiredScope: bindMethod<SnapshottedPorts<Context>['authorizeRequiredScope']>(
      ports,
      'authorizeRequiredScope',
    ),
    conceal: bindMethod<SnapshottedPorts<Context>['conceal']>(ports, 'conceal'),
    validate: bindMethod<SnapshottedPorts<Context>['validate']>(ports, 'validate'),
    evaluatePolicy: bindMethod<SnapshottedPorts<Context>['evaluatePolicy']>(ports, 'evaluatePolicy'),
    application: Object.freeze({
      applyOperations(batch: PublisherOperationBatch, context: Context) {
        return requirePromise(applyOperations(batch, context), 'Publisher Node Delete application');
      },
    }),
  });
}

interface TransactionReaders {
  resolveNode(nodeId: string): Promise<StrictNode | undefined>;
  bindNodeDeletionPlan(binding: PublisherNodeDeletionPlanBinding): Promise<void>;
  resolveNodeDeletionApplication(operationId: string): Promise<PublisherNodeDeletionApplicationLedger | undefined>;
}

function snapshotTransactionReaders(context: PublisherNodeDeleteTransaction): TransactionReaders {
  assertPortObject(context, 'Publisher Node Delete transaction');
  const resolveNode = bindMethod<PublisherNodeDeleteTransaction['resolveNode']>(context, 'resolveNode');
  const bindPlan = bindMethod<PublisherNodeDeleteTransaction['bindNodeDeletionPlan']>(
    context,
    'bindNodeDeletionPlan',
  );
  const resolveLedger = bindMethod<PublisherNodeDeleteTransaction['resolveNodeDeletionApplication']>(
    context,
    'resolveNodeDeletionApplication',
  );
  return Object.freeze({
    resolveNode(nodeId: string) {
      return requirePromise(resolveNode(nodeId), 'Publisher Node Delete Node resolver');
    },
    bindNodeDeletionPlan(binding: PublisherNodeDeletionPlanBinding) {
      return requirePromise(bindPlan(binding), 'Publisher Node Delete Core-plan binding');
    },
    resolveNodeDeletionApplication(operationId: string) {
      return requirePromise(resolveLedger(operationId), 'Publisher Node Delete application-ledger resolver');
    },
  });
}

function snapshotRequest(request: PublisherNodeDeleteRequest): PublisherNodeDeleteRequest {
  const allowed = new Set(['operation', 'query', 'ifMatch']);
  if (request === null || typeof request !== 'object' || Array.isArray(request)
    || nodeTypes.isProxy(request)
    || (Object.getPrototypeOf(request) !== Object.prototype && Object.getPrototypeOf(request) !== null)
    || !Object.hasOwn(request, 'operation')
    || !Object.hasOwn(request, 'query')
    || Reflect.ownKeys(request).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Publisher Node Delete request contains unknown or missing fields.');
  }
  const source = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(request)) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Publisher Node Delete request must contain only enumerable data properties.');
    }
    // An explicitly undefined optional header is the JavaScript adapter form
    // of an omitted header. Preserve that semantic while keeping the cloned
    // request strictly JSON-shaped.
    if (key === 'ifMatch') assertRawIfMatchShape(descriptor.value);
    if (key !== 'ifMatch' || descriptor.value !== undefined) source[key] = descriptor.value;
  }
  const command = immutableJsonData(source, 'Publisher Node Delete request') as unknown as PublisherNodeDeleteRequest;
  if (!validators.validate('nodeDeleteQuery', command.query).valid) {
    throw new TypeError('Publisher Node Delete query is not canonical nodeDeleteQuery.');
  }
  if (command.ifMatch !== undefined
    && command.ifMatch !== null
    && typeof command.ifMatch !== 'string'
    && (!Array.isArray(command.ifMatch)
      || command.ifMatch.some((value) => typeof value !== 'string'))) {
    throw new TypeError('Publisher Node Delete If-Match field is invalid.');
  }
  if (Array.isArray(command.ifMatch)
    && Reflect.ownKeys(command.ifMatch).length !== command.ifMatch.length + 1) {
    throw new TypeError('Publisher Node Delete If-Match field must be a dense repeated header.');
  }
  assertDeleteOperationEnvelope(command.operation);
  return command;
}

function assertRawIfMatchShape(value: unknown): void {
  if (value === undefined || value === null || typeof value === 'string') return;
  if (!Array.isArray(value) || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Array.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('Publisher Node Delete If-Match field is invalid.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.at(-1) !== 'length') {
    throw new TypeError('Publisher Node Delete If-Match field must be a dense repeated header.');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || typeof descriptor.value !== 'string') {
      throw new TypeError('Publisher Node Delete If-Match field must contain string data elements.');
    }
  }
}

function assertDeleteOperationEnvelope(operation: PublisherNodeDeleteOperation): void {
  const allowedOperationKeys = new Set([
    'operationId', 'replicaId', 'sequence', 'occurredAt', 'collectionId', 'action',
    'targetId', 'baseRevision', 'payload', 'dependencies', 'source',
  ]);
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)
    || Reflect.ownKeys(operation).some((key) => typeof key !== 'string' || !allowedOperationKeys.has(key))
    || operation.action !== 'delete'
    || !validators.validate('opaqueId', operation.operationId).valid
    || !validators.validate('opaqueId', operation.replicaId).valid
    || !Number.isSafeInteger(operation.sequence) || operation.sequence < 1
    || !validators.validate('dateTime', operation.occurredAt).valid
    || !validators.validate('opaqueId', operation.collectionId).valid
    || !validators.validate('opaqueId', operation.targetId).valid
    || !validators.validate('opaqueId', operation.baseRevision).valid
    || operation.payload === null || typeof operation.payload !== 'object'
    || Array.isArray(operation.payload)) {
    throw new TypeError('Publisher Node Delete Operation envelope is invalid.');
  }
  const payload = operation.payload as unknown as Record<string, unknown>;
  if (Reflect.ownKeys(payload).some((key) => key !== 'reason')
    || (Object.hasOwn(payload, 'reason') && typeof payload.reason !== 'string')) {
    throw new TypeError('Publisher Node Delete payload contains unknown fields.');
  }
}

function mapDeleteOperation(
  request: PublisherNodeDeleteRequest,
  operationType: 'delete_node' | 'delete_subtree',
): ReturnType<typeof mapPublisherNodeOperation> {
  return mapPublisherNodeOperation({
    ...request.operation,
    action: operationType === 'delete_subtree' ? 'delete_subtree' : 'delete',
  });
}

function assertDeletePlan(
  plan: GuardedNodeWritePlan,
  request: PublisherNodeDeleteRequest,
  operationType: 'delete_node' | 'delete_subtree',
): void {
  const expectedMutation = operationType === 'delete_subtree' ? 'delete-subtree' : 'delete-node';
  if (plan.mutation.kind !== expectedMutation
    || plan.mutation.nodeId !== request.operation.targetId
    || plan.collectionId !== request.operation.collectionId
    || plan.deletedNodeCount < 1
    || plan.deletedNodeCount !== plan.deletedNodeIds.length
    || !plan.deletedNodeIds.includes(request.operation.targetId)
    || malformedIdSet(plan.deletedNodeIds)) {
    throw new TypeError('Publisher Node Delete Core plan is inconsistent with the request.');
  }
  if (operationType === 'delete_node' && plan.deletedNodeCount !== 1) {
    throw new TypeError('Publisher non-recursive Node Delete plan is not single-resource.');
  }
}

function survivingParentId(plan: GuardedNodeWritePlan): string {
  const deleted = new Set(plan.deletedNodeIds);
  const survivors = plan.modifiedNodeIds.filter((nodeId) => !deleted.has(nodeId));
  if (survivors.length !== 1) {
    throw new TypeError('Publisher Node Delete plan does not identify exactly one surviving Parent.');
  }
  return survivors[0]!;
}

function snapshotLedger(value: unknown): PublisherNodeDeletionApplicationLedger {
  if (value === undefined) throw new TypeError('Publisher Node Delete application ledger is missing.');
  const ledger = immutableJsonData(value, 'Publisher Node Delete application ledger') as PublisherNodeDeletionApplicationLedger;
  const keys = ['operationId', 'operationType', 'targetId', 'collectionId', 'deleteRevision',
    'affectedCount', 'deletedNodeIds', 'watermark', 'receipt'];
  if (Array.isArray(ledger)
    || Reflect.ownKeys(ledger).length !== keys.length
    || !keys.every((key) => Object.hasOwn(ledger, key))) {
    throw new TypeError('Publisher Node Delete application ledger contains unknown or missing fields.');
  }
  const watermarkKeys = ['resourceType', 'targetId', 'collectionId', 'scope', 'deletedAt',
    'deleteRevision', 'operationId', 'affectedCount', 'memberNodeIds'];
  if (ledger.watermark === null || typeof ledger.watermark !== 'object'
    || Array.isArray(ledger.watermark)
    || Reflect.ownKeys(ledger.watermark).length !== watermarkKeys.length
    || !watermarkKeys.every((key) => Object.hasOwn(ledger.watermark, key))) {
    throw new TypeError('Publisher Node Delete Watermark contains unknown or missing fields.');
  }
  if (!validators.validate('deletionReceipt', ledger.receipt).valid) {
    throw new TypeError('Publisher Node Delete ledger contains an invalid Deletion Receipt.');
  }
  return ledger;
}

function assertLedger(
  ledger: PublisherNodeDeletionApplicationLedger,
  plan: GuardedNodeWritePlan,
  operationType: 'delete_node' | 'delete_subtree',
  operationId: string,
  operationRevision: string,
): void {
  const scope = operationType === 'delete_subtree' ? 'subtree' : 'single';
  if (plan.mutation.kind !== 'delete-node' && plan.mutation.kind !== 'delete-subtree') {
    throw new TypeError('Publisher Node Delete ledger received a non-delete Core plan.');
  }
  const targetId = plan.mutation.nodeId;
  if (ledger.operationId !== operationId
    || ledger.operationType !== operationType
    || ledger.targetId !== targetId
    || ledger.collectionId !== plan.collectionId
    || ledger.deleteRevision !== operationRevision
    || ledger.affectedCount !== plan.deletedNodeCount
    || !sameIdSet(ledger.deletedNodeIds, plan.deletedNodeIds)
    || ledger.receipt.resourceType !== 'node'
    || ledger.receipt.targetId !== targetId
    || ledger.receipt.collectionId !== plan.collectionId
    || ledger.receipt.scope !== scope
    || ledger.receipt.operationId !== operationId
    || ledger.receipt.deleteRevision !== operationRevision
    || ledger.receipt.affectedCount !== plan.deletedNodeCount) {
    throw new TypeError('Publisher Node Delete ledger or Deletion Receipt differs from the Core plan.');
  }
  const watermark = ledger.watermark;
  if (watermark.resourceType !== 'node'
    || watermark.targetId !== ledger.targetId
    || watermark.collectionId !== ledger.collectionId
    || watermark.scope !== scope
    || watermark.deletedAt !== ledger.receipt.deletedAt
    || watermark.deleteRevision !== ledger.deleteRevision
    || watermark.operationId !== ledger.operationId
    || watermark.affectedCount !== ledger.affectedCount
    || !sameIdSet(watermark.memberNodeIds, plan.deletedNodeIds)) {
    throw new TypeError('Publisher Node Delete Watermark differs from the exact Core deletion membership.');
  }
}

function snapshotNode(value: unknown, label: string): StrictNode {
  if (value === undefined) throw new TypeError(`Publisher Node Delete ${label} is missing.`);
  const node = immutableJsonData(value, `Publisher Node Delete ${label}`) as StrictNode;
  if (node === null || typeof node !== 'object' || Array.isArray(node)
    || typeof node.id !== 'string' || node.id.length === 0
    || typeof node.collectionId !== 'string' || node.collectionId.length === 0
    || typeof node.revision !== 'string' || node.revision.length === 0
    || !['root', 'folder', 'bookmark', 'separator', 'alias'].includes(node.kind)
    || (node.kind === 'root' ? node.parentId !== null : typeof node.parentId !== 'string')) {
    throw new TypeError(`Publisher Node Delete ${label} is malformed.`);
  }
  return node;
}

function sameStructuralNode(left: StrictNode, right: StrictNode): boolean {
  return left.id === right.id
    && left.collectionId === right.collectionId
    && left.kind === right.kind
    && left.parentId === right.parentId;
}

function mapGuardedResult(
  result: PublisherGuardedNodeWriteResult<DeleteWriterResult>,
): PublisherNodeDeleteResult {
  if (result.state === 'rejected') return result as PublisherNodeDeleteResult;
  if (result.value.state === 'deleted') {
    return Object.freeze({ state: 'committed', value: result.value.value });
  }
  if (result.value.state === 'revision-conflict') {
    const mapped = mapPublisherWriteConflictToProblem(result.value.precondition, true);
    if (mapped === undefined || mapped.code !== 'revision_conflict') {
      throw new TypeError('Publisher Node Delete conflict mapping failed closed.');
    }
    return Object.freeze({ state: 'rejected', ...mapped }) as PublisherNodeDeleteResult;
  }
  const failure = result.value.failure;
  const mapped = mapPublisherPreconditionToProblem(failure);
  return Object.freeze({
    state: 'rejected',
    code: failure.code,
    status: mapped.status,
    retryable: mapped.retryable,
    currentRevision: failure.currentRevision,
    ...(failure.currentEtag === undefined ? {} : { currentEtag: failure.currentEtag }),
  });
}

function writerResult(
  result: DeleteWriterResult,
  plan: GuardedNodeWritePlan,
): {
  readonly result: DeleteWriterResult;
  readonly modifiedNodeIds: readonly string[];
  readonly deletedNodeIds: readonly string[];
  readonly deletedNodeCount: number;
} {
  return Object.freeze({
    result,
    modifiedNodeIds: plan.modifiedNodeIds,
    deletedNodeIds: plan.deletedNodeIds,
    deletedNodeCount: plan.deletedNodeCount,
  });
}

function inspectAuthorization(value: unknown): PublisherNodeWriteAuthorizationDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Publisher Node Delete required-scope decision must be a plain object.');
  }
  const decision = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(decision)) {
    const descriptor = Object.getOwnPropertyDescriptor(decision, key);
    if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Publisher Node Delete required-scope decision must contain data properties.');
    }
  }
  if (decision.authorized === true && Reflect.ownKeys(decision).length === 1) {
    return Object.freeze({ authorized: true });
  }
  if (decision.authorized === false && typeof decision.reason === 'string'
    && decision.reason.length > 0 && Reflect.ownKeys(decision).length === 2) {
    return Object.freeze({ authorized: false, reason: decision.reason });
  }
  throw new TypeError('Publisher Node Delete required-scope port must explicitly allow or deny.');
}

function malformedIdSet(ids: readonly string[]): boolean {
  return !Array.isArray(ids)
    || ids.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(ids).size !== ids.length;
}

function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (malformedIdSet(actual) || malformedIdSet(expected) || actual.length !== expected.length) return false;
  const remaining = new Set(actual);
  return expected.every((id) => remaining.delete(id)) && remaining.size === 0;
}

function rejected(code: 'internal_error'): PublisherNodeDeleteResult {
  return Object.freeze({ state: 'rejected', code, ...getProblemDefinition(code) });
}

function rejectedProblem(
  code: 'invalid_document',
): PublisherNodeDeleteResult {
  return Object.freeze({ state: 'rejected', code, ...getProblemDefinition(code) });
}

function assertPortObject(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a non-Proxy object.`);
  }
}

function dataValue(owner: object, name: string): unknown {
  const descriptor = findDataProperty(owner, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`Publisher Node Delete ${name} port is required.`);
  }
  return descriptor.value;
}

function bindMethod<Method extends (...args: any[]) => unknown>(owner: object, name: string): Method {
  const descriptor = findDataProperty(owner, name);
  if (descriptor === undefined || !('value' in descriptor)
    || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`Publisher Node Delete ${name} port must be a non-Proxy data method.`);
  }
  const method = descriptor.value as Method;
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

function findDataProperty(owner: object, name: string): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) throw new TypeError('Publisher Node Delete port prototype cannot be a Proxy.');
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError(`Publisher Node Delete ${name} must be a data property.`);
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return candidate;
}
