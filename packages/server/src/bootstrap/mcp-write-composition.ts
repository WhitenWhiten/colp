import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type {
  Mcp20260728WritePlanStatusPort,
  Mcp20260728WriteToolAdapter,
  Mcp20260728XMcpHeaderDeclaration,
  McpApprovalStorePort,
  McpAuthenticatedAuthorizationBinding,
  McpChangePlanCommitApprovalStorePort,
  McpChangePlanCommitCoordinatorPort,
  McpChangePlanRateLimitPort,
  McpChangePlanRevisionMap,
  McpChangePlanRevisionPort,
  McpChangePlanServiceOptions,
} from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  ScopeName,
} from '@know-n/colp/types';
import { observeBestEffort } from '../infrastructure/async/best-effort.js';
import { authorizeCapability } from '../modules/access-policy/index.js';
import type { ProductCollectionCanonicalPorts } from '../modules/collections/index.js';
import {
  PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME,
  decideMcpSetVisibilityRevisions,
  MCP_OWN_DATA_DEFAULT_BUDGET,
  requireMcpAccountSubjectId,
} from '../modules/mcp/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../infrastructure/access-policy/index.js';
import {
  createPostgresAnnotationMutationUnitOfWork,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionWritePort,
  createPostgresNodeWritePort,
} from '../infrastructure/collections/index.js';
import { createPostgresMcpChangePlanStore, createUnitOfWork, type DatabaseSchema, type DatabaseTransaction, type PostgresMcpStoredPlan } from '../infrastructure/database/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../infrastructure/outbox/index.js';
import { createPhase4bMcpGatewayPlanner } from '../modules/mcp/change-plan-gateway-planner.js';
import { createMcpWriteProductPorts } from './mcp-write-postgres-ports.js';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import {
  createMcpChangePlanRateLimitPort,
  type McpChangePlanRateLimitOptions,
} from '../infrastructure/rate-limit/index.js';
import {
  createPhase4bMcpChangePlanDigestVerifier,
  createPhase4bMcpChangePlanPlanner,
  createPhase4bMcpChangePlanRevisionPort,
  createPhase4bMcpChangePlanService,
  createPhase4bMcpLowRiskAnnotationCreateService,
  createPhase4bMcpLowRiskAnnotationInspect,
  createPhase4bMcpLowRiskAnnotationUpdateService,
  createPhase4bMcpLowRiskNodeCreateService,
  createPhase4bMcpLowRiskNodeUpdateService,
  createPhase4bMcpLowRiskCollectionUpdateService,
  createPhase4bMcpLowRiskChangeGetService,
  createPhase4bMcpOwnedCollectionCreateService,
  createPhase4bMcpWritePlanStatusPort,
  createPhase4bMcpWriteToolAdapter,
  createPhase4bMcpChangePlanCommitCoordinator,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpChangePlanService,
  type Phase4bMcpChangePlanServiceOptions,
  type Phase4bMcpLowRiskNodeCreateInspect,
  type Phase4bMcpLowRiskNodeCreateInspectPorts,
  type Phase4bMcpLowRiskNodeCreateService,
  type Phase4bMcpStoredPlan,
} from '../modules/mcp/index.js';

export interface Phase4bMcpWriteCompositionOptions {
  readonly db: Kysely<DatabaseSchema>;
  readonly serverUuid: string;
  readonly approvalBaseUri: string;
  readonly requestStateKey: string | Uint8Array;
  readonly allowedScopes?: readonly string[];
  readonly metrics?: Metrics;
  readonly planTtlMilliseconds?: number;
  readonly requestStateTtlSeconds?: number;
  readonly requestStateClock?: () => number;
  readonly rateLimit: McpChangePlanRateLimitPort;
  readonly productOrigin?: string;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  /** Optional ND-13B source-fence fan-out for MCP-owned Collection writes. */
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  readonly beforeBeginCommit?: (
    input: Readonly<{ readonly planId: string; readonly transaction: DatabaseTransaction }>,
  ) => Promise<void>;
}

export interface Phase4bMcpWriteComposition {
  readonly adapter: Mcp20260728WriteToolAdapter;
  readonly paramDeclarations: readonly Mcp20260728XMcpHeaderDeclaration[];
  readonly store: ReturnType<typeof createPostgresMcpChangePlanStore>;
  readonly changePlanService: Phase4bMcpChangePlanService<DatabaseTransaction>;
  readonly changePlanOptions: McpChangePlanServiceOptions;
  readonly nodeCreateService: Phase4bMcpLowRiskNodeCreateService;
  readonly planStatusPort: Mcp20260728WritePlanStatusPort;
  /**
   * The single production Commit coordinator shared by the Write adapter, the
   * host change-plan service, and the plan-status surface. Its executor is
   * the canonical change-plan executor (create_node + set_visibility).
   */
  readonly commitCoordinator: McpChangePlanCommitCoordinatorPort<DatabaseTransaction>;
}

// The single-process commit rate/cost port and its options moved to the
// unified FIX-M-018 MCP rate-limit module; re-exported here so existing
// compositions and tests keep one import surface.
export { createMcpChangePlanRateLimitPort };
export type { McpChangePlanRateLimitOptions };

/**
 * Read-only inspection for `nodes.create` preview. Uses a separate transaction
 * and SELECT FOR SHARE; it never claims receipts or executes canonical mutation.
 */
export function createPhase4bMcpLowRiskNodeCreateInspect(
  db: Kysely<DatabaseSchema>,
  metrics?: Metrics,
): Phase4bMcpLowRiskNodeCreateInspect {
  const unitOfWork = createUnitOfWork(db);
  return Object.freeze({
    execute: <Result>(
      work: (ports: Phase4bMcpLowRiskNodeCreateInspectPorts) => Promise<Result>,
    ): Promise<Result> => unitOfWork.execute(async ({ transaction }) => {
      const collections = createPostgresCollectionWritePort(transaction, metrics);
      const nodes = createPostgresNodeWritePort(transaction, metrics);
      const accessPolicy = createPostgresAccessPolicyFactsPort(transaction);
      return work(Object.freeze({
        getCollection: (collectionId: string) => collections.lockForShare(collectionId),
        getNode: (collectionId: string, nodeId: string) => nodes.getNode(collectionId, nodeId),
        accessPolicy,
      }));
    }),
  });
}

/**
 * Production MCP-W06 composition. W02 store, W03 planner, W04 low-risk
 * service, W05 approved Change Plan service, and W09 durable stores are all
 * real PostgreSQL-backed; there are no in-memory write ports here.
 * Write Tool schemas stay in `write-tools.ts` (and COLP for plan/commit/cancel).
 * Transport wraps this COLP adapter with `toNeutralWritePort` before the
 * application facade; do not copy a second catalog.
 */
export function createPhase4bMcpWriteComposition(
  options: Phase4bMcpWriteCompositionOptions,
): Phase4bMcpWriteComposition {
  if (
    options.rateLimit === undefined
    || typeof options.rateLimit !== 'object'
    || options.rateLimit === null
    || typeof options.rateLimit.allow !== 'function'
  ) {
    throw new TypeError('MCP-W10 write composition requires an explicit rateLimit port');
  }
  const store = createPostgresMcpChangePlanStore(options.db);
  // FIX-L-052: the store rejects claims on cancelled Plans with the dedicated
  // `plan_cancelled` reason; the version-locked COLP port types (built dist)
  // do not carry that reason yet, so adapt the structurally-wider store ports
  // once at this composition boundary.
  const approvalStore = store.approvalStore as unknown as McpApprovalStorePort;
  const commitApprovalStore = wrapCommitApprovalStore(
    store.commitApprovalStore as unknown as McpChangePlanCommitApprovalStorePort<DatabaseTransaction>,
    options.beforeBeginCommit,
  );
  const canonicalUnitOfWork = createPostgresCanonicalMutationUnitOfWork(options.db, {
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
    ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
  });
  const createProductPorts = (transaction: DatabaseTransaction): ProductCollectionCanonicalPorts =>
    createMcpWriteProductPorts(
      transaction,
      options.productOrigin,
      options.reportSourceInvalidation,
    );
  const transactionCoordinator = createPostgresMcpDeferredTransactionCoordinator(options.db);
  const revisions = createPhase4bMcpWriteRevisionPort(
    options.db,
    createAuthoritativeState(options.db),
    createPhase4bMcpChangePlanRevisionPort(createProductPorts),
  );
  const inspect = createPhase4bMcpLowRiskNodeCreateInspect(options.db, options.metrics);
  const nodeCreateService = createPhase4bMcpLowRiskNodeCreateService({
    unitOfWork: canonicalUnitOfWork,
    inspect,
  });
  const collectionCreateService = createPhase4bMcpOwnedCollectionCreateService({
    unitOfWork: canonicalUnitOfWork,
  });
  const nodeUpdateService = createPhase4bMcpLowRiskNodeUpdateService({
    unitOfWork: canonicalUnitOfWork,
    inspect,
  });
  const collectionUpdateService = createPhase4bMcpLowRiskCollectionUpdateService({
    unitOfWork: canonicalUnitOfWork,
    inspect,
  });
  const annotationMutationUnitOfWork = createPostgresAnnotationMutationUnitOfWork(options.db, { ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }) });
  const annotationInspect = createPhase4bMcpLowRiskAnnotationInspect(annotationMutationUnitOfWork);
  const annotationCreateService = createPhase4bMcpLowRiskAnnotationCreateService({
    unitOfWork: annotationMutationUnitOfWork,
    resolveAnnotationCreator: createAnnotationCreatorResolver(options),
    inspect: annotationInspect,
  });
  const annotationUpdateService = createPhase4bMcpLowRiskAnnotationUpdateService({
    unitOfWork: annotationMutationUnitOfWork,
    inspect: annotationInspect,
  });
  const changeGetService = createPhase4bMcpLowRiskChangeGetService({
    planStore: store.planStore,
  });
  const planner = createPhase4bMcpChangePlanPlanner(
    createPlannerOptions(options, store),
  );
  // FIX-M-016: exactly one production Commit coordinator. The W05 service and
  // the W06 Write adapter share this single change-plan-service coordinator,
  // whose executor is the canonical executor (create_node + set_visibility).
  const commitCoordinator = createPhase4bMcpChangePlanCommitCoordinator<DatabaseTransaction>({
    begin: transactionCoordinator.begin,
    commit: transactionCoordinator.commit,
    rollback: transactionCoordinator.rollback,
    release: transactionCoordinator.release,
    commitPlanStore: store.commitPlanStore,
    commitApprovalStore,
    createProductPorts,
  });
  const gatewayChangePlanOptions = {
    planStore: store.planStore,
    approvalStore,
    impact: createImpactPort(),
    revisions,
    scopes: createScopePort(options.allowedScopes),
    authorizationPolicy: createAuthorizationPolicy(),
    commitCoordinator,
    rateLimit: options.rateLimit,
    verifyStoredOperationsDigest: createPhase4bMcpChangePlanDigestVerifier(),
    approvalBaseUri: options.approvalBaseUri,
    uriPolicy: createApprovalUriPolicy(options.approvalBaseUri),
    clock: { now: () => new Date() },
    ids: { nextPlanId: () => `plan-w10-${randomUUID().replaceAll('-', '')}` },
    ...(options.planTtlMilliseconds === undefined
      ? {}
      : { planTtlMilliseconds: options.planTtlMilliseconds }),
  } as unknown as McpChangePlanServiceOptions;
  // The gateway mints `changes.plan` with the Phase4b digest that Commit verifies.
  const changePlanOptions = {
    ...gatewayChangePlanOptions,
    planner: createPhase4bMcpGatewayPlanner(gatewayChangePlanOptions),
  } as unknown as McpChangePlanServiceOptions;
  const serviceOptions: Phase4bMcpChangePlanServiceOptions<DatabaseTransaction> = {
    planner,
    planStore: store.planStore,
    approvalStore,
    commitPlanStore: store.commitPlanStore,
    commitApprovalStore,
    begin: transactionCoordinator.begin,
    commit: transactionCoordinator.commit,
    rollback: transactionCoordinator.rollback,
    release: transactionCoordinator.release,
    commitCoordinator,
    createProductPorts,
    impact: createImpactPort(),
    revisions,
    scopes: createScopePort(options.allowedScopes),
    authorizationPolicy: createAuthorizationPolicy(),
    rateLimit: options.rateLimit,
    verifyStoredOperationsDigest: createPhase4bMcpChangePlanDigestVerifier(),
    approvalBaseUri: options.approvalBaseUri,
    uriPolicy: createApprovalUriPolicy(options.approvalBaseUri),
    clock: { now: () => new Date() },
    ids: { nextPlanId: () => `plan-w10-${randomUUID().replaceAll('-', '')}` },
    ...(options.planTtlMilliseconds === undefined
      ? {}
      : { planTtlMilliseconds: options.planTtlMilliseconds }),
  };
  const changePlanService = createPhase4bMcpChangePlanService(serviceOptions);
  const planStatusPort = createPhase4bMcpWritePlanStatusPort(
    store.planStore,
    () => Date.now(),
  );
  const bundle = createPhase4bMcpWriteToolAdapter({
    changePlan: changePlanOptions,
    nodeCreateService,
    collectionCreateService,
    nodeUpdateService,
    collectionUpdateService,
    annotationCreateService,
    annotationUpdateService,
    changeGetService,
    resolvePlan: planStatusPort,
    requestStateKey: options.requestStateKey,
    ...(options.requestStateTtlSeconds === undefined
      ? {}
      : { requestStateTtlSeconds: options.requestStateTtlSeconds }),
    ...(options.requestStateClock === undefined
      ? {}
      : { requestStateClock: options.requestStateClock }),
  });
  return Object.freeze({
    adapter: bundle.adapter,
    paramDeclarations: bundle.paramDeclarations,
    store,
    changePlanService,
    changePlanOptions,
    nodeCreateService,
    planStatusPort,
    commitCoordinator,
  });
}

function createAnnotationCreatorResolver(
  options: Phase4bMcpWriteCompositionOptions,
): (accountId: string) => Promise<{ id: string; name: string } | null> {
  const identityUnitOfWork = options.identityUnitOfWork;
  const productOrigin = options.productOrigin;
  if (identityUnitOfWork === undefined || productOrigin === undefined || productOrigin.length === 0) {
    return async () => null;
  }
  return async (accountId: string) => identityUnitOfWork.execute(async (ports) => {
    const [profile, handle] = await Promise.all([
      ports.profiles.findByAccountId(accountId),
      ports.handles.findByAccountId(accountId),
    ]);
    if (!profile || !handle) return null;
    return Object.freeze({
      id: `${productOrigin}/profiles/${encodeURIComponent(handle.handle)}`,
      name: profile.displayName || handle.handle,
    });
  });
}

function createPlannerOptions(
  options: Phase4bMcpWriteCompositionOptions,
  store: ReturnType<typeof createPostgresMcpChangePlanStore>,
): Phase4bMcpChangePlanPlannerOptions {
  return Object.freeze({
    planStore: Object.freeze({
      save: (plan: Phase4bMcpStoredPlan) => store.planStore.save(plan as PostgresMcpStoredPlan),
      get: (planId: string) => store.planStore.get(planId) as Promise<Phase4bMcpStoredPlan | undefined>,
    }),
    authoritativeState: createAuthoritativeState(options.db),
    authorizationPolicy: createAuthorizationPolicy(),
    impact: createImpactPort(),
    approvalBaseUri: options.approvalBaseUri,
    approvalUriPolicy: createApprovalUriPolicy(options.approvalBaseUri),
    serverUuid: options.serverUuid,
    clock: { now: () => new Date() },
    ids: Object.freeze({
      nextPlanId: () => `plan-w10-${randomUUID().replaceAll('-', '')}`,
      nextOperationId: () => `op-w10-${randomUUID().replaceAll('-', '')}`,
    }),
    ...(options.planTtlMilliseconds === undefined
      ? {}
      : { planTtlMilliseconds: options.planTtlMilliseconds }),
    inputBudget: MCP_OWN_DATA_DEFAULT_BUDGET,
  });
}

/**
 * Client-facing planning failure. Same throw for missing resources and
 * unauthorized actors so `changes.plan` cannot confirm existence. The write
 * error classifier maps this to `stale_revision` without the current revision.
 * Internal logs may still key off `code: 'MCP-W10'`.
 */
export const AUTHORITATIVE_STATE_UNAVAILABLE_MESSAGE =
  'MCP-W03 could not resolve authoritative state for planning.';

function throwAuthoritativeStateUnavailable(): never {
  const error = new Error(AUTHORITATIVE_STATE_UNAVAILABLE_MESSAGE);
  error.name = PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME;
  Object.assign(error, { code: 'MCP-W10' });
  throw error;
}

function actorFromWriteBinding(binding: McpAuthenticatedAuthorizationBinding) {
  return Object.freeze({
    principalId: binding.principalId,
    subjectId: requireMcpAccountSubjectId(),
    kind: 'account' as const,
  });
}

async function authorizeAuthoritativeCapability(
  trx: Kysely<DatabaseSchema>,
  collectionId: string,
  binding: McpAuthenticatedAuthorizationBinding,
  capability: 'read_editor' | 'create_node' | 'update_node' | 'manage_publication',
): Promise<void> {
  const decision = await authorizeCapability(
    createPostgresAccessPolicyFactsPort(trx),
    {
      collectionId,
      actor: actorFromWriteBinding(binding),
      capability,
    },
  );
  if (decision.outcome !== 'allow') {
    throwAuthoritativeStateUnavailable();
  }
}

export function createAuthoritativeState(db: Kysely<DatabaseSchema>) {
  return Object.freeze({
    async resolveCreateBaseRevisions(
      input: { collectionId: string; parentId: string },
      binding: McpAuthenticatedAuthorizationBinding,
    ) {
      return db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
        const collection = await trx.selectFrom('collections')
          .select(['content_revision', 'visibility'])
          .where('id', '=', input.collectionId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const parent = await trx.selectFrom('nodes')
          .select(['children_revision'])
          .where('id', '=', input.parentId)
          .where('collection_id', '=', input.collectionId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        await authorizeAuthoritativeCapability(
          trx,
          input.collectionId,
          binding,
          'create_node',
        );
        if (!collection || !parent) throwAuthoritativeStateUnavailable();
        return Object.freeze({
          parentChildrenRevision: parent.children_revision,
          collectionContentRevision: collection.content_revision,
          collectionVisibility: collection.visibility,
        });
      });
    },
    async resolveVisibilityFacts(
      input: { collectionId: string; nodeId: string },
      binding: McpAuthenticatedAuthorizationBinding,
    ) {
      return db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
        const node = await trx.selectFrom('nodes')
          .select(['resource_revision'])
          .where('id', '=', input.nodeId)
          .where('collection_id', '=', input.collectionId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        const collection = await trx.selectFrom('collections')
          .select(['policy_revision'])
          .where('id', '=', input.collectionId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        await authorizeAuthoritativeCapability(
          trx,
          input.collectionId,
          binding,
          'update_node',
        );
        if (!node || !collection) throwAuthoritativeStateUnavailable();
        return Object.freeze({
          resourceRevision: node.resource_revision,
          policyRevision: collection.policy_revision,
        });
      });
    },
  });
}

function createPhase4bMcpWriteRevisionPort(
  db: Kysely<DatabaseSchema>,
  authoritativeState: ReturnType<typeof createAuthoritativeState>,
  currentRevisions: McpChangePlanRevisionPort<DatabaseTransaction>,
): McpChangePlanRevisionPort<DatabaseTransaction> {
  return Object.freeze({
    async resolveBaseRevisions(
      operation: ChangePlanOperation,
      binding: McpAuthenticatedAuthorizationBinding,
    ): Promise<McpChangePlanRevisionMap> {
      const type = (operation as { type?: unknown }).type;
      if (type === 'set_visibility') {
        const typed = operation as Extract<ChangePlanOperation, { type: 'set_visibility' }>;
        const visibility = typed.input?.visibility;
        if (
          visibility !== 'public'
          && visibility !== 'unlisted'
          && visibility !== 'protected'
          && visibility !== 'private'
        ) {
          throwAuthoritativeStateUnavailable();
        }
        return db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
          const collection = await trx.selectFrom('collections')
            .select(['id', 'resource_revision', 'policy_revision'])
            .where('id', '=', typed.collectionId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          const matchingNodes = await trx.selectFrom('nodes')
            .select(['id', 'resource_revision'])
            .where('collection_id', '=', typed.collectionId)
            .where('resource_revision', '=', typed.baseRevision)
            .where('deleted_at', 'is', null)
            .execute();
          const decision = collection === undefined
            ? null
            : decideMcpSetVisibilityRevisions({
              visibility,
              collectionId: typed.collectionId,
              baseRevision: typed.baseRevision,
              collectionResourceRevision: collection.resource_revision,
              collectionPolicyRevision: collection.policy_revision,
              matchingNodes: matchingNodes.map((node) => Object.freeze({
                id: node.id,
                resourceRevision: node.resource_revision,
              })),
            });
          await authorizeAuthoritativeCapability(
            trx,
            typed.collectionId,
            binding,
            decision?.kind === 'collection' ? 'manage_publication' : 'update_node',
          );
          if (decision === null) {
            throwAuthoritativeStateUnavailable();
          }
          return decision.map;
        });
      }
      throw new Error('MCP-W10 revision port rejects unknown canonical operation type');
    },
    currentRevisions(
      transaction: DatabaseTransaction,
      baseRevisions: McpChangePlanRevisionMap,
      binding: McpAuthenticatedAuthorizationBinding,
    ) {
      return currentRevisions.currentRevisions(transaction, baseRevisions, binding);
    },
  });
}

function createAuthorizationPolicy() {
  return Object.freeze({
    async requiredScopesForOperation(operation: unknown) {
      const type = (operation as { type?: unknown }).type;
      if (type === 'create_node') {
        return Object.freeze(['nodes:write'] as readonly ScopeName[]);
      }
      if (type === 'set_visibility') {
        return Object.freeze(['access:write'] as readonly ScopeName[]);
      }
      return Object.freeze([] as readonly ScopeName[]);
    },
  });
}

function createScopePort(allowedScopes: readonly string[] | undefined) {
  const scopes = new Set(allowedScopes ?? []);
  return Object.freeze({
    async hasScopes(requiredScopes: readonly ScopeName[]) {
      return requiredScopes.every((scope) => scopes.has(scope));
    },
  });
}

function createImpactPort() {
  return Object.freeze({
    async assessImpact(operations: readonly unknown[]): Promise<ChangePlanImpact> {
      const collections = new Set<string>();
      let nodes = 0;
      for (const operation of operations) {
        const type = (operation as { type?: unknown }).type;
        const collectionId = typeof (operation as { collectionId?: unknown }).collectionId === 'string'
          ? (operation as { collectionId: string }).collectionId
          : '';
        if (type === 'create_node') {
          if (collectionId) collections.add(collectionId);
          nodes += 1;
        }
        if (type === 'set_visibility') {
          if (collectionId) collections.add(collectionId);
          const visibility = (operation as { input?: { visibility?: unknown } }).input?.visibility;
          if (visibility !== 'public' && visibility !== 'unlisted') {
            nodes += 1;
          }
        }
      }
      return Object.freeze({
        collections: collections.size,
        nodes,
        annotations: 0,
        attachments: 0,
        relations: 0,
        privateFieldsExcluded: [] as string[],
      });
    },
  });
}

function createApprovalUriPolicy(approvalBaseUri: string) {
  const allowedOrigin = new URL(approvalBaseUri).origin;
  return Object.freeze({
    allow(input: Readonly<{ purpose: string; origin: string }>) {
      return input.purpose === 'approval' && input.origin === allowedOrigin;
    },
  });
}

function createPostgresMcpDeferredTransactionCoordinator(db: Kysely<DatabaseSchema>) {
  const states = new Map<DatabaseTransaction, {
    readonly transaction: DatabaseTransaction;
    readonly resolveFinish: (value: unknown) => void;
    readonly promise: Promise<unknown>;
  }>();
  return Object.freeze({
    async begin(): Promise<DatabaseTransaction> {
      let resolveStart!: (transaction: DatabaseTransaction) => void;
      const start = new Promise<DatabaseTransaction>((resolve) => {
        resolveStart = resolve;
      });
      let txPromise!: Promise<unknown>;
      txPromise = db.transaction()
        .setIsolationLevel('read committed')
        .execute(async (transaction) => {
          let resolveFinish!: (value: unknown) => void;
          const finish = new Promise<unknown>((resolve) => {
            resolveFinish = resolve;
          });
          states.set(transaction, { transaction, resolveFinish, promise: txPromise });
          resolveStart(transaction);
          return await finish;
        });
      observeBestEffort(txPromise,
        'the deferred transaction coordinator later awaits the same transaction outcome');
      return start;
    },
    async commit(transaction: DatabaseTransaction): Promise<void> {
      const state = states.get(transaction);
      if (!state) throw new Error('MCP-W10 commit without an open transaction');
      state.resolveFinish(undefined);
      await state.promise;
      states.delete(transaction);
    },
    async rollback(transaction: DatabaseTransaction, cause: unknown): Promise<void> {
      const state = states.get(transaction);
      if (!state) throw new Error('MCP-W10 rollback without an open transaction');
      state.resolveFinish(Promise.reject(cause));
      try {
        await state.promise;
      } catch {
        // Kysely rolled back the transaction.
      }
      states.delete(transaction);
    },
    async release(): Promise<void> {
      return undefined;
    },
  });
}

function wrapCommitApprovalStore(
  store: McpChangePlanCommitApprovalStorePort<DatabaseTransaction>,
  beforeBeginCommit: Phase4bMcpWriteCompositionOptions['beforeBeginCommit'],
): McpChangePlanCommitApprovalStorePort<DatabaseTransaction> {
  if (beforeBeginCommit === undefined) return store;
  return Object.freeze({
    markApproved: (
      transaction: DatabaseTransaction,
      input: Parameters<McpChangePlanCommitApprovalStorePort<DatabaseTransaction>['markApproved']>[1],
    ) => store.markApproved(transaction, input),
    beginCommit: async (
      transaction: DatabaseTransaction,
      input: Parameters<McpChangePlanCommitApprovalStorePort<DatabaseTransaction>['beginCommit']>[1],
    ) => {
      // Hold grant row locks until this commit transaction ends.
      await beforeBeginCommit({ planId: input.planId, transaction });
      return store.beginCommit(transaction, input);
    },
    finalizeCommit: (
      transaction: DatabaseTransaction,
      input: Parameters<McpChangePlanCommitApprovalStorePort<DatabaseTransaction>['finalizeCommit']>[1],
    ) => store.finalizeCommit(transaction, input),
  });
}
