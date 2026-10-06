import { types as nodeTypes } from 'node:util';

import { createValidatorRegistry } from '../schema/index.js';
import { compareOrderKeys } from '../semantic/snapshot.js';
import { buildMoveNodePayload } from '../client/node-placement.js';
import type {
  GuardedNodeWritePlan,
  NodeWriteLimits,
  NodeWriteResolver,
} from '../server/node-write-guard.js';
import {
  NodeWriteGuardError,
  resolveNodeWriteLimits,
} from '../server/node-write-guard.js';
import {
  getProblemDefinition,
  mapPublisherPreconditionToProblem,
  mapPublisherWriteConflictToProblem,
} from '../server/problems.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import type { NodeMoveResult, StrictNode } from '../types/index.js';
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
import {
  evaluatePublisherWritePrecondition,
  type PublisherWritePreconditionFailure,
} from './preconditions.js';

export type PublisherNodeMoveOperation = Extract<
  PublisherNodeOperationRequest,
  { readonly action: 'move' }
> & { readonly targetId: string };

/** The canonical Move Operation plus its HTTP If-Match field. */
export interface PublisherNodeMoveRequest {
  readonly operation: PublisherNodeMoveOperation;
  readonly ifMatch?: string | readonly string[] | null;
}

/**
 * One transaction-local, authoritative parent ordering snapshot. Implementations
 * must return the complete immediate child set in current order together with the
 * revision that protects that exact order.
 */
export interface PublisherNodeMovePositionContext {
  readonly parentId: string;
  readonly childrenRevision: string;
  readonly children: readonly StrictNode[];
}

export interface PublisherNodeMoveTransaction extends NodeWriteResolver {
  resolveMovePositionContext(parentId: string): Promise<PublisherNodeMovePositionContext | undefined>;
}

type GuardPorts<Context extends PublisherNodeMoveTransaction> = Omit<
  PublisherGuardedNodeWritePorts<Context, PublisherNodeMoveRequest, MoveWriterResult>,
  'write'
>;

/** Framework-neutral application composition; no controller or database is implied. */
export interface PublisherNodeMovePorts<Context extends PublisherNodeMoveTransaction>
  extends GuardPorts<Context> {
  readonly application: PublisherOperationApplicationPort<Context>;
}

export type PublisherNodeMoveResult =
  | { readonly state: 'committed'; readonly value: NodeMoveResult }
  | ({ readonly state: 'rejected' } & {
      readonly code: 'authentication_required' | 'insufficient_scope' | 'resource_not_found'
        | 'node_read_only' | 'invalid_document' | 'payload_too_large' | 'internal_error'
        | 'precondition_required' | 'precondition_failed' | 'revision_conflict'
        | 'position_context_stale';
      readonly status: number;
      readonly retryable: boolean;
      readonly currentRevision?: string;
      readonly currentEtag?: string;
    });

type MoveWriterResult =
  | { readonly state: 'moved'; readonly value: NodeMoveResult }
  | { readonly state: 'precondition'; readonly failure: PublisherWritePreconditionFailure }
  | { readonly state: 'context-rejected'; readonly code: 'precondition_required' | 'precondition_failed' }
  | {
      readonly state: 'revision-conflict';
      readonly precondition: Exclude<ReturnType<typeof evaluatePublisherWritePrecondition>, PublisherWritePreconditionFailure>;
    }
  | { readonly state: 'position-stale' };

const validators = createValidatorRegistry();

/**
 * Executes one Node Move through the guarded Core plan and exactly one canonical
 * `move_node` applyOperations call in the same unit of work.
 */
export async function executePublisherNodeMove<Context extends PublisherNodeMoveTransaction>(
  request: PublisherNodeMoveRequest,
  ports: PublisherNodeMovePorts<Context>,
  limits: NodeWriteLimits = {},
): Promise<PublisherNodeMoveResult> {
  try {
    const command = snapshotRequest(request);
    const checkedPorts = snapshotPorts(ports);
    const checkedLimits = resolveNodeWriteLimits(limits);
    const payload = command.operation.payload;
    const guarded = await executePublisherGuardedNodeWrite<PublisherNodeMoveRequest, Context, MoveWriterResult>(command, Object.freeze({
      kind: 'move-node' as const,
      nodeId: command.operation.targetId,
      parentId: payload.newParentId,
      ...(payload.afterId === undefined ? {} : { afterId: payload.afterId }),
      ...(payload.beforeId === undefined ? {} : { beforeId: payload.beforeId }),
    }), {
      unitOfWork: checkedPorts.unitOfWork,
      authenticate: checkedPorts.authenticate,
      authorize: checkedPorts.authorize,
      conceal: checkedPorts.conceal,
      validate: checkedPorts.validate,
      evaluatePolicy: checkedPorts.evaluatePolicy,
      write: async (context, candidate, plan) => {
        assertMovePlan(plan, candidate);
        const readers = snapshotMoveReaders(context);
        const preconditionNode = await resolveMoveNode(readers, candidate);

        const precondition = evaluatePublisherWritePrecondition({
          existingResource: true,
          ifMatch: candidate.ifMatch,
          currentRevision: preconditionNode.revision,
          currentEtag: `"${preconditionNode.revision}"`,
        });
        if (precondition.state === 'rejected') {
          return writerResult(Object.freeze({ state: 'precondition', failure: precondition }), plan);
        }

        const revisionSyntax = inspectChildrenRevisionSyntax(candidate.operation.payload);
        if (revisionSyntax !== undefined) {
          return writerResult(Object.freeze({ state: 'context-rejected', code: revisionSyntax }), plan);
        }
        buildMoveNodePayload(candidate.operation.payload);

        const before = await resolveReferences(
          readers,
          candidate,
          undefined,
          true,
          checkedLimits.maxVisitedNodes,
        );
        if (before.node.id !== preconditionNode.id
          || before.node.collectionId !== preconditionNode.collectionId
          || before.node.kind !== preconditionNode.kind
          || before.node.parentId !== preconditionNode.parentId
          || before.node.revision !== preconditionNode.revision) {
          throw new TypeError('Publisher Node Move Node resolver changed after the HTTP precondition.');
        }

        if (before.source.parentId === before.target.parentId
          && payload.baseSourceParentRevision !== payload.baseTargetParentRevision) {
          return writerResult(Object.freeze({ state: 'position-stale' }), plan);
        }
        if (before.source.childrenRevision !== payload.baseSourceParentRevision
          || before.target.childrenRevision !== payload.baseTargetParentRevision) {
          return writerResult(Object.freeze({ state: 'position-stale' }), plan);
        }
        if (candidate.operation.baseRevision !== before.node.revision) {
          return writerResult(Object.freeze({ state: 'revision-conflict', precondition }), plan);
        }
        if (!validRequestedPlacement(before.target, before.node.id, payload.afterId, payload.beforeId)) {
          return writerResult(Object.freeze({ state: 'position-stale' }), plan);
        }

        const operation = mapPublisherNodeOperation(candidate.operation);
        if (operation.type !== 'move_node') throw new TypeError('Publisher Move mapped to the wrong Operation type.');
        const batch: PublisherOperationBatch = Object.freeze({
          batchId: operation.opId,
          atomic: true,
          operations: Object.freeze([operation] as [typeof operation]),
        });
        const application = await applyPublisherOperations(checkedPorts.application, batch, context);
        const receipt = application.results[0];
        if (receipt === undefined) {
          throw new TypeError('Publisher Move did not return its canonical Operation receipt.');
        }
        if (receipt.status === 'conflicted') {
          return writerResult(Object.freeze({ state: 'revision-conflict', precondition }), plan);
        }
        if ((receipt.status !== 'applied' && receipt.status !== 'rebased')
          || receipt.targetId !== before.node.id
          || receipt.transform === undefined) {
          throw new TypeError('Publisher Move did not return an applied/rebased Move receipt and transform.');
        }
        const transformedPosition = exactTransformPosition(receipt.transform);

        const after = await resolveReferences(
          readers,
          candidate,
          before.source.parentId,
          false,
          checkedLimits.maxVisitedNodes,
        );
        assertStableReferences(before, after);
        if (after.node.parentId !== after.target.parentId
          || after.node.position !== transformedPosition
          || after.node.revision !== receipt.revision
          || !validAppliedPlacement(after.target, after.node.id, payload.afterId, payload.beforeId)) {
          throw new TypeError('Publisher Move authoritative post-state does not match its receipt and placement.');
        }
        if (after.source.parentId !== after.target.parentId
          && after.source.children.some((child) => child.id === after.node.id)) {
          throw new TypeError('Publisher Move Source context still contains the moved Node.');
        }
        if (after.source.childrenRevision === before.source.childrenRevision
          || after.target.childrenRevision === before.target.childrenRevision
          || (after.source.parentId === after.target.parentId
            && after.source.childrenRevision !== after.target.childrenRevision)) {
          throw new TypeError('Publisher Move Parent revisions did not advance consistently.');
        }

        const resultCandidate: NodeMoveResult = Object.freeze({
          node: after.node,
          sourceParentRevision: after.source.childrenRevision,
          targetParentRevision: after.target.childrenRevision,
          position: transformedPosition,
          warnings: [...receipt.warnings],
        });
        const result = snapshotMoveResult(resultCandidate, candidate, receipt.revision, transformedPosition);
        return writerResult(Object.freeze({ state: 'moved', value: result }), plan);
      },
    }, checkedLimits);

    return mapGuardedResult(guarded);
  } catch (error) {
    await notifyPublisherInternalFailureFromPorts(
      ports,
      'node-move',
      error,
    );
    return rejected('internal_error');
  }
}

function mapGuardedResult(result: PublisherGuardedNodeWriteResult<MoveWriterResult>): PublisherNodeMoveResult {
  if (result.state === 'rejected') return result as PublisherNodeMoveResult;
  if (result.value.state === 'moved') return Object.freeze({ state: 'committed', value: result.value.value });
  if (result.value.state === 'position-stale') return rejected('position_context_stale');
  if (result.value.state === 'revision-conflict') {
    const mapped = mapPublisherWriteConflictToProblem(result.value.precondition, true);
    if (mapped === undefined) throw new TypeError('Publisher Move conflict mapping unexpectedly allowed a conflict.');
    if (mapped.code !== 'revision_conflict') throw new TypeError('Publisher Move conflict mapped to the wrong Problem.');
    return Object.freeze({ state: 'rejected', code: mapped.code, status: mapped.status, retryable: mapped.retryable });
  }
  if (result.value.state === 'context-rejected') {
    const definition = getProblemDefinition(result.value.code);
    return Object.freeze({ state: 'rejected', code: result.value.code, ...definition });
  }
  const failure = result.value.failure;
  const mapped = mapPublisherPreconditionToProblem(failure);
  if (mapped.code !== failure.code) throw new TypeError('Publisher Move precondition mapped to the wrong Problem.');
  return Object.freeze({
    state: 'rejected' as const,
    code: failure.code,
    status: mapped.status,
    retryable: mapped.retryable,
    currentRevision: failure.currentRevision,
    ...(failure.currentEtag === undefined ? {} : { currentEtag: failure.currentEtag }),
  });
}

function rejected(code: 'internal_error' | 'position_context_stale'): PublisherNodeMoveResult {
  return Object.freeze({ state: 'rejected', code, ...getProblemDefinition(code) });
}

function writerResult(
  result: MoveWriterResult,
  plan: GuardedNodeWritePlan,
): { readonly result: MoveWriterResult; readonly modifiedNodeIds: readonly string[]; readonly deletedNodeIds: readonly string[]; readonly deletedNodeCount: number } {
  return Object.freeze({
    result,
    modifiedNodeIds: plan.modifiedNodeIds,
    deletedNodeIds: plan.deletedNodeIds,
    deletedNodeCount: plan.deletedNodeCount,
  });
}

function snapshotRequest(request: PublisherNodeMoveRequest): PublisherNodeMoveRequest {
  assertPlainSource(request, 'Publisher Node Move request');
  const command = cloneMoveRequestData(request, 'Publisher Node Move request');
  const allowed = new Set(['operation', 'ifMatch']);
  if (!Object.hasOwn(command, 'operation')
    || Reflect.ownKeys(command).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Publisher Node Move request contains unknown or missing fields.');
  }
  const operation = Object.freeze({ ...command.operation }) as PublisherNodeMoveOperation;
  if (operation.action !== 'move' || operation.targetId === undefined) {
    throw new TypeError('Publisher Node Move requires a target Move Operation.');
  }
  assertMoveOperationEnvelope(operation);
  if (command.ifMatch !== undefined && command.ifMatch !== null && typeof command.ifMatch !== 'string'
    && (!Array.isArray(command.ifMatch) || command.ifMatch.some((value) => typeof value !== 'string'))) {
    throw new TypeError('Publisher Node Move If-Match field is invalid.');
  }
  return Object.freeze({ operation, ...(command.ifMatch === undefined ? {} : { ifMatch: command.ifMatch }) });
}

function assertMoveOperationEnvelope(operation: PublisherNodeMoveOperation): void {
  const allowedOperationKeys = new Set([
    'operationId', 'replicaId', 'sequence', 'occurredAt', 'collectionId', 'action',
    'targetId', 'baseRevision', 'payload', 'dependencies', 'source',
  ]);
  if (Reflect.ownKeys(operation).some((key) => typeof key !== 'string' || !allowedOperationKeys.has(key))
    || !validators.validate('opaqueId', operation.operationId).valid
    || !validators.validate('opaqueId', operation.replicaId).valid
    || !Number.isSafeInteger(operation.sequence) || operation.sequence < 1
    || !validators.validate('dateTime', operation.occurredAt).valid
    || !validators.validate('opaqueId', operation.collectionId).valid
    || !validators.validate('opaqueId', operation.targetId).valid
    || !validators.validate('opaqueId', operation.baseRevision).valid
    || operation.payload === null || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) {
    throw new TypeError('Publisher Node Move Operation envelope is invalid.');
  }
  const payload = operation.payload as unknown as Record<string, unknown>;
  const allowedPayloadKeys = new Set([
    'newParentId', 'afterId', 'beforeId', 'baseSourceParentRevision', 'baseTargetParentRevision',
  ]);
  if (Reflect.ownKeys(payload).some((key) => typeof key !== 'string' || !allowedPayloadKeys.has(key))
    || !validators.validate('opaqueId', payload.newParentId).valid
    || (payload.afterId !== undefined && payload.afterId !== null
      && !validators.validate('opaqueId', payload.afterId).valid)
    || (payload.beforeId !== undefined && payload.beforeId !== null
      && !validators.validate('opaqueId', payload.beforeId).valid)
    || (payload.afterId !== undefined && payload.afterId !== null && payload.afterId === payload.beforeId)) {
    throw new TypeError('Publisher Node Move placement payload is invalid.');
  }
}

function inspectChildrenRevisionSyntax(
  payload: PublisherNodeMoveOperation['payload'],
): 'precondition_required' | 'precondition_failed' | undefined {
  const candidate = payload as unknown as Record<string, unknown>;
  if (!Object.hasOwn(candidate, 'baseSourceParentRevision')
    || !Object.hasOwn(candidate, 'baseTargetParentRevision')
    || candidate.baseSourceParentRevision === undefined
    || candidate.baseTargetParentRevision === undefined) return 'precondition_required';
  if (!validators.validate('opaqueId', candidate.baseSourceParentRevision).valid
    || !validators.validate('opaqueId', candidate.baseTargetParentRevision).valid) return 'precondition_failed';
  return undefined;
}

interface SnapshottedPorts<Context extends PublisherNodeMoveTransaction> extends GuardPorts<Context> {
  readonly application: PublisherOperationApplicationPort<Context>;
}

function snapshotPorts<Context extends PublisherNodeMoveTransaction>(
  ports: PublisherNodeMovePorts<Context>,
): SnapshottedPorts<Context> {
  assertPortObject(ports, 'Publisher Node Move ports');
  const unitOfWork = dataValue(ports, 'unitOfWork');
  const application = dataValue(ports, 'application');
  assertPortObject(unitOfWork, 'Publisher Node Move unit of work');
  assertPortObject(application, 'Publisher Node Move application');
  const run = bindMethod<GuardPorts<Context>['unitOfWork']['run']>(unitOfWork, 'run');
  const applyOperations = bindMethod<PublisherOperationApplicationPort<Context>['applyOperations']>(application, 'applyOperations');
  return Object.freeze({
    unitOfWork: Object.freeze({ run }),
    authenticate: bindMethod(ports, 'authenticate'),
    authorize: bindMethod(ports, 'authorize'),
    conceal: bindMethod(ports, 'conceal'),
    validate: bindMethod(ports, 'validate'),
    evaluatePolicy: bindMethod(ports, 'evaluatePolicy'),
    application: Object.freeze({
      applyOperations(batch: PublisherOperationBatch, context: Context) {
        return requirePromise(applyOperations(batch, context), 'Publisher Node Move application');
      },
    }),
  }) as SnapshottedPorts<Context>;
}

function assertMovePlan(plan: GuardedNodeWritePlan, request: PublisherNodeMoveRequest): void {
  const operation = request.operation;
  const sourceId = operation.targetId;
  const targetId = operation.payload.newParentId;
  const expectedModified = new Set([sourceId, targetId]);
  const expectedAuthorized = new Set([
    ...plan.modifiedNodeIds,
    ...(operation.payload.afterId === undefined || operation.payload.afterId === null
      ? [] : [operation.payload.afterId]),
    ...(operation.payload.beforeId === undefined || operation.payload.beforeId === null
      ? [] : [operation.payload.beforeId]),
  ]);
  // The authoritative old Parent is plan-derived and is therefore the one
  // additional modified identity for a cross-Parent Move.
  if (plan.mutation.kind !== 'move-node'
    || plan.mutation.nodeId !== sourceId
    || plan.mutation.parentId !== targetId
    || plan.mutation.afterId !== operation.payload.afterId
    || plan.mutation.beforeId !== operation.payload.beforeId
    || plan.collectionId !== operation.collectionId
    || plan.modifiedNodeIds.length < 2
    || plan.modifiedNodeIds.length > 3
    || ![...expectedModified].every((id) => plan.modifiedNodeIds.includes(id))
    || plan.authorizationNodeIds.length !== expectedAuthorized.size
    || !plan.authorizationNodeIds.every((id) => expectedAuthorized.delete(id))
    || expectedAuthorized.size !== 0
    || plan.deletedNodeIds.length !== 0
    || plan.deletedNodeCount !== 0) {
    throw new TypeError('Publisher Node Move received a mismatched Core plan.');
  }
}

interface MoveReferences {
  readonly node: Exclude<StrictNode, { readonly kind: 'root' }>;
  readonly source: PublisherNodeMovePositionContext;
  readonly target: PublisherNodeMovePositionContext;
}

interface MoveReaders {
  readonly resolveNode: NodeWriteResolver['resolveNode'];
  readonly resolveMovePositionContext: PublisherNodeMoveTransaction['resolveMovePositionContext'];
}

function snapshotMoveReaders<Context extends PublisherNodeMoveTransaction>(context: Context): MoveReaders {
  assertPortObject(context, 'Publisher Node Move transaction');
  return Object.freeze({
    resolveNode: bindMethod<NodeWriteResolver['resolveNode']>(context, 'resolveNode'),
    resolveMovePositionContext: bindMethod<PublisherNodeMoveTransaction['resolveMovePositionContext']>(
      context,
      'resolveMovePositionContext',
    ),
  });
}

async function resolveMoveNode(
  readers: MoveReaders,
  request: PublisherNodeMoveRequest,
): Promise<Exclude<StrictNode, { readonly kind: 'root' }>> {
  const candidate = await requirePromise(
    readers.resolveNode(request.operation.targetId),
    'Publisher Node Move Node resolver',
  );
  const node = snapshotNode(candidate, 'Node');
  if (node.kind === 'root' || node.parentId === null || node.collectionId !== request.operation.collectionId) {
    throw new TypeError('Publisher Node Move cannot move a Root or cross Collection boundaries.');
  }
  return node;
}

async function resolveReferences(
  readers: MoveReaders,
  request: PublisherNodeMoveRequest,
  sourceParentId?: string,
  requireSourceMembership = true,
  maxPositionChildren = resolveNodeWriteLimits().maxVisitedNodes,
): Promise<MoveReferences> {
  const node = await resolveMoveNode(readers, request);
  const authoritativeSourceParentId = sourceParentId ?? node.parentId;
  const sourceCandidate = await requirePromise(readers.resolveMovePositionContext(authoritativeSourceParentId), 'Publisher Node Move Source context resolver');
  const targetCandidate = authoritativeSourceParentId === request.operation.payload.newParentId
    ? sourceCandidate
    : await requirePromise(readers.resolveMovePositionContext(request.operation.payload.newParentId), 'Publisher Node Move Target context resolver');
  const source = snapshotPositionContext(
    sourceCandidate,
    authoritativeSourceParentId,
    node.collectionId,
    maxPositionChildren,
  );
  const target = authoritativeSourceParentId === request.operation.payload.newParentId
    ? source
    : snapshotPositionContext(
      targetCandidate,
      request.operation.payload.newParentId,
      node.collectionId,
      maxPositionChildren,
    );
  if (requireSourceMembership && !source.children.some((child) => child.id === node.id)) {
    throw new TypeError('Publisher Node Move Source context does not contain the authoritative Node.');
  }
  const sourceParent = await requirePromise(readers.resolveNode(source.parentId), 'Publisher Node Move Source Parent resolver');
  const checkedSourceParent = snapshotNode(sourceParent, 'Source Parent');
  if (checkedSourceParent.collectionId !== node.collectionId
    || (checkedSourceParent.kind !== 'root' && checkedSourceParent.kind !== 'folder')) {
    throw new TypeError('Publisher Node Move Source Parent is not a same-Collection Root or Folder.');
  }
  const targetParent = source.parentId === target.parentId
    ? checkedSourceParent
    : await requirePromise(readers.resolveNode(target.parentId), 'Publisher Node Move Target Parent resolver');
  const checkedTargetParent = snapshotNode(targetParent, 'Target Parent');
  if (checkedTargetParent.collectionId !== node.collectionId
    || (checkedTargetParent.kind !== 'root' && checkedTargetParent.kind !== 'folder')) {
    throw new TypeError('Publisher Node Move Target Parent is not a same-Collection Root or Folder.');
  }
  return Object.freeze({ node, source, target });
}

function snapshotPositionContext(
  candidate: unknown,
  parentId: string,
  collectionId: string,
  maxChildren: number,
): PublisherNodeMovePositionContext {
  assertPositionContextLimit(candidate, parentId, collectionId, maxChildren);
  assertPlainSource(candidate, 'Publisher Node Move position context');
  const context = immutableJsonData(candidate, 'Publisher Node Move position context') as PublisherNodeMovePositionContext;
  if (Reflect.ownKeys(context).length !== 3
    || context.parentId !== parentId
    || !validators.validate('opaqueId', context.childrenRevision).valid
    || !Array.isArray(context.children)) {
    throw new TypeError('Publisher Node Move resolver returned a malformed position context.');
  }
  const ids = new Set<string>();
  for (const [index, child] of context.children.entries()) {
    if (!validators.validate('node', child).valid || child.redacted === true
      || child.collectionId !== collectionId || child.parentId !== parentId || ids.has(child.id)) {
      throw new TypeError('Publisher Node Move position context contains an invalid child set.');
    }
    const previous = context.children[index - 1];
    if (previous !== undefined
      && (previous.position === null || child.position === null
        || compareOrderKeys(previous.position, child.position) >= 0)) {
      throw new TypeError('Publisher Node Move position context is not in strict Position order.');
    }
    ids.add(child.id);
  }
  return context;
}

function assertPositionContextLimit(
  candidate: unknown,
  parentId: string,
  collectionId: string,
  maxChildren: number,
): void {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)
    || nodeTypes.isProxy(candidate)) return;
  const children = Object.getOwnPropertyDescriptor(candidate, 'children');
  if (children === undefined || !('value' in children) || !Array.isArray(children.value)
    || nodeTypes.isProxy(children.value)) return;
  if (children.value.length > maxChildren) {
    throw new NodeWriteGuardError(Object.freeze({
      allowed: false,
      code: 'node_subtree_too_large',
      reason: 'Node Move position context exceeds maxVisitedNodes.',
      nodeId: parentId,
      collectionId,
      atNodeId: parentId,
    }));
  }
}

function snapshotNode(candidate: unknown, label: string): StrictNode {
  assertPlainSource(candidate, `Publisher Node Move ${label}`);
  const node = immutableJsonData(candidate, `Publisher Node Move ${label}`) as StrictNode;
  if (!validators.validate('node', node).valid || node.redacted === true) {
    throw new TypeError(`Publisher Node Move ${label} is malformed.`);
  }
  return node;
}

function validRequestedPlacement(
  context: PublisherNodeMovePositionContext,
  movingId: string,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
): boolean {
  const ids = context.children.map((node) => node.id).filter((id) => id !== movingId);
  return placementMatches(ids, undefined, afterId, beforeId);
}

function validAppliedPlacement(
  context: PublisherNodeMovePositionContext,
  movingId: string,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
): boolean {
  return placementMatches(context.children.map((node) => node.id), movingId, afterId, beforeId);
}

function placementMatches(
  ids: readonly string[],
  movingId: string | undefined,
  afterId: string | null | undefined,
  beforeId: string | null | undefined,
): boolean {
  if (afterId === undefined && beforeId === undefined) return true;
  if (afterId === null && beforeId === null) return true;
  const afterIndex = afterId === undefined || afterId === null ? -1 : ids.indexOf(afterId);
  const beforeIndex = beforeId === undefined || beforeId === null ? ids.length : ids.indexOf(beforeId);
  if ((afterId !== undefined && afterId !== null && afterIndex < 0)
    || (beforeId !== undefined && beforeId !== null && beforeIndex < 0)) return false;
  if (movingId === undefined) {
    if (afterId === undefined || beforeId === undefined) return true;
    return afterIndex + 1 === beforeIndex;
  }
  const movingIndex = ids.indexOf(movingId);
  if (movingIndex < 0) return false;
  if (afterId !== undefined && movingIndex !== afterIndex + 1) return false;
  if (beforeId !== undefined && movingIndex + 1 !== beforeIndex) return false;
  return true;
}

function exactTransformPosition(transform: Readonly<Record<string, unknown>>): string {
  if (Reflect.ownKeys(transform).length !== 1
    || !Object.hasOwn(transform, 'position')
    || !validators.validate('orderKey', transform.position).valid) {
    throw new TypeError('Publisher Move receipt transform must contain exactly the assigned Position.');
  }
  return transform.position as string;
}

function snapshotMoveResult(
  candidate: NodeMoveResult,
  request: PublisherNodeMoveRequest,
  revision: string,
  position: string,
): NodeMoveResult {
  const result = immutableJsonData(candidate, 'Publisher Node Move result') as NodeMoveResult;
  if (!validators.validate('nodeMoveResult', result).valid
    || result.node.id !== request.operation.targetId
    || result.node.collectionId !== request.operation.collectionId
    || result.node.parentId !== request.operation.payload.newParentId
    || result.node.revision !== revision
    || result.node.position !== position
    || result.position !== position) {
    throw new TypeError('Publisher Node Move result does not match the authoritative Move.');
  }
  return result;
}

function assertStableReferences(before: MoveReferences, after: MoveReferences): void {
  if (before.node.id !== after.node.id
    || before.node.collectionId !== after.node.collectionId
    || before.node.kind !== after.node.kind
    || before.source.parentId !== after.source.parentId
    || before.target.parentId !== after.target.parentId) {
    throw new TypeError('Publisher Node Move authoritative identities changed during application.');
  }
}

function cloneMoveRequestData<Value>(
  value: Value,
  label: string,
  ancestors = new Set<object>(),
): Value {
  if (value === undefined) return value;
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number') {
    return immutableJsonData(value, label);
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must contain only plain data.`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles.`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const clone = value.map((entry) => cloneMoveRequestData(entry, label, ancestors));
    ancestors.delete(value);
    return Object.freeze(clone) as Value;
  }
  const clone: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
    Object.defineProperty(clone, key, {
      value: cloneMoveRequestData(descriptor.value, label, ancestors),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  ancestors.delete(value);
  return Object.freeze(clone) as Value;
}

function assertPlainSource(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} cannot contain a Proxy.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype && prototype !== null
      || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new TypeError(`${label} arrays must be plain and dense.`);
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
    throw new TypeError(`Publisher Node Move ${name} must be a data property.`);
  }
  return descriptor.value;
}

function bindMethod<Method extends (...args: any[]) => unknown>(owner: object, name: string): Method {
  const method = dataValue(owner, name);
  if (typeof method !== 'function' || nodeTypes.isProxy(method)) {
    throw new TypeError(`Publisher Node Move ${name} must be a non-Proxy data method.`);
  }
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

function findDataProperty(owner: object, name: string): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) throw new TypeError('Publisher Node Move port prototype cannot be a Proxy.');
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
