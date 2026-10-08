import { createPhase4bMcpGatewayPlanner } from '../../src/modules/mcp/change-plan-gateway-planner.js';
import { createPhase4bMcpChangePlanDigestVerifier } from '../../src/modules/mcp/change-plan-service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type {
  McpAuthenticatedAuthorizationBinding,
  McpChangePlanServiceOptions,
} from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  ScopeName,
} from '@know-n/colp/types';
import {
  createPostgresMcpChangePlanStore,
  createPostgresProductCommandReceiptPort,
  type DatabaseRuntime,
  type DatabaseSchema,
  type DatabaseTransaction,
} from '../../src/infrastructure/database/index.js';
import {
  createPostgresAnnotationMutationUnitOfWork,
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCanonicalMutationPorts,
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresNodeWritePort,
} from '../../src/infrastructure/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import {
  createCanonicalMutationApplication,
  createOwnedCollectionCanonical,
  type CreateOwnedCollectionInput,
  type ProductCollectionCanonicalPorts,
} from '../../src/modules/collections/index.js';
import {
  createPhase4bMcpChangePlanCommitCoordinator,
  createPhase4bMcpChangePlanRevisionPort,
  createPhase4bMcpLowRiskAnnotationCreateService,
  createPhase4bMcpLowRiskAnnotationInspect,
  createPhase4bMcpLowRiskAnnotationUpdateService,
  createPhase4bMcpLowRiskChangeGetService,
  createPhase4bMcpLowRiskCollectionUpdateService,
  createPhase4bMcpLowRiskNodeCreateService,
  createPhase4bMcpLowRiskNodeUpdateService,
  createPhase4bMcpOwnedCollectionCreateService,
  createPhase4bMcpRequestContext,
  createPhase4bMcpWritePlanStatusPort,
  createPhase4bMcpWriteToolAdapter,
  decideMcpSetVisibilityRevisions,
  PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME,
  PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS,
  type Phase4bMcpWriteToolAdapterBundle,
} from '../../src/modules/mcp/index.js';
import {
  createMcpChangePlanRateLimitPort,
  createPhase4bMcpLowRiskNodeCreateInspect,
} from '../../src/bootstrap/mcp-write-composition.js';

export interface FixtureFacts {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly rootId: string;
  readonly resourceRevision: string;
  readonly collectionResourceRevision: string;
  readonly policyRevision: string;
  readonly contentRevision: string;
}

const WRITE_TEST_IMPACT: ChangePlanImpact = Object.freeze({
  collections: 0,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: Object.freeze([]),
});

export interface PostgresPhase4bMcpWriteHarness {
  readonly store: ReturnType<typeof createPostgresMcpChangePlanStore>;
  readonly bundle: Phase4bMcpWriteToolAdapterBundle;
  readonly createProductPorts: (
    transaction: DatabaseTransaction,
  ) => ProductCollectionCanonicalPorts;
}

export function createPostgresPhase4bMcpWriteHarness(
  runtime: DatabaseRuntime,
  binding: McpAuthenticatedAuthorizationBinding,
  scopes: readonly string[],
): PostgresPhase4bMcpWriteHarness {
  const store = createPostgresMcpChangePlanStore(runtime.db);
  const createProductPorts = (transaction: DatabaseTransaction) =>
    createPostgresProductPorts(transaction, 'https://collections.example.test');
  const deferred = createDeferredTransactionCoordinator(runtime.db);
  const coordinator = createPhase4bMcpChangePlanCommitCoordinator({
    begin: deferred.begin,
    commit: deferred.commit,
    rollback: deferred.rollback,
    release: deferred.release,
    commitPlanStore: store.commitPlanStore,
    commitApprovalStore: store.commitApprovalStore,
    createProductPorts,
  });
  const unitOfWork = createPostgresCanonicalMutationUnitOfWork(runtime.db);
  const inspect = createPhase4bMcpLowRiskNodeCreateInspect(runtime.db);
  const annotationUnitOfWork = createPostgresAnnotationMutationUnitOfWork(runtime.db);
  const annotationInspect = createPhase4bMcpLowRiskAnnotationInspect(annotationUnitOfWork);
  const changePlan: McpChangePlanServiceOptions = Object.freeze({
    planStore: store.planStore,
    approvalStore: store.approvalStore,
    verifyStoredOperationsDigest: createPhase4bMcpChangePlanDigestVerifier(),
    impact: Object.freeze({
      assessImpact: async () => WRITE_TEST_IMPACT,
    }),
    revisions: Object.freeze({
      resolveBaseRevisions: async (operation: ChangePlanOperation) => {
        if (operation.type !== 'set_visibility') return Object.freeze({});
        const visibility = operation.input?.visibility;
        if (
          visibility !== 'public'
          && visibility !== 'unlisted'
          && visibility !== 'protected'
          && visibility !== 'private'
        ) {
          throwHarnessAuthoritativeUnavailable();
        }
        const matchingNodes = await runtime.pool.query<{ id: string; resource_revision: string }>(
          `select id, resource_revision from nodes
           where collection_id = $1 and resource_revision = $2 and deleted_at is null`,
          [operation.collectionId, operation.baseRevision],
        );
        const collection = await runtime.pool.query<{
          resource_revision: string;
          policy_revision: string;
        }>(
          `select resource_revision, policy_revision from collections
           where id = $1 and deleted_at is null`,
          [operation.collectionId],
        );
        const decision = collection.rows[0] === undefined
          ? null
          : decideMcpSetVisibilityRevisions({
            visibility,
            collectionId: operation.collectionId,
            baseRevision: operation.baseRevision,
            collectionResourceRevision: collection.rows[0].resource_revision,
            collectionPolicyRevision: collection.rows[0].policy_revision,
            matchingNodes: matchingNodes.rows.map((node) => Object.freeze({
              id: node.id,
              resourceRevision: node.resource_revision,
            })),
          });
        if (decision === null) {
          throwHarnessAuthoritativeUnavailable();
        }
        return decision.map;
      },
      currentRevisions: createPhase4bMcpChangePlanRevisionPort(createProductPorts)
        .currentRevisions,
    }),
    scopes: Object.freeze({
      hasScopes: async (required: readonly ScopeName[]) =>
        required.every((scope) => scopes.includes(scope)),
    }),
    authorizationPolicy: Object.freeze({
      requiredScopesForOperation: async () => Object.freeze([] as readonly ScopeName[]),
    }),
    commitCoordinator: coordinator,
    rateLimit: createMcpChangePlanRateLimitPort({
      maxPlans: 100,
      windowMs: 60_000,
      now: () => Date.now(),
    }),
    approvalBaseUri: 'https://approve.example/approvals',
    uriPolicy: Object.freeze({ allow: () => true }),
    clock: Object.freeze({ now: () => new Date() }),
    ids: Object.freeze({ nextPlanId: () => `plan-w06-${randomUUID().replaceAll('-', '')}` }),
    planTtlMilliseconds: 3_600_000,
  });
  const bundle = createPhase4bMcpWriteToolAdapter({
    changePlan: { ...changePlan, planner: createPhase4bMcpGatewayPlanner(changePlan) } as McpChangePlanServiceOptions,
    nodeCreateService: createPhase4bMcpLowRiskNodeCreateService({ unitOfWork, inspect }),
    collectionCreateService: createPhase4bMcpOwnedCollectionCreateService({ unitOfWork }),
    nodeUpdateService: createPhase4bMcpLowRiskNodeUpdateService({ unitOfWork, inspect }),
    collectionUpdateService: createPhase4bMcpLowRiskCollectionUpdateService({
      unitOfWork,
      inspect,
    }),
    annotationCreateService: createPhase4bMcpLowRiskAnnotationCreateService({
      unitOfWork: annotationUnitOfWork,
      inspect: annotationInspect,
      resolveAnnotationCreator: async () => Object.freeze({
        id: 'https://collections.example.test/profiles/mcp-w06-owner',
        name: 'MCP W06 owner',
      }),
    }),
    annotationUpdateService: createPhase4bMcpLowRiskAnnotationUpdateService({
      unitOfWork: annotationUnitOfWork,
      inspect: annotationInspect,
    }),
    changeGetService: createPhase4bMcpLowRiskChangeGetService({ planStore: store.planStore }),
    resolvePlan: createPhase4bMcpWritePlanStatusPort(store.planStore, () => Date.now()),
    requestStateKey: 'known-mcp-w06-postgres-request-state-key-0123456789abcdef0123456789',
    requestStateTtlSeconds: 3_600,
    requestStateClock: () => Date.now(),
  });
  return Object.freeze({ store, bundle, createProductPorts });
}

export async function createMcpWriteFixture(
  runtime: DatabaseRuntime,
  binding: McpAuthenticatedAuthorizationBinding,
  scopes: readonly string[],
): Promise<FixtureFacts> {
  const collectionId = randomBytes(16).toString('base64url');
  const rootId = randomBytes(16).toString('base64url');
  const input: CreateOwnedCollectionInput = {
    actor: {
      principalId: binding.principalId,
      principalType: 'account',
      subjectId: binding.principalId,
    },
    command: {
      commandId: randomUUID(),
      fingerprint: 'fixture-collection-fingerprint',
    },
    title: 'MCP W06 Collection',
    summary: null,
    kind: 'bookmarks',
    collectionId,
    rootNodeId: rootId,
    operationId: randomUUID(),
  };
  const result = await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute((ports) =>
    createOwnedCollectionCanonical(ports, input));
  if (result.kind !== 'created') throw new Error('Expected fixture collection creation.');
  const initialCollection = (await runtime.pool.query<{
    content_revision: string;
    policy_revision: string;
  }>(`select content_revision, policy_revision from collections where id = $1`, [collectionId]))
    .rows[0];
  const initialRoot = (await runtime.pool.query<{ children_revision: string }>(
    `select children_revision from nodes where id = $1`,
    [rootId],
  )).rows[0];
  if (initialCollection === undefined || initialRoot === undefined) {
    throw new Error('Expected fixture collection and root revisions.');
  }
  const service = createPhase4bMcpLowRiskNodeCreateService({
    unitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
    inspect: createPhase4bMcpLowRiskNodeCreateInspect(runtime.db),
  });
  const created = await service.execute(Object.freeze({
    input: Object.freeze({
      tool: 'nodes.create',
      collectionId,
      parentId: rootId,
      afterId: null,
      beforeId: null,
      node: Object.freeze({
        kind: 'bookmark',
        title: 'W06 fixture bookmark',
        url: 'https://example.test/fixture',
        description: null,
        tags: Object.freeze(['fixture']),
        visibility: 'private',
      }),
      reason: 'fixture node',
      confirmApply: true,
    }),
    idempotencyKey: randomUUID(),
    expectedBaseRevisions: Object.freeze({
      [`children.${rootId}`]: initialRoot.children_revision,
      [`content.${collectionId}`]: initialCollection.content_revision,
      [`policy.${collectionId}`]: initialCollection.policy_revision,
    }),
  }), Object.freeze({
    binding,
    accountSubjectId: binding.principalId,
    scope: scopes,
  }));
  if (created.resultType !== 'complete') {
    throw new Error('Expected complete fixture nodes.create output.');
  }
  const node = (await runtime.pool.query<{ resource_revision: string }>(
    `select resource_revision from nodes where id = $1`,
    [created.node.id],
  )).rows[0];
  const collection = (await runtime.pool.query<{
    content_revision: string;
    policy_revision: string;
    resource_revision: string;
  }>(
    `select content_revision, policy_revision, resource_revision from collections where id = $1`,
    [collectionId],
  )).rows[0];
  if (node === undefined || collection === undefined) {
    throw new Error('Expected fixture node and collection revisions.');
  }
  return Object.freeze({
    collectionId,
    nodeId: created.node.id,
    rootId,
    resourceRevision: node.resource_revision,
    collectionResourceRevision: collection.resource_revision,
    policyRevision: collection.policy_revision,
    contentRevision: collection.content_revision,
  });
}

interface DeferredTransactionState {
  readonly transaction: DatabaseTransaction;
  readonly resolveFinish: (value: unknown) => void;
  readonly promise: Promise<unknown>;
}

export function createDeferredTransactionCoordinator(db: Kysely<DatabaseSchema>) {
  const states = new Map<DatabaseTransaction, DeferredTransactionState>();
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
      txPromise.catch(() => undefined);
      return start;
    },
    async commit(transaction: DatabaseTransaction): Promise<void> {
      const state = states.get(transaction);
      if (state === undefined) throw new Error('commit without an open MCP-W06 transaction');
      state.resolveFinish(undefined);
      await state.promise;
      states.delete(transaction);
    },
    async rollback(transaction: DatabaseTransaction, cause: unknown): Promise<void> {
      const state = states.get(transaction);
      if (state === undefined) throw new Error('rollback without an open MCP-W06 transaction');
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

function throwHarnessAuthoritativeUnavailable(): never {
  const error = new Error('MCP-W03 could not resolve authoritative state for planning.');
  error.name = PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME;
  throw error;
}

export function createPostgresProductPorts(
  transaction: DatabaseTransaction,
  productOrigin?: string,
): ProductCollectionCanonicalPorts {
  const rawCanonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(
    transaction,
  ));
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const clock = createPostgresCollectionsClock(transaction);
  const collections = createPostgresCollectionWritePort(transaction);
  const nodeReader = createPostgresNodeWritePort(transaction);
  const accessPolicy = createPostgresAccessPolicyFactsPort(transaction);
  return Object.freeze({
    canonical: Object.freeze({
      execute: (input) => rawCanonical.execute({ transaction }, input),
      async bootstrapOwnedCollection() {
        throw new Error('MCP-W06 executor never bootstraps collections');
      },
    }),
    receipts,
    clock,
    collections: Object.freeze({
      lockForUpdate: (collectionId) => collections.lockForUpdate(collectionId),
    }),
    nodes: Object.freeze({
      getNode: (collectionId, nodeId) => nodeReader.getNode(collectionId, nodeId),
      readParentAncestry: (collectionId, parentId, maxDepth) =>
        nodeReader.readParentAncestry!(collectionId, parentId, maxDepth),
      listLiveSiblingPositions: (collectionId, parentId) =>
        nodeReader.listLiveSiblingPositions(collectionId, parentId),
      hasLiveChildren: (collectionId, parentId) =>
        nodeReader.hasLiveChildren!(collectionId, parentId),
      listLiveNodes: (collectionId) => nodeReader.listLiveNodes!(collectionId),
    }),
    accessPolicy,
    ...(productOrigin === undefined ? {} : { productOrigin }),
  });
}

export function planContext(
  binding: McpAuthenticatedAuthorizationBinding,
  scope: readonly string[],
) {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'changes.plan' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({}),
        }),
        name: 'changes.plan',
      }),
    }),
    binding,
    scope,
    authorization: Object.freeze({ accountSubjectId: binding.principalId }),
    budget: Object.freeze({
      maxBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 10_000,
      maxOperations: 1_000,
      maxListItems: 10_000,
      maxReadContents: 10_000,
      maxTextBytes: 1_048_576,
      maxCursorLength: 1_024,
    }),
  });
}

export function nodeCreateContext(
  binding: McpAuthenticatedAuthorizationBinding,
  scope: readonly string[],
) {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'nodes.create' }),
      Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: 'collection-fixture' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({}),
        }),
        name: 'nodes.create',
        arguments: Object.freeze({ collectionId: 'collection-fixture' }),
      }),
    }),
    binding,
    scope,
    authorization: Object.freeze({ accountSubjectId: binding.principalId }),
    budget: Object.freeze({
      maxBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 10_000,
      maxOperations: 1_000,
      maxListItems: 10_000,
      maxReadContents: 10_000,
      maxTextBytes: 1_048_576,
      maxCursorLength: 1_024,
    }),
    paramDeclarations: PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS,
  });
}

export function writeToolContext(
  binding: McpAuthenticatedAuthorizationBinding,
  scope: readonly string[],
  name: string,
  collectionId?: string,
) {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: name }),
      ...(collectionId === undefined
        ? []
        : [Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: collectionId })]),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({}),
        }),
        name,
        arguments: collectionId === undefined
          ? Object.freeze({})
          : Object.freeze({ collectionId }),
      }),
    }),
    binding,
    scope,
    authorization: Object.freeze({ accountSubjectId: binding.principalId }),
    budget: Object.freeze({
      maxBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 10_000,
      maxOperations: 1_000,
      maxListItems: 10_000,
      maxReadContents: 10_000,
      maxTextBytes: 1_048_576,
      maxCursorLength: 1_024,
    }),
    ...(collectionId === undefined
      ? {}
      : { paramDeclarations: PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS }),
  });
}

export function commitContext(
  binding: McpAuthenticatedAuthorizationBinding,
  scope: readonly string[],
) {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'changes.commit' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: Object.freeze({
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': Object.freeze({}),
        }),
        name: 'changes.commit',
      }),
    }),
    binding,
    scope,
    authorization: Object.freeze({ accountSubjectId: binding.principalId }),
    budget: Object.freeze({
      maxBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 10_000,
      maxOperations: 1_000,
      maxListItems: 10_000,
      maxReadContents: 10_000,
      maxTextBytes: 1_048_576,
      maxCursorLength: 1_024,
    }),
  });
}
