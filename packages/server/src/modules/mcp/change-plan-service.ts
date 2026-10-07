/**
 * MCP-W05 host application service for `changes.plan`, out-of-band Approval,
 * `changes.commit`, and `changes.cancel`.
 *
 * Plan creation stays with the W03 catalog planner so node identity and the
 * stronger Phase4b canonical digest remain authoritative. Approval, Commit,
 * and Cancel are delegated to the COLP Change Plan service with the W02
 * durable stores, transaction coordinator, W04 node-create executor, and a
 * host-owned digest verifier. Commit therefore revalidates binding, digest,
 * revisions, scope, impact, rate limit, expiry, and Approval inside the same
 * transaction before any canonical visibility mutation is executed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

import {
  McpChangePlanError,
  createChangePlanService,
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpApprovalStorePort,
  type McpAuthenticatedAuthorizationBinding,
  type McpChangePlanAuthorizationPolicyPort,
  type McpChangePlanClockPort,
  type McpChangePlanCommitApprovalStorePort,
  type McpChangePlanCommitCoordinatorPort,
  type McpChangePlanCommitPlanStorePort,
  type McpChangePlanCommitTransaction,
  type McpChangePlanExecutorPort,
  type McpChangePlanIdPort,
  type McpChangePlanImpactPort,
  type McpChangePlanRateLimitPort,
  type McpChangePlanRevisionMap,
  type McpChangePlanRevisionPort,
  type McpChangePlanScopePort,
  type McpChangePlanService,
  type McpChangePlanServiceOptions,
  type McpChangePlanStoredDigestPort,
  type McpChangePlanStorePort,
  type McpHttpUriPolicyPort,
  type McpPlanCommitResult,
  type McpStoredPlan,
  type McpWriteInputBudget,
} from '@know-n/colp/mcp';
import type {
  ChangePlanOperation,
  OperationResult,
  ScopeName,
} from '@know-n/colp/types';
import { canonicalJson } from '../commands/index.js';
import {
  CollectionPreconditionError,
  updateCollectionMetadataCanonical,
  updateCollectionMetadataCommandScope,
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
  computePhase4bMcpCanonicalDigest,
  type Phase4bMcpChangePlanPlanner,
  type Phase4bMcpNodeCreateOperation,
  type Phase4bMcpPlanOperation,
  type Phase4bMcpPlannedChange,
  type Phase4bMcpRiskLevel,
} from './change-plan-planner.js';
import { executeMcpNodeCreate } from './node-create-execution.js';
import { parseMcpNodeCreatePayload } from './node-create-payload.js';
import { projectLowRiskNodeCreateOutput } from './low-risk-node-create.js';
import { requireMcpAccountSubjectId } from './account-context.js';

export type Phase4bMcpChangePlanCommitTransaction = McpChangePlanCommitTransaction;

export interface Phase4bMcpChangePlanServiceOptions<
  Transaction extends object = Phase4bMcpChangePlanCommitTransaction,
> {
  readonly planner: Phase4bMcpChangePlanPlanner;
  readonly planStore: McpChangePlanStorePort;
  readonly approvalStore: McpApprovalStorePort;
  readonly commitPlanStore: McpChangePlanCommitPlanStorePort<Transaction>;
  readonly commitApprovalStore: McpChangePlanCommitApprovalStorePort<Transaction>;
  readonly begin: McpChangePlanCommitCoordinatorPort<Transaction>['begin'];
  readonly commit: McpChangePlanCommitCoordinatorPort<Transaction>['commit'];
  readonly rollback: McpChangePlanCommitCoordinatorPort<Transaction>['rollback'];
  readonly release: McpChangePlanCommitCoordinatorPort<Transaction>['release'];
  readonly createProductPorts: (
    transaction: Transaction,
  ) => ProductCollectionCanonicalPorts;
  readonly impact: McpChangePlanImpactPort;
  readonly revisions: McpChangePlanRevisionPort<Transaction>;
  readonly scopes: McpChangePlanScopePort;
  readonly authorizationPolicy: McpChangePlanAuthorizationPolicyPort;
  readonly rateLimit: McpChangePlanRateLimitPort;
  readonly verifyStoredOperationsDigest?: McpChangePlanStoredDigestPort;
  readonly approvalBaseUri: string;
  readonly uriPolicy: McpHttpUriPolicyPort;
  readonly clock?: McpChangePlanClockPort;
  readonly ids?: McpChangePlanIdPort;
  readonly planTtlMilliseconds?: number;
  readonly inputBudget?: McpWriteInputBudget;
  /**
   * Optional pre-built Commit coordinator. When provided, the service reuses
   * the exact coordinator object instead of building a second one from the
   * component ports above, so the host composition exposes a single
   * coordinator shared with the Write adapter.
   */
  readonly commitCoordinator?: McpChangePlanCommitCoordinatorPort<Transaction>;
}

export interface Phase4bMcpChangePlanService<
  Transaction extends object = Phase4bMcpChangePlanCommitTransaction,
> {
  readonly plan: (
    input: unknown,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<Phase4bMcpPlannedChange>;
  readonly recordOutOfBandApproval: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<void>;
  readonly commit: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
    idempotencyKey: string,
  ) => Promise<McpPlanCommitResult>;
  readonly cancel: (
    planId: string,
    binding: McpAuthenticatedAuthorizationBinding,
  ) => Promise<Readonly<{ planId: string; status: 'cancelled' }>>;
  readonly commitCoordinator: McpChangePlanCommitCoordinatorPort<Transaction>;
}

/**
 * Component ports used to build the single production Commit coordinator.
 */
export interface Phase4bMcpChangePlanCommitCoordinatorOptions<
  Transaction extends object,
> {
  readonly begin: McpChangePlanCommitCoordinatorPort<Transaction>['begin'];
  readonly commit: McpChangePlanCommitCoordinatorPort<Transaction>['commit'];
  readonly rollback: McpChangePlanCommitCoordinatorPort<Transaction>['rollback'];
  readonly release: McpChangePlanCommitCoordinatorPort<Transaction>['release'];
  readonly commitPlanStore: McpChangePlanCommitPlanStorePort<Transaction>;
  readonly commitApprovalStore: McpChangePlanCommitApprovalStorePort<Transaction>;
  readonly createProductPorts: (
    transaction: Transaction,
  ) => ProductCollectionCanonicalPorts;
}

/**
 * Builds the single production Commit coordinator shared by the W05 host
 * service and the W06 Write adapter. The executor is the canonical
 * change-plan executor (`create_node` + `set_visibility`) and the locked-Plan
 * binding facts live inside the coordinator so every caller observes the same
 * Plan that was locked inside the transaction.
 */
export function createPhase4bMcpChangePlanCommitCoordinator<
  Transaction extends object,
>(
  options: Phase4bMcpChangePlanCommitCoordinatorOptions<Transaction>,
): McpChangePlanCommitCoordinatorPort<Transaction> {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP-W05 commit coordinator requires an own-data options object.');
  }
  const plansByTransaction = new WeakMap<object, McpStoredPlan>();

  const begin: McpChangePlanCommitCoordinatorPort<Transaction>['begin'] = async (context) => {
    const transaction = await settle(options.begin(context));
    assertTransactionHandle(transaction);
    plansByTransaction.delete(transaction as object);
    return transaction;
  };

  const lock: McpChangePlanCommitPlanStorePort<Transaction>['lock'] = async (
    transaction,
    planId,
  ) => {
    const plan = await settle(options.commitPlanStore.lock(transaction, planId));
    if (plan !== undefined) {
      plansByTransaction.set(transaction as object, plan);
    }
    return plan;
  };

  const update: McpChangePlanCommitPlanStorePort<Transaction>['update'] = async (
    transaction,
    plan,
  ) => {
    await settle(options.commitPlanStore.update(transaction, plan));
    plansByTransaction.set(transaction as object, plan);
  };

  const executor: McpChangePlanExecutorPort<Transaction> = Object.freeze({
    execute: (
      transaction: Transaction,
      operations: readonly unknown[],
      binding: McpAuthenticatedAuthorizationBinding,
    ) =>
      executeCanonicalPlanOperations(
        transaction,
        operations,
        binding,
        plansByTransaction,
        options.createProductPorts,
      ),
  });

  return Object.freeze({
    begin,
    planStore: Object.freeze({ lock, update }),
    approvalStore: options.commitApprovalStore,
    executor,
    commit: options.commit,
    rollback: options.rollback,
    release: async (transaction: Transaction) => {
      try {
        await settle(options.release(transaction));
      } finally {
        plansByTransaction.delete(transaction as object);
      }
    },
  });
}

/**
 * Host digest verifier that revalidates the W03 Phase4b canonical digest.
 * The W03 digest intentionally covers operations, binding, revisions, scopes,
 * risk, and impact; COLP Commit uses this port instead of assuming the Plan
 * was minted by its own `plan` factory.
 */
export function createPhase4bMcpChangePlanDigestVerifier(): McpChangePlanStoredDigestPort {
  return Object.freeze({
    verify(plan: McpStoredPlan): boolean {
      return computePhase4bMcpStoredPlanDigest(plan) === plan.operationsDigest;
    },
  });
}

/** The single definition of the Phase4b digest over a stored Plan; producers and the verifier share it. */
export function computePhase4bMcpStoredPlanDigest(plan: McpStoredPlan): string {
  return computePhase4bMcpCanonicalDigest({
    operations: plan.operations as readonly Phase4bMcpPlanOperation[],
    binding: plan.binding,
    baseRevisions: plan.baseRevisions,
    requiredScopes: plan.requiredScopes as readonly ScopeName[],
    risk: plan.risk as Phase4bMcpRiskLevel,
    impact: plan.impact,
  });
}

/**
 * Revision port adapter for W03-persisted Plans. `resolveBaseRevisions` is not
 * used because Phase4b Plans are minted by the W03 planner; Commit still reads
 * the authoritative revisions from the same transaction-owned collection/node
 * ports before execution.
 */
export function createPhase4bMcpChangePlanRevisionPort<
  Transaction extends object,
>(
  createProductPorts: (transaction: Transaction) => ProductCollectionCanonicalPorts,
): McpChangePlanRevisionPort<Transaction> {
  return Object.freeze({
    async resolveBaseRevisions(): Promise<McpChangePlanRevisionMap> {
      throw new McpChangePlanError(
        'invalid_plan_request',
        'Phase4b Plans are created by the W03 catalog planner.',
      );
    },
    async currentRevisions(
      transaction: Transaction,
      baseRevisions: McpChangePlanRevisionMap,
      _binding: McpAuthenticatedAuthorizationBinding,
    ): Promise<McpChangePlanRevisionMap> {
      return currentRevisionsFromProductPorts(
        createProductPorts(transaction),
        baseRevisions,
      );
    },
  });
}

export function createPhase4bMcpChangePlanService<
  Transaction extends object,
>(
  options: Phase4bMcpChangePlanServiceOptions<Transaction>,
): Phase4bMcpChangePlanService<Transaction> {
  const resolved = readServiceOptions(options);

  const commitCoordinator = resolved.commitCoordinator
    ?? createPhase4bMcpChangePlanCommitCoordinator({
        begin: resolved.begin,
        commit: resolved.commit,
        rollback: resolved.rollback,
        release: resolved.release,
        commitPlanStore: resolved.commitPlanStore,
        commitApprovalStore: resolved.commitApprovalStore,
        createProductPorts: resolved.createProductPorts,
      });

  const changePlanOptions: McpChangePlanServiceOptions<Transaction> = Object.freeze({
    planStore: resolved.planStore,
    approvalStore: resolved.approvalStore,
    impact: resolved.impact,
    revisions: resolved.revisions,
    scopes: resolved.scopes,
    authorizationPolicy: resolved.authorizationPolicy,
    commitCoordinator,
    rateLimit: resolved.rateLimit,
    approvalBaseUri: resolved.approvalBaseUri,
    uriPolicy: resolved.uriPolicy,
    ...(resolved.verifyStoredOperationsDigest !== undefined
      ? { verifyStoredOperationsDigest: resolved.verifyStoredOperationsDigest }
      : {}),
    ...(resolved.clock !== undefined ? { clock: resolved.clock } : {}),
    ...(resolved.ids !== undefined ? { ids: resolved.ids } : {}),
    ...(resolved.planTtlMilliseconds !== undefined
      ? { planTtlMilliseconds: resolved.planTtlMilliseconds }
      : {}),
    ...(resolved.inputBudget !== undefined ? { inputBudget: resolved.inputBudget } : {}),
  });

  const colpService: McpChangePlanService = createChangePlanService(changePlanOptions);

  return Object.freeze({
    plan: async (input: unknown, binding: McpAuthenticatedAuthorizationBinding) => {
      const ownedBinding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(binding),
      );
      return resolved.planner.plan(input, ownedBinding);
    },
    recordOutOfBandApproval: colpService.recordOutOfBandApproval,
    commit: colpService.commit,
    cancel: colpService.cancel,
    commitCoordinator,
  });
}

interface ResolvedPhase4bMcpChangePlanServiceOptions<
  Transaction extends object,
> extends Omit<
  Phase4bMcpChangePlanServiceOptions<Transaction>,
  'begin' | 'commit' | 'rollback' | 'release'
> {
  readonly begin: Phase4bMcpChangePlanServiceOptions<Transaction>['begin'];
  readonly commit: Phase4bMcpChangePlanServiceOptions<Transaction>['commit'];
  readonly rollback: Phase4bMcpChangePlanServiceOptions<Transaction>['rollback'];
  readonly release: Phase4bMcpChangePlanServiceOptions<Transaction>['release'];
}

function readServiceOptions<Transaction extends object>(
  options: Phase4bMcpChangePlanServiceOptions<Transaction>,
): ResolvedPhase4bMcpChangePlanServiceOptions<Transaction> {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP-W05 service options must be an own-data object.');
  }
  for (const name of [
    'planner',
    'planStore',
    'approvalStore',
    'commitPlanStore',
    'commitApprovalStore',
    'begin',
    'commit',
    'rollback',
    'release',
    'createProductPorts',
    'impact',
    'revisions',
    'scopes',
    'authorizationPolicy',
    'rateLimit',
    'approvalBaseUri',
    'uriPolicy',
  ] as const) {
    readRequiredData(options, name);
  }
  const objectOptions = options as unknown as Readonly<Record<string, unknown>>;
  for (const name of [
    'planStore',
    'approvalStore',
    'commitPlanStore',
    'commitApprovalStore',
    'planner',
    'impact',
    'revisions',
    'scopes',
    'authorizationPolicy',
    'rateLimit',
  ] as const) {
    assertOwnDataObject(objectOptions[name], name);
  }
  for (const name of ['begin', 'commit', 'rollback', 'release', 'createProductPorts'] as const) {
    assertOwnDataFunction(objectOptions[name], name);
  }
  const approvalBaseUri = readOwnRequiredString(objectOptions, 'approvalBaseUri');
  const uriPolicy = objectOptions.uriPolicy as McpHttpUriPolicyPort;
  assertOwnDataObject(uriPolicy, 'uriPolicy');
  assertOwnDataFunction(
    Object.getOwnPropertyDescriptor(uriPolicy, 'allow')?.value,
    'uriPolicy.allow',
  );
  const verifyPort = objectOptions.verifyStoredOperationsDigest;
  if (verifyPort !== undefined) {
    assertOwnDataObject(verifyPort, 'verifyStoredOperationsDigest');
    assertOwnDataFunction(
      Object.getOwnPropertyDescriptor(verifyPort, 'verify')?.value,
      'verifyStoredOperationsDigest.verify',
    );
  }
  return Object.freeze({
    ...(options as unknown as ResolvedPhase4bMcpChangePlanServiceOptions<Transaction>),
    approvalBaseUri,
  });
}

async function executeCanonicalPlanOperations<Transaction extends object>(
  transaction: Transaction,
  operations: readonly unknown[],
  binding: McpAuthenticatedAuthorizationBinding,
  plansByTransaction: WeakMap<object, McpStoredPlan>,
  createProductPorts: (transaction: Transaction) => ProductCollectionCanonicalPorts,
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

async function currentRevisionsFromProductPorts(
  ports: ProductCollectionCanonicalPorts,
  baseRevisions: McpChangePlanRevisionMap,
): Promise<McpChangePlanRevisionMap> {
  const collectionId = deriveCollectionId(baseRevisions);
  if (collectionId === undefined) {
    throw revisionDrift('Plan revision map does not identify one collection.');
  }
  const result: Record<string, string> = {};
  for (const [namespace, expectedRevision] of Object.entries(baseRevisions)) {
    if (namespace.startsWith('content.')) {
      const locked = await ports.collections.lockForUpdate(namespace.slice('content.'.length));
      if (!locked || locked.deletedAt !== null) throw revisionDrift('Collection is unavailable.');
      result[namespace] = locked.contentRevision;
      continue;
    }
    if (namespace.startsWith('policy.')) {
      const locked = await ports.collections.lockForUpdate(namespace.slice('policy.'.length));
      if (!locked || locked.deletedAt !== null) throw revisionDrift('Collection is unavailable.');
      result[namespace] = locked.policyRevision;
      continue;
    }
    if (namespace.startsWith('node.')) {
      const nodeId = namespace.slice('node.'.length);
      const node = await ports.nodes.getNode(collectionId, nodeId);
      if (!node || node.deletedAt !== null) throw revisionDrift('Node is unavailable.');
      result[namespace] = node.resourceRevision;
      continue;
    }
    if (namespace.startsWith('children.')) {
      const parentId = namespace.slice('children.'.length);
      const parent = await ports.nodes.getNode(collectionId, parentId);
      if (!parent || parent.deletedAt !== null) throw revisionDrift('Parent node is unavailable.');
      result[namespace] = parent.childrenRevision;
      continue;
    }
    if (namespace.startsWith('resource.')) {
      const locked = await ports.collections.lockForUpdate(namespace.slice('resource.'.length));
      if (!locked || locked.deletedAt !== null) throw revisionDrift('Collection is unavailable.');
      result[namespace] = locked.resourceRevision;
      continue;
    }
    throw revisionDrift(`Unsupported Plan revision namespace ${namespace}.`);
  }
  for (const [namespace, revision] of Object.entries(result)) {
    if (revision !== baseRevisions[namespace]) {
      throw revisionDrift(`Base revision changed for ${namespace}.`);
    }
  }
  return Object.freeze(result);
}

function deriveCollectionId(baseRevisions: McpChangePlanRevisionMap): string | undefined {
  const candidates = Object.keys(baseRevisions)
    .filter((key) =>
      key.startsWith('content.') || key.startsWith('policy.') || key.startsWith('resource.'))
    .map((key) => key.slice(key.indexOf('.') + 1));
  const unique = new Set(candidates);
  return unique.size === 1 ? [...unique][0] : undefined;
}

function revisionDrift(message: string): McpChangePlanError {
  return new McpChangePlanError('revision_drift', message);
}

function commitFailure(message: string): McpChangePlanError {
  return new McpChangePlanError('commit_failed', message);
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

function isSetVisibilityOperation(
  operation: unknown,
): operation is Extract<ChangePlanOperation, { type: 'set_visibility' }> {
  return (
    typeof operation === 'object'
    && operation !== null
    && (operation as { type?: unknown }).type === 'set_visibility'
  );
}

function assertTransactionHandle(transaction: unknown): asserts transaction is object {
  if (typeof transaction !== 'object' || transaction === null || nodeTypes.isProxy(transaction)) {
    throw commitFailure('Transaction coordinator returned an invalid transaction handle.');
  }
}

function readRequiredData(options: object, name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`MCP-W05 requires own data option ${name}.`);
  }
}

function assertOwnDataObject(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value)) {
    throw new TypeError(`MCP-W05 ${name} must be an own-data object port.`);
  }
}

function assertOwnDataFunction(value: unknown, name: string): void {
  if (typeof value !== 'function' || nodeTypes.isProxy(value)) {
    throw new TypeError(`MCP-W05 ${name} must be an own-data function.`);
  }
}

function readOwnRequiredString(
  value: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'string'
    || descriptor.value.length === 0
  ) {
    throw new TypeError(`MCP-W05 requires non-empty string option ${name}.`);
  }
  return descriptor.value;
}

async function settle<Value>(candidate: Value | PromiseLike<Value>): Promise<Value> {
  if (candidate !== null && typeof candidate === 'object' && 'then' in candidate) {
    return await candidate;
  }
  return candidate;
}
