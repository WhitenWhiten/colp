/**
 * Canonical Change Plan commit executor for MCP-W05.
 * Plan policy and approval stay in change-plan-service.ts.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  McpChangePlanError,
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAuthenticatedAuthorizationBinding,
  type McpStoredPlan,
} from '@know-n/colp/mcp';
import type {
  ChangePlanOperation,
  OperationResult,
} from '@know-n/colp/types';
import { canonicalJson } from '../commands/index.js';
import {
  CollectionPreconditionError,
  updateCollectionMetadataCanonical,
  updateCollectionMetadataCommandScope,
  deleteCollectionNode,
  deleteCollectionNodeCommandScope,
  moveCollectionNode,
  moveCollectionNodeCommandScope,
  updateCollectionNode,
  updateCollectionNodeCommandScope,
  type NodeVisibility,
  type ProductCollectionCanonicalPorts,
  type UpdateCollectionMetadataResult,
  type UpdateCollectionNodeResult,
} from '../collections/index.js';
import { allocateMcpPublicationSlug } from './publication-slug.js';
import { isMcpCollectionVisibilityRevisionMap } from './set-visibility-revisions.js';
import {
  type Phase4bMcpDeleteSubtreeOperation,
  type Phase4bMcpNodeCreateOperation,
  type Phase4bMcpNodeMoveOperation,
} from './change-plan-planner.js';
import { executeMcpNodeCreate } from './node-create-execution.js';
import { parseMcpNodeCreatePayload } from './node-create-payload.js';
import { projectLowRiskNodeCreateOutput } from './low-risk-node-create.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpDeleteSubtreeTombstoneFacts } from './change-plan-service.js';

export function revisionDrift(message: string): McpChangePlanError {
  return new McpChangePlanError('revision_drift', message);
}

export function commitFailure(message: string): McpChangePlanError {
  return new McpChangePlanError('commit_failed', message);
}

export async function executeCanonicalPlanOperations<Transaction extends object>(
  transaction: Transaction,
  operations: readonly unknown[],
  binding: McpAuthenticatedAuthorizationBinding,
  plansByTransaction: WeakMap<object, McpStoredPlan>,
  createProductPorts: (transaction: Transaction) => ProductCollectionCanonicalPorts,
  recordDeleteSubtreeTombstones?: (
    transaction: Transaction,
    facts: McpDeleteSubtreeTombstoneFacts,
  ) => Promise<void>,
): Promise<readonly OperationResult[]> {
  const ownedBinding = requireAuthenticatedWriteBinding(
    snapshotMcpAuthorizationBinding(binding),
  );
  const plan = plansByTransaction.get(transaction as object);
  if (plan === undefined) {
    throw commitFailure('Commit transaction did not lock a Plan before execution.');
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw commitFailure('Change Plan has no executable canonical operations.');
  }

  const results: OperationResult[] = [];
  for (const operation of operations) {
    const ports = createProductPorts(transaction);
    let result: OperationResult;
    if (isCreateNodeOperation(operation)) {
      result = await executeNodeCreate(ports, plan, operation, ownedBinding);
    } else if (isMoveNodeOperation(operation)) {
      result = await executeNodeMove(ports, plan, operation, ownedBinding);
    } else if (isDeleteSubtreeOperation(operation)) {
      result = await executeDeleteSubtree(
        ports,
        plan,
        operation,
        ownedBinding,
        transaction,
        recordDeleteSubtreeTombstones,
      );
    } else if (isSetVisibilityOperation(operation)) {
      result = await executeSetVisibility(ports, plan, operation, ownedBinding);
    } else {
      throw commitFailure('Change Plan contains an unknown or unregistered canonical operation.');
    }
    results.push(result);
  }
  return Object.freeze(results);
}

async function executeNodeCreate(
  ports: ProductCollectionCanonicalPorts,
  plan: McpStoredPlan,
  operation: Phase4bMcpNodeCreateOperation,
  binding: McpAuthenticatedAuthorizationBinding,
): Promise<OperationResult> {
  const commandId = randomUUID();
  const payload = operation.payload;
  const result = await executeMcpNodeCreate(ports, {
    collectionId: operation.collectionId,
    parentId: payload.parentId,
    afterId: payload.afterId ?? null,
    beforeId: payload.beforeId ?? null,
    node: parseMcpNodeCreatePayload(payload.node),
    idempotencyKey: commandId,
    expectedBaseRevisions: plan.baseRevisions,
  }, {
    binding,
    accountSubjectId: requireMcpAccountSubjectId(),
    scope: plan.requiredScopes,
  });
  const output = projectLowRiskNodeCreateOutput(result, commandId);
  return Object.freeze({
    opId: operation.opId,
    sequence: operation.sequence,
    status: 'applied' as const,
    revision: output.node.revision,
    cursor: output.receipt.commandId,
    warnings: Object.freeze([]),
  });
}

async function executeSetVisibility(
  ports: ProductCollectionCanonicalPorts,
  plan: McpStoredPlan,
  operation: Extract<ChangePlanOperation, { type: 'set_visibility' }>,
  binding: McpAuthenticatedAuthorizationBinding,
): Promise<OperationResult> {
  const visibility = readVisibility(operation);
  if (isMcpCollectionVisibilityRevisionMap(plan.baseRevisions)) {
    return executeCollectionSetVisibility(ports, plan, operation, binding, visibility);
  }
  if (visibility === 'public' || visibility === 'unlisted') {
    throw commitFailure(
      'public/unlisted node visibility is not in the MCP-W05 canonical mutation catalog; failing closed.',
    );
  }
  const nodeId = resolveSingleNodeId(plan.baseRevisions);
  if (nodeId === undefined) {
    throw commitFailure('Visibility Plan does not bind exactly one canonical node revision.');
  }
  const collectionId = readOpaqueId(operation.collectionId, 'collectionId');
  const commandId = randomUUID();
  const canonical = canonicalJson(Object.freeze({
    operation: 'nodes.set_visibility',
    binding: snapshotMcpAuthorizationBinding(binding),
    planId: plan.planId,
    collectionId,
    nodeId,
    visibility,
    baseRevision: operation.baseRevision,
    baseRevisions: plan.baseRevisions,
  }));
  if (canonical === undefined) {
    throw commitFailure('Visibility fingerprint is not canonical JSON.');
  }
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const result = await updateCollectionNode(ports, Object.freeze({
    actor: Object.freeze({
      principalId: binding.principalId,
      principalType: 'account' as const,
      subjectId: requireMcpAccountSubjectId(),
    }),
    command: Object.freeze({
      commandId,
      fingerprint,
      commandScope: updateCollectionNodeCommandScope(collectionId, nodeId),
    }),
    collectionId,
    nodeId,
    ifMatch: operation.baseRevision,
    patch: Object.freeze({ visibility: visibility as NodeVisibility }),
  }));
  if (result.kind === 'updated') {
    return visibilityOperationResult(plan.planId, nodeId, result.node.revision, commandId);
  }
  if (result.kind === 'replay') {
    return visibilityOperationResult(
      plan.planId,
      nodeId,
      decodeVisibilityReplay(result).revision,
      commandId,
    );
  }
  throw commitFailure('nodes.set_visibility returned an unknown or in-progress commit outcome.');
}

async function executeCollectionSetVisibility(
  ports: ProductCollectionCanonicalPorts,
  plan: McpStoredPlan,
  operation: Extract<ChangePlanOperation, { type: 'set_visibility' }>,
  binding: McpAuthenticatedAuthorizationBinding,
  visibility: 'public' | 'unlisted' | 'protected' | 'private',
): Promise<OperationResult> {
  if (visibility === 'protected') {
    throw commitFailure('Collection metadata does not support protected visibility.');
  }
  const collectionId = readOpaqueId(operation.collectionId, 'collectionId');
  const locked = await ports.collections.lockForUpdate(collectionId);
  if (!locked || locked.deletedAt !== null) {
    throw revisionDrift('Collection is unavailable.');
  }
  const publicationSlug = (visibility === 'public' || visibility === 'unlisted')
    && (locked.publicationSlug == null || locked.publicationSlug.length === 0)
    ? allocateMcpPublicationSlug(collectionId)
    : undefined;
  const commandId = randomUUID();
  const canonical = canonicalJson(Object.freeze({
    operation: 'collections.set_visibility',
    binding: snapshotMcpAuthorizationBinding(binding),
    planId: plan.planId,
    collectionId,
    visibility,
    ...(publicationSlug === undefined ? {} : { publicationSlug }),
    baseRevision: operation.baseRevision,
    baseRevisions: plan.baseRevisions,
  }));
  if (canonical === undefined) {
    throw commitFailure('Visibility fingerprint is not canonical JSON.');
  }
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
  try {
    const result = await updateCollectionMetadataCanonical(ports, Object.freeze({
      actor: Object.freeze({
        principalId: binding.principalId,
        principalType: 'account' as const,
        subjectId: requireMcpAccountSubjectId(),
      }),
      command: Object.freeze({
        commandId,
        fingerprint,
        commandScope: updateCollectionMetadataCommandScope(collectionId),
      }),
      collectionId,
      ifMatch: operation.baseRevision,
      patch: Object.freeze({
        visibility,
        ...(publicationSlug === undefined ? {} : { publicationSlug }),
      }),
      ...(ports.productOrigin === undefined ? {} : { productOrigin: ports.productOrigin }),
    }));
    if (result.kind === 'updated') {
      return visibilityOperationResult(
        plan.planId,
        collectionId,
        result.collection.revision,
        commandId,
      );
    }
    if (result.kind === 'replay') {
      return visibilityOperationResult(
        plan.planId,
        collectionId,
        decodeCollectionVisibilityReplay(result).revision,
        commandId,
      );
    }
    throw commitFailure('collections.set_visibility returned an unknown or in-progress commit outcome.');
  } catch (error) {
    if (error instanceof McpChangePlanError) throw error;
    if (error instanceof CollectionPreconditionError) {
      throw revisionDrift('Collection resource revision changed.');
    }
    throw commitFailure('Collection visibility mutation did not commit.');
  }
}

function visibilityOperationResult(
  planId: string,
  nodeId: string,
  revision: string,
  cursor: string,
): OperationResult {
  return Object.freeze({
    opId: visibilityOperationId(planId, nodeId),
    sequence: 1,
    status: 'applied' as const,
    revision,
    cursor,
    warnings: Object.freeze([]),
  });
}

function visibilityOperationId(planId: string, nodeId: string): string {
  return `op-${createHash('sha256')
    .update(`${planId}\0${nodeId}`, 'utf8')
    .digest('base64url')}`;
}

function decodeVisibilityReplay(
  result: Extract<UpdateCollectionNodeResult, { kind: 'replay' }>,
): Readonly<{ revision: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as unknown;
  } catch {
    throw commitFailure('Visibility replay receipt is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw commitFailure('Visibility replay receipt must be a JSON object.');
  }
  const node = (parsed as Readonly<Record<string, unknown>>).node;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw commitFailure('Visibility replay receipt node is invalid.');
  }
  const revision = (node as Readonly<Record<string, unknown>>).revision;
  if (typeof revision !== 'string' || revision.length === 0) {
    throw commitFailure('Visibility replay receipt node revision is invalid.');
  }
  return Object.freeze({ revision });
}

function decodeCollectionVisibilityReplay(
  result: Extract<UpdateCollectionMetadataResult, { kind: 'replay' }>,
): Readonly<{ revision: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as unknown;
  } catch {
    throw commitFailure('Visibility replay receipt is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw commitFailure('Visibility replay receipt must be a JSON object.');
  }
  const collection = (parsed as Readonly<Record<string, unknown>>).collection;
  if (typeof collection !== 'object' || collection === null || Array.isArray(collection)) {
    throw commitFailure('Visibility replay receipt collection is invalid.');
  }
  const revision = (collection as Readonly<Record<string, unknown>>).revision;
  if (typeof revision !== 'string' || revision.length === 0) {
    throw commitFailure('Visibility replay receipt collection revision is invalid.');
  }
  return Object.freeze({ revision });
}

function readVisibility(
  operation: Extract<ChangePlanOperation, { type: 'set_visibility' }>,
): 'public' | 'unlisted' | 'protected' | 'private' {
  const visibility = operation.input?.visibility;
  if (
    visibility === 'public'
    || visibility === 'unlisted'
    || visibility === 'protected'
    || visibility === 'private'
  ) {
    return visibility;
  }
  throw commitFailure('Visibility Plan contains an invalid visibility value.');
}

function resolveSingleNodeId(baseRevisions: Readonly<Record<string, string>>): string | undefined {
  const matches = Object.keys(baseRevisions).filter((key) => key.startsWith('node.'));
  if (matches.length !== 1) return undefined;
  const nodeId = matches[0]!.slice('node.'.length);
  return isOpaqueId(nodeId) ? nodeId : undefined;
}

function readOpaqueId(value: string, label: string): string {
  if (!isOpaqueId(value)) {
    throw commitFailure(`${label} is not a canonical opaque id.`);
  }
  return value;
}

function isOpaqueId(value: string): boolean {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9._~-]+$/u.test(value);
}

function isCreateNodeOperation(
  operation: unknown,
): operation is Phase4bMcpNodeCreateOperation {
  return (
    typeof operation === 'object'
    && operation !== null
    && (operation as { type?: unknown }).type === 'create_node'
  );
}

function isDeleteSubtreeOperation(
  operation: unknown,
): operation is Phase4bMcpDeleteSubtreeOperation {
  return (
    typeof operation === 'object'
    && operation !== null
    && (operation as { type?: unknown }).type === 'delete_subtree'
  );
}

async function executeDeleteSubtree<Transaction extends object>(
  ports: ProductCollectionCanonicalPorts,
  plan: McpStoredPlan,
  operation: Phase4bMcpDeleteSubtreeOperation,
  binding: McpAuthenticatedAuthorizationBinding,
  transaction: Transaction,
  recordDeleteSubtreeTombstones?: (
    transaction: Transaction,
    facts: McpDeleteSubtreeTombstoneFacts,
  ) => Promise<void>,
): Promise<OperationResult> {
  const nodeRevision = plan.baseRevisions[`node.${operation.nodeId}`];
  const contentRevision = plan.baseRevisions[`content.${operation.collectionId}`];
  if (typeof nodeRevision !== 'string' || nodeRevision.length === 0
    || typeof contentRevision !== 'string' || contentRevision.length === 0) {
    throw commitFailure('Delete Plan does not bind the node and content revisions.');
  }
  const commandId = randomUUID();
  const canonical = canonicalJson(Object.freeze({
    operation: 'nodes.delete_subtree',
    binding: snapshotMcpAuthorizationBinding(binding),
    planId: plan.planId,
    collectionId: operation.collectionId,
    nodeId: operation.nodeId,
    baseRevisions: plan.baseRevisions,
  }));
  if (canonical === undefined) throw commitFailure('Delete fingerprint is not canonical JSON.');
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const result = await deleteCollectionNode(ports, Object.freeze({
    actor: Object.freeze({
      principalId: binding.principalId,
      principalType: 'account' as const,
      subjectId: requireMcpAccountSubjectId(),
    }),
    command: Object.freeze({
      commandId,
      fingerprint,
      commandScope: deleteCollectionNodeCommandScope(operation.collectionId, operation.nodeId),
    }),
    collectionId: operation.collectionId,
    nodeId: operation.nodeId,
    ifMatch: nodeRevision,
    recursive: true,
    ifContentMatch: contentRevision,
  }));
  if (result.kind !== 'deleted') {
    throw commitFailure(`Delete Plan did not apply (${result.kind}).`);
  }
  if (recordDeleteSubtreeTombstones !== undefined) {
    try {
      await recordDeleteSubtreeTombstones(transaction, {
        collectionId: operation.collectionId,
        rootTargetId: operation.nodeId,
        operationId: result.operationId,
        commitOrdinal: result.commitOrdinal,
      });
    } catch (error) {
      const failure = commitFailure('Delete Plan did not write sync tombstones.');
      failure.cause = error;
      throw failure;
    }
  }
  return Object.freeze({
    opId: operation.nodeId,
    sequence: 1,
    status: 'applied' as const,
    revision: result.fence.contentRevision,
    cursor: commandId,
    warnings: Object.freeze([]),
  });
}

function isMoveNodeOperation(
  operation: unknown,
): operation is Phase4bMcpNodeMoveOperation {
  return (
    typeof operation === 'object'
    && operation !== null
    && (operation as { type?: unknown }).type === 'move_node'
  );
}

async function executeNodeMove(
  ports: ProductCollectionCanonicalPorts,
  plan: McpStoredPlan,
  operation: Phase4bMcpNodeMoveOperation,
  binding: McpAuthenticatedAuthorizationBinding,
): Promise<OperationResult> {
  const nodeRevision = plan.baseRevisions[`node.${operation.nodeId}`];
  const targetRevision = plan.baseRevisions[`children.${operation.parentId}`];
  const sourceParentId = operation.sourceParentId ?? operation.parentId;
  const sourceRevision = plan.baseRevisions[`children.${sourceParentId}`] ?? targetRevision;
  if (
    typeof nodeRevision !== 'string'
    || nodeRevision.length === 0
    || typeof targetRevision !== 'string'
    || targetRevision.length === 0
    || typeof sourceRevision !== 'string'
    || sourceRevision.length === 0
  ) {
    throw commitFailure('Move Plan does not bind the node and parent revisions.');
  }
  const commandId = randomUUID();
  const canonical = canonicalJson(Object.freeze({
    operation: 'nodes.move',
    binding: snapshotMcpAuthorizationBinding(binding),
    planId: plan.planId,
    collectionId: operation.collectionId,
    nodeId: operation.nodeId,
    parentId: operation.parentId,
    baseRevisions: plan.baseRevisions,
  }));
  if (canonical === undefined) {
    throw commitFailure('Move fingerprint is not canonical JSON.');
  }
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const result = await moveCollectionNode(ports, Object.freeze({
    actor: Object.freeze({
      principalId: binding.principalId,
      principalType: 'account' as const,
      subjectId: requireMcpAccountSubjectId(),
    }),
    command: Object.freeze({
      commandId,
      fingerprint,
      commandScope: moveCollectionNodeCommandScope(operation.collectionId, operation.nodeId),
    }),
    collectionId: operation.collectionId,
    nodeId: operation.nodeId,
    ifMatch: nodeRevision,
    newParentId: operation.parentId,
    // Integer position is not a sibling id. Absent position appends via null anchors.
    afterId: null,
    beforeId: null,
    baseSourceParentRevision: sourceRevision,
    baseTargetParentRevision: targetRevision,
  }));
  if (result.kind !== 'moved') {
    throw commitFailure(`Move Plan did not apply (${result.kind}).`);
  }
  return Object.freeze({
    opId: operation.nodeId,
    sequence: 1,
    status: 'applied' as const,
    revision: result.node.revision,
    cursor: commandId,
    warnings: Object.freeze([]),
  });
}

function isSetVisibilityOperation(
  operation: unknown,
): operation is Extract<ChangePlanOperation, { type: 'set_visibility' }> {
  return (
    typeof operation === 'object'
    && operation !== null
    && (operation as { type?: unknown }).type === 'set_visibility'
  );
}
