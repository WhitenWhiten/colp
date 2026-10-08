import { createInMemoryApprovalStore, createInMemoryPlanStore } from './mcp-memory-stores.js';
import {
  type McpApprovalStorePort,
  type McpChangePlanCommitCoordinatorPort,
  type McpChangePlanExecutorPort,
  type McpChangePlanServiceOptions,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from '@know-n/colp/mcp';
import type { ChangePlanOperation, OperationResult } from '@know-n/colp/types';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  createPhase4bMcpWriteToolAdapter,
  createPhase4bMcpWritePlanStatusPort,
  projectPhase4bMcpPlan,
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpWriteToolAdapterBundle,
} from '../../src/modules/mcp/index.js';
import { createMcpChangePlanRateLimitPort } from '../../src/bootstrap/mcp-write-composition.js';
import { waitForRealTime } from './async-test-helpers.js';
import type {
  Phase4bMcpLowRiskAnnotationCreateOutput,
  Phase4bMcpLowRiskAnnotationCreateService,
  Phase4bMcpLowRiskAnnotationUpdateOutput,
  Phase4bMcpLowRiskAnnotationUpdateService,
  Phase4bMcpLowRiskChangeGetOutput,
  Phase4bMcpLowRiskChangeGetService,
  Phase4bMcpLowRiskCollectionUpdateOutput,
  Phase4bMcpLowRiskCollectionUpdateService,
  Phase4bMcpLowRiskNodeCreateContext,
  Phase4bMcpLowRiskNodeCreateOutput,
  Phase4bMcpLowRiskNodeCreateRequest,
  Phase4bMcpLowRiskNodeCreateService,
  Phase4bMcpLowRiskNodeUpdateOutput,
  Phase4bMcpLowRiskNodeUpdateService,
  Phase4bMcpOwnedCollectionCreateService,
} from '../../src/modules/mcp/index.js';

export interface InMemoryWriteToolFixture {
  readonly bundle: Phase4bMcpWriteToolAdapterBundle;
  readonly planStore: ReturnType<typeof createInMemoryPlanStore>;
  readonly approvalStore: ReturnType<typeof createInMemoryApprovalStore>;
  readonly nodeCreateCalls: readonly Readonly<{
    readonly request: Phase4bMcpLowRiskNodeCreateRequest;
    readonly context: Phase4bMcpLowRiskNodeCreateContext;
  }>[];
}

export function createInMemoryWriteToolFixture(
  options: {
    readonly nodeCreateDelayMs?: number;
    readonly nodeCreateThrow?: () => unknown;
    readonly nodeUpdateThrow?: () => unknown;
    readonly annotationCreateThrow?: () => unknown;
    readonly annotationUpdateThrow?: () => unknown;
    readonly collectionCreateService?: Phase4bMcpOwnedCollectionCreateService;
    readonly collectionUpdateService?: Phase4bMcpLowRiskCollectionUpdateService;
  } = {},
): InMemoryWriteToolFixture {
  const planStore = createInMemoryPlanStore();
  const approvalStore = createInMemoryApprovalStore();
  const nodeCreateCalls: Array<Readonly<{
    request: Phase4bMcpLowRiskNodeCreateRequest;
    context: Phase4bMcpLowRiskNodeCreateContext;
  }>> = [];
  const executor: McpChangePlanExecutorPort = Object.freeze({
    execute: async (): Promise<readonly OperationResult[]> => Object.freeze([
      Object.freeze({
        opId: 'op-w06',
        sequence: 1,
        status: 'applied',
        revision: 'revision-w06',
        cursor: 'receipt-w06',
        warnings: Object.freeze([]),
      }),
    ]),
  });
  const coordinator = createSimpleCommitCoordinator(planStore, approvalStore, executor);
  const changePlan: McpChangePlanServiceOptions = Object.freeze({
    planStore,
    approvalStore,
    impact: Object.freeze({
      assessImpact: async () => Object.freeze({
        collections: 0,
        nodes: 1,
        annotations: 0,
        attachments: 0,
        relations: 0,
        privateFieldsExcluded: Object.freeze([]),
      }),
    }),
    revisions: Object.freeze({
      resolveBaseRevisions: async (operation: ChangePlanOperation) =>
        resolveFixtureBaseRevisions(operation),
      currentRevisions: async (_transaction, base) => Object.freeze({ ...base }),
    }),
    scopes: Object.freeze({ hasScopes: async () => true }),
    authorizationPolicy: Object.freeze({
      requiredScopesForOperation: async () => Object.freeze([]),
    }),
    commitCoordinator: coordinator,
    rateLimit: createMcpChangePlanRateLimitPort({
      maxPlans: 100,
      windowMs: 60_000,
      now: () => Date.parse('2026-08-06T08:00:00.000Z'),
    }),
    approvalBaseUri: 'https://approve.example/approvals',
    uriPolicy: Object.freeze({ allow: () => true }),
    clock: Object.freeze({ now: () => new Date('2026-08-06T08:00:00.000Z') }),
    ids: Object.freeze({ nextPlanId: () => `plan-w06-${nodeCreateCalls.length + 1}` }),
    planTtlMilliseconds: 60_000,
  });
  const nodeCreateService: Phase4bMcpLowRiskNodeCreateService = Object.freeze({
    execute: async (
      request: unknown,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ): Promise<Phase4bMcpLowRiskNodeCreateOutput> => {
      if (options.nodeCreateDelayMs !== undefined && options.nodeCreateDelayMs > 0) {
        await waitForRealTime(
          options.nodeCreateDelayMs,
          'inject MCP node-create service latency',
        );
      }
      const ownedRequest = request as Phase4bMcpLowRiskNodeCreateRequest;
      nodeCreateCalls.push(Object.freeze({
        request: ownedRequest,
        context,
      }));
      if (options.nodeCreateThrow !== undefined) {
        throw options.nodeCreateThrow();
      }
      const record = ownedRequest.input as Readonly<Record<string, unknown>>;
      const node = record.node as Readonly<Record<string, unknown>>;
      const parentId = typeof record.parentId === 'string' ? record.parentId : 'root-1';
      const commonNode = Object.freeze({
        collectionId: String(record.collectionId),
        parentId,
        kind: String(node.kind),
        title: String(node.title),
        description: null,
        tags: Object.freeze([]),
        visibility: 'private' as const,
      });
      if (record.dryRun === true && record.confirmApply === false) {
        return Object.freeze({
          resultType: 'preview',
          outputContract: 'known.mcp.write.nodes.create.output.v1',
          node: node.kind === 'bookmark'
            ? Object.freeze({ ...commonNode, url: 'https://example.test/w06' })
            : commonNode,
          parent: Object.freeze({
            id: parentId,
            childrenRevision: 'children-w06',
            childrenEtag: 'children-etag-w06',
          }),
          fence: Object.freeze({
            contentRevision: 'content-w06',
            contentEtag: 'content-etag-w06',
            policyRevision: 'policy-w06',
            policyEtag: 'policy-etag-w06',
          }),
          appliedVisibility: 'private' as const,
        });
      }
      return Object.freeze({
        resultType: 'complete',
        outputContract: 'known.mcp.write.nodes.create.output.v1',
        receipt: Object.freeze({
          commandId: ownedRequest.idempotencyKey,
          status: 201,
          mediaType: 'application/json',
          contractVersion: 'v1',
        }),
        node: node.kind === 'bookmark'
          ? Object.freeze({
            id: 'node-w06-1',
            ...commonNode,
            position: 'U',
            revision: 'revision-w06',
            etag: 'etag-w06',
            readOnly: false,
            readOnlyReason: null,
            createdAt: '2026-08-06T08:00:00.000Z',
            updatedAt: '2026-08-06T08:00:00.000Z',
            url: 'https://example.test/w06',
          })
          : Object.freeze({
            id: 'node-w06-1',
            ...commonNode,
            position: 'U',
            revision: 'revision-w06',
            etag: 'etag-w06',
            readOnly: false,
            readOnlyReason: null,
            createdAt: '2026-08-06T08:00:00.000Z',
            updatedAt: '2026-08-06T08:00:00.000Z',
          }),
        parent: Object.freeze({
          id: parentId,
          childrenRevision: 'children-w06',
          childrenEtag: 'children-etag-w06',
        }),
        fence: Object.freeze({
          contentRevision: 'content-w06',
          contentEtag: 'content-etag-w06',
          policyRevision: 'policy-w06',
          policyEtag: 'policy-etag-w06',
        }),
        appliedVisibility: 'private' as const,
      });
    },
  });
  const collectionCreateService: Phase4bMcpOwnedCollectionCreateService =
    options.collectionCreateService ?? Object.freeze({
      execute: async (input) => Object.freeze({
        collectionId: 'col-w06-created',
        rootNodeId: 'root-w06-created',
        title: String(input.title),
        visibility: 'private' as const,
        revision: 'res-w06-created',
        contentRevision: 'cnt-w06-created',
        policyRevision: 'pol-w06-created',
        rootRevision: 'root-res-w06-created',
        childrenRevision: 'ch-w06-created',
      }),
    });
  const nodeUpdateService: Phase4bMcpLowRiskNodeUpdateService = Object.freeze({
    execute: async (input): Promise<Phase4bMcpLowRiskNodeUpdateOutput> => {
      if (options.nodeUpdateThrow !== undefined) {
        throw options.nodeUpdateThrow();
      }
      const nodeId = String(input.nodeId);
      const collectionId = String(input.collectionId);
      if (input.dryRun === true) {
        return Object.freeze({
          resultType: 'preview',
          nodeId,
          collectionId,
        });
      }
      return Object.freeze({
        resultType: 'complete',
        nodeId,
        collectionId,
        revision: 'revision-w06-updated',
      });
    },
  });
  const collectionUpdateService: Phase4bMcpLowRiskCollectionUpdateService =
    options.collectionUpdateService ?? Object.freeze({
      execute: async (input): Promise<Phase4bMcpLowRiskCollectionUpdateOutput> => {
        const collectionId = String(input.collectionId);
        const patch = input.patch as { readonly title?: string } | undefined;
        const title = typeof patch?.title === 'string' ? patch.title : 'Updated library';
        if (input.dryRun === true) {
          return Object.freeze({
            resultType: 'preview',
            collectionId,
            title,
          });
        }
        return Object.freeze({
          resultType: 'complete',
          collectionId,
          title,
          revision: 'revision-w06-collection',
        });
      },
    });
  const annotationCreateService: Phase4bMcpLowRiskAnnotationCreateService = Object.freeze({
    execute: async (input): Promise<Phase4bMcpLowRiskAnnotationCreateOutput> => {
      if (options.annotationCreateThrow !== undefined) {
        throw options.annotationCreateThrow();
      }
      const collectionId = String(input.collectionId);
      const nodeId = String(input.nodeId);
      const type = typeof input.type === 'string' ? input.type : 'note';
      if (input.dryRun === true) {
        return Object.freeze({
          resultType: 'preview',
          collectionId,
          nodeId,
          type: type as 'note' | 'tldr' | 'summary',
        });
      }
      return Object.freeze({
        resultType: 'complete',
        annotationId: 'ann-w06-1',
        collectionId,
        nodeId,
        type: type as 'note' | 'tldr' | 'summary',
        revision: 'revision-w06-annotation',
      });
    },
  });
  const annotationUpdateService: Phase4bMcpLowRiskAnnotationUpdateService = Object.freeze({
    execute: async (input): Promise<Phase4bMcpLowRiskAnnotationUpdateOutput> => {
      if (options.annotationUpdateThrow !== undefined) {
        throw options.annotationUpdateThrow();
      }
      const annotationId = String(input.annotationId);
      const collectionId = String(input.collectionId);
      if (input.dryRun === true) {
        return Object.freeze({
          resultType: 'preview',
          annotationId,
          collectionId,
        });
      }
      return Object.freeze({
        resultType: 'complete',
        annotationId,
        collectionId,
        revision: 'revision-w06-annotation-updated',
      });
    },
  });
  const changeGetService: Phase4bMcpLowRiskChangeGetService = Object.freeze({
    execute: async (input): Promise<Phase4bMcpLowRiskChangeGetOutput> => {
      const planId = String(input.planId);
      if (planId !== 'plan-w06') {
        throw new Phase4bMcpLowRiskNodeCreateError('policy_denied', 'Unknown tool.');
      }
      return Object.freeze({
        planId: 'plan-w06',
        status: 'pending',
        risk: 'high',
        requiresApproval: true,
        summary: 'Fixture change plan.',
        expiresAt: '2026-08-06T08:01:00.000Z',
        requiredScopes: Object.freeze(['nodes:write', 'access:write']),
        decision: 'pending',
        createdAt: '2026-08-06T08:00:00.000Z',
        impact: Object.freeze({
          collections: 1,
          nodes: 1,
          annotations: 0,
          attachments: 0,
          relations: 0,
          privateFieldsExcluded: Object.freeze([]),
        }),
        approvalUri: 'https://approve.example/approvals/plan-w06',
      });
    },
  });
  const resolvePlan = createPhase4bMcpWritePlanStatusPort(
    planStore,
    () => Date.parse('2026-08-06T08:00:00.000Z'),
  );
  const bundle = createPhase4bMcpWriteToolAdapter({
    changePlan,
    nodeCreateService,
    collectionCreateService,
    nodeUpdateService,
    collectionUpdateService,
    annotationCreateService,
    annotationUpdateService,
    changeGetService,
    resolvePlan,
    requestStateKey: 'known-mcp-w06-request-state-key-0123456789abcdef0123456789',
    requestStateClock: () => Date.parse('2026-08-06T08:00:00.000Z'),
  });
  return Object.freeze({
    bundle,
    planStore,
    approvalStore,
    nodeCreateCalls,
  });
}

function resolveFixtureBaseRevisions(
  operation: ChangePlanOperation,
): Readonly<Record<string, string>> {
  if (operation.type === 'set_visibility') {
    return Object.freeze({ [`access.${operation.collectionId}`]: operation.baseRevision });
  }
  return Object.freeze({});
}

function createSimpleCommitCoordinator(
  planStore: ReturnType<typeof createInMemoryPlanStore>,
  approvalStore: ReturnType<typeof createInMemoryApprovalStore>,
  executor: McpChangePlanExecutorPort,
): McpChangePlanCommitCoordinatorPort {
  const contexts = new WeakMap<object, Readonly<{ planId: string; idempotencyKey: string }>>();
  const stagedPlans = new WeakMap<object, McpStoredPlan>();
  const stagedApprovals = new WeakMap<object, Parameters<McpApprovalStorePort['markApproved']>[0]>();
  return Object.freeze({
    async begin(context) {
      const transaction = {};
      if ('idempotencyKey' in context) contexts.set(transaction, context);
      return transaction;
    },
    planStore: Object.freeze({
      async lock(_transaction, planId) {
        return planStore.get(planId);
      },
      async update(transaction, plan) {
        stagedPlans.set(transaction, plan);
      },
    }),
    approvalStore: Object.freeze({
      async markApproved(transaction, input) {
        stagedApprovals.set(transaction, input);
      },
      async beginCommit(_transaction, input) {
        return approvalStore.beginCommit(input);
      },
      async finalizeCommit(_transaction, input) {
        await approvalStore.finalizeCommit(input);
      },
    }),
    executor,
    async commit(transaction) {
      const stagedApproval = stagedApprovals.get(transaction);
      if (stagedApproval !== undefined) await approvalStore.markApproved(stagedApproval);
      const stagedPlan = stagedPlans.get(transaction);
      if (stagedPlan !== undefined) await planStore.update(stagedPlan);
    },
    async rollback(transaction) {
      const context = contexts.get(transaction);
      if (context !== undefined) await approvalStore.abortCommit(context);
    },
    async release() {
      return undefined;
    },
  });
}

export function operationResult(): OperationResult {
  return Object.freeze({
    opId: 'op-w06',
    sequence: 1,
    status: 'applied',
    revision: 'revision-w06',
    cursor: 'receipt-w06',
    warnings: Object.freeze([]),
  });
}

export function planProjection(plan: McpStoredPlan): Readonly<Record<string, unknown>> {
  return projectPhase4bMcpPlan(plan);
}

export function approvalInput(
  plan: McpStoredPlan,
  binding: McpAuthenticatedAuthorizationBinding,
): Parameters<McpApprovalStorePort['markApproved']>[0] {
  return Object.freeze({
    planId: plan.planId,
    binding,
    operationsDigest: plan.operationsDigest,
  });
}

export function commitResult(planId: string): McpPlanCommitResult {
  return Object.freeze({
    planId,
    committedAt: '2026-08-06T08:00:00.000Z',
    operations: Object.freeze([operationResult()]),
  });
}
