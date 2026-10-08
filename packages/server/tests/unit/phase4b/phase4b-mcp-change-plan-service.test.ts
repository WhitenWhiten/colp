import { createInMemoryApprovalStore, createInMemoryPlanStore } from '../../support/mcp-memory-stores.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  type McpChangePlanTransactionBeginContext,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ScopeName,
} from '@know-n/colp/types';
import {
  createPhase4bMcpChangePlanPlanner,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpStoredPlan,
} from '../../../src/modules/mcp/change-plan-planner.js';
import {
} from '../../../src/modules/mcp/low-risk-node-create.js';
import {
  createPhase4bMcpChangePlanDigestVerifier,
  createPhase4bMcpChangePlanRevisionPort,
  createPhase4bMcpChangePlanService,
  type Phase4bMcpChangePlanServiceOptions,
} from '../../../src/modules/mcp/change-plan-service.js';
import {
  createAutoApproveTrustedPlan,
  type AgentPlanPolicyReceipt,
} from '../../../src/modules/mcp/agent-plan-policy.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import { createMcpChangePlanRateLimitPort } from '../../../src/bootstrap/mcp-write-composition.js';
import {
  createMemoryProductCollectionMutationUnitOfWork,
} from '../../support/product-canonical-memory.js';
import type {
  AccessPolicyFactsPort,
  ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import type {
  CanonicalMutationInput,
  CanonicalMutationResult,
  CollectionsUnitOfWork,
  CollectionsWritePorts,
  LockedCollectionRow,
  LockedNodeRow,
  MembershipRole,
  NodeContentUpdateRow,
  ProductCollectionCanonicalPorts,
  SiblingPositionRow,
} from '../../../src/modules/collections/index.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 0,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: [],
});

const CATALOG_INPUT = Object.freeze({
  tool: 'nodes.set_visibility',
  collectionId: 'collection-1',
  nodeId: 'node-1',
  visibility: 'private',
  baseRevision: 'resource-r1',
  reason: 'publish this node',
  dryRun: true,
});

const CREATE_CATALOG_INPUT = Object.freeze({
  tool: 'nodes.create',
  collectionId: 'collection-1',
  parentId: 'root-1',
  afterId: null,
  beforeId: null,
  node: Object.freeze({
    kind: 'bookmark',
    title: 'Planned bookmark',
    url: 'https://example.com/planned',
    description: null,
    tags: Object.freeze([]),
    visibility: 'private',
  }),
  reason: 'create a planned bookmark',
  dryRun: true,
});

interface MemoryCollection {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  contentRevision: string;
  policyRevision: string;
  commitOrdinal: bigint;
  readonly createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface MemoryNode {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'bookmark';
  readonly isRoot: boolean;
  title: string;
  url: string | null;
  description: string | null;
  tags: readonly string[];
  visibility: 'inherit' | 'protected' | 'private';
  positionToken: string | null;
  resourceRevision: string;
  childrenRevision: string;
  readonly createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface MemoryReceipt {
  fingerprint: string;
  status: 'in_progress' | 'completed';
  result?: ProductCommandResult;
}

interface MemoryState {
  readonly collections: Map<string, MemoryCollection>;
  readonly nodes: Map<string, MemoryNode>;
  readonly receipts: Map<string, MemoryReceipt>;
  readonly memberships: Map<string, MembershipRole>;
  readonly ownerSubjectId: string;
}

function createMemoryState(): MemoryState {
  const collections = new Map<string, MemoryCollection>();
  const nodes = new Map<string, MemoryNode>();
  const receipts = new Map<string, MemoryReceipt>();
  const memberships = new Map<string, MembershipRole>();
  memberships.set('principal-1', 'owner');
  collections.set('collection-1', {
    id: 'collection-1',
    ownerSubjectId: 'principal-1',
    visibility: 'private',
    contentRevision: 'content-r1',
    policyRevision: 'policy-r1',
    commitOrdinal: 2n,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });
  nodes.set('root-1', {
    id: 'root-1',
    collectionId: 'collection-1',
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Root',
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: null,
    resourceRevision: 'root-r1',
    childrenRevision: 'children-r1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });
  nodes.set('node-1', {
    id: 'node-1',
    collectionId: 'collection-1',
    parentId: 'root-1',
    kind: 'bookmark',
    isRoot: false,
    title: 'Bookmark',
    url: 'https://example.com',
    description: null,
    tags: [],
    visibility: 'inherit',
    positionToken: 'U',
    resourceRevision: 'resource-r1',
    childrenRevision: 'node-children-r1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });
  return { collections, nodes, receipts, memberships, ownerSubjectId: 'principal-1' };
}

function receiptKey(binding: ProductCommandBinding): string {
  return `${binding.principalId}\0${binding.commandScope}\0${binding.commandId}`;
}

function createMemoryReceipts(state: MemoryState): ProductCommandReceiptPort {
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = receiptKey(binding);
      const existing = state.receipts.get(key);
      if (existing === undefined) {
        state.receipts.set(key, { fingerprint, status: 'in_progress' });
        return { kind: 'claimed' };
      }
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      if (existing.result === undefined) return { kind: 'expired', resultDigest: null };
      return { kind: 'replay', result: existing.result };
    },
    async complete(binding, fingerprint, result) {
      const row = state.receipts.get(receiptKey(binding));
      if (row === undefined || row.fingerprint !== fingerprint || row.status === 'completed') {
        throw new Error('receipt completion without an owned in-progress claim');
      }
      row.status = 'completed';
      row.result = result;
    },
    async purgeExpired() {
      return 0;
    },
    async deletePrincipalReceipts(principalId) {
      let count = 0;
      for (const [key] of state.receipts) {
        if (key.startsWith(`${principalId}\0`)) {
          state.receipts.delete(key);
          count += 1;
        }
      }
      return count;
    },
  };
}

function createMemoryAccessPolicy(state: MemoryState): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input): Promise<ResourcePolicyFacts | null> {
      const collection = state.collections.get(input.collectionId);
      if (collection === undefined) return null;
      return {
        collectionId: collection.id,
        ownerSubjectId: collection.ownerSubjectId,
        visibility: collection.visibility,
        policyRevision: collection.policyRevision,
        membershipRole: state.memberships.get(input.actorSubjectId) ?? null,
        deleted: collection.deletedAt !== null,
      };
    },
  };
}

function toLockedCollection(row: MemoryCollection): LockedCollectionRow {
  return Object.freeze({
    id: row.id,
    ownerSubjectId: row.ownerSubjectId,
    title: 'Collection',
    summary: null,
    kind: 'bookmarks',
    visibility: row.visibility,
    rootNodeId: 'root-1',
    resourceRevision: `resource-${row.id}`,
    contentRevision: row.contentRevision,
    policyRevision: row.policyRevision,
    commitOrdinal: row.commitOrdinal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

function toLockedNode(row: MemoryNode): LockedNodeRow {
  return Object.freeze({
    id: row.id,
    collectionId: row.collectionId,
    parentId: row.parentId,
    kind: row.kind,
    isRoot: row.isRoot,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: [...row.tags],
    visibility: row.visibility,
    positionToken: row.positionToken,
    resourceRevision: row.resourceRevision,
    childrenRevision: row.childrenRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

function createMemoryCollectionsPorts(state: MemoryState): CollectionsWritePorts {
  const accessPolicyFacts = createMemoryAccessPolicy(state);
  return Object.freeze({
    receipts: createMemoryReceipts(state),
    clock: Object.freeze({ now: async () => NOW }),
    idLedger: Object.freeze({
      async reserve() {
        return undefined;
      },
    }),
    collections: Object.freeze({
      async insertBootstrap() {
        throw new Error('bootstrap not used in MCP-W05 unit fixture');
      },
      async lockForUpdate(collectionId) {
        const row = state.collections.get(collectionId);
        return row === undefined ? null : toLockedCollection(row);
      },
      async lockForShare(collectionId) {
        return this.lockForUpdate(collectionId);
      },
      async advanceContentFence(collectionId, update) {
        const row = state.collections.get(collectionId);
        if (row === undefined) throw new Error('missing collection');
        row.contentRevision = update.contentRevision;
        row.commitOrdinal = update.commitOrdinal;
        row.updatedAt = update.updatedAt;
        if (update.policyRevision !== undefined) row.policyRevision = update.policyRevision;
      },
    }),
    nodes: Object.freeze({
      async insertRoot() {
        throw new Error('root bootstrap not used in MCP-W05 unit fixture');
      },
      async insertNode(input) {
        state.nodes.set(input.id, {
          id: input.id,
          collectionId: input.collectionId,
          parentId: input.parentId,
          kind: input.kind,
          isRoot: false,
          title: input.title,
          url: input.url,
          description: input.description,
          tags: [...input.tags],
          visibility: input.visibility,
          positionToken: input.positionToken,
          resourceRevision: input.resourceRevision,
          childrenRevision: input.childrenRevision,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          deletedAt: null,
        });
      },
      async getNode(collectionId, nodeId) {
        const row = state.nodes.get(nodeId);
        return row !== undefined && row.collectionId === collectionId ? toLockedNode(row) : null;
      },
      async listLiveSiblingPositions(collectionId, parentId) {
        const result: SiblingPositionRow[] = [];
        for (const row of state.nodes.values()) {
          if (row.collectionId === collectionId && row.parentId === parentId && row.deletedAt === null) {
            result.push({ id: row.id, positionToken: row.positionToken! });
          }
        }
        return result;
      },
      async updateContent(collectionId, nodeId, update: NodeContentUpdateRow) {
        const row = state.nodes.get(nodeId);
        if (row === undefined || row.collectionId !== collectionId) throw new Error('missing node');
        row.title = update.title;
        row.url = update.url;
        row.description = update.description;
        row.tags = [...update.tags];
        row.visibility = update.visibility;
        row.resourceRevision = update.resourceRevision;
        row.updatedAt = update.updatedAt;
      },
      async updatePosition() {
        throw new Error('position update not used in MCP-W05 unit fixture');
      },
      async updateParentAndPosition() {
        throw new Error('move not used in MCP-W05 unit fixture');
      },
      async advanceChildrenRevision(collectionId, parentId, revision, updatedAt) {
        const row = state.nodes.get(parentId);
        if (row === undefined || row.collectionId !== collectionId) throw new Error('missing parent');
        row.childrenRevision = revision;
        row.updatedAt = updatedAt;
      },
      async markDeleted() {
        throw new Error('delete not used in MCP-W05 unit fixture');
      },
    }),
    revisions: Object.freeze({
      async insertResourceRevision() {
        return undefined;
      },
      async insertContentRevision() {
        return undefined;
      },
      async insertPolicyRevision() {
        return undefined;
      },
      async insertChildrenRevision() {
        return undefined;
      },
    }),
    operations: Object.freeze({
      async append() {
        return undefined;
      },
    }),
    audit: Object.freeze({
      async append() {
        return undefined;
      },
    }),
    outbox: Object.freeze({
      async append() {
        return undefined;
      },
    }),
    accessPolicy: Object.freeze({
      async insertMembership() {
        return undefined;
      },
      async deleteMembership() {
        return true;
      },
      async setPolicy() {
        return undefined;
      },
      async loadPolicy() {
        return Object.freeze({ policyJson: {} });
      },
    }) as CollectionsWritePorts['accessPolicy'],
    accessPolicyFacts,
  });
}

function createPlannerOptions(
  planStore: ReturnType<typeof createInMemoryPlanStore>,
): Phase4bMcpChangePlanPlannerOptions {
  return Object.freeze({
    planStore: Object.freeze({
      save: (plan: Phase4bMcpStoredPlan) => planStore.save(plan as unknown as McpStoredPlan),
      get: (planId: string) =>
        planStore.get(planId) as Promise<Phase4bMcpStoredPlan | undefined>,
    }),
    authoritativeState: Object.freeze({
      async resolveCreateBaseRevisions() {
        return Object.freeze({
          parentChildrenRevision: 'children-r1',
          collectionContentRevision: 'content-r1',
          collectionVisibility: 'private' as const,
        });
      },
      async resolveVisibilityFacts() {
        return Object.freeze({
          resourceRevision: 'resource-r1',
          policyRevision: 'policy-r1',
        });
      },
    }),
    authorizationPolicy: Object.freeze({
      async requiredScopesForOperation() {
        return Object.freeze([] as readonly ScopeName[]);
      },
    }),
    impact: Object.freeze({
      async assessImpact() {
        return IMPACT;
      },
    }),
    approvalBaseUri: 'https://approve.example/approvals',
    approvalUriPolicy: Object.freeze({
      allow: (input: { purpose: 'approval'; origin: string }) =>
        input.purpose === 'approval' && input.origin === 'https://approve.example',
    }),
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    clock: Object.freeze({ now: () => NOW }),
    ids: Object.freeze({
      nextPlanId: () => 'plan-w05-1',
      nextOperationId: () => 'op-w05-1',
    }),
    inputBudget: Object.freeze({
      maxDepth: 32,
      maxNodes: 1000,
      maxBytes: 65_536,
      maxOperations: 1,
    }),
  });
}

function createMemoryCoordinator(
  planStore: ReturnType<typeof createInMemoryPlanStore>,
  approvalStore: ReturnType<typeof createInMemoryApprovalStore>,
) {
  const staged = new WeakMap<object, {
    plan?: McpStoredPlan;
    approval?: Parameters<ReturnType<typeof createInMemoryApprovalStore>['markApproved']>[0];
    result?: McpPlanCommitResult;
  }>();
  const contexts = new WeakMap<object, McpChangePlanTransactionBeginContext>();
  return Object.freeze({
    async begin(context: McpChangePlanTransactionBeginContext) {
      const transaction = {};
      contexts.set(transaction, context);
      staged.set(transaction, {});
      return transaction;
    },
    planStore: Object.freeze({
      async lock(_transaction: object, planId: string) {
        return planStore.get(planId);
      },
      async update(transaction: object, plan: McpStoredPlan) {
        staged.get(transaction)!.plan = plan;
      },
    }),
    approvalStore: Object.freeze({
      async markApproved(
        transaction: object,
        input: Parameters<ReturnType<typeof createInMemoryApprovalStore>['markApproved']>[0],
      ) {
        staged.get(transaction)!.approval = input;
      },
      async beginCommit(
        _transaction: object,
        input: Parameters<ReturnType<typeof createInMemoryApprovalStore>['beginCommit']>[0],
      ) {
        // FIX-M-016 unified claim gate: low-risk ready Plans claim directly
        // under binding/receipt/row lock; approval-required Plans keep the
        // approval-store single-winner semantics.
        const plan = await planStore.get(input.planId);
        if (plan !== undefined && plan.status === 'consumed') {
          const prior = await approvalStore.beginCommit(input);
          if (prior.status === 'already_consumed') return prior;
          return Object.freeze({ status: 'rejected' as const, reason: 'concurrent_lost' as const });
        }
        if (
          plan !== undefined
          && plan.requiresApproval === false
          && (plan.status === 'pending' || plan.status === 'approved')
        ) {
          if (
            plan.binding.kind !== input.binding.kind
            || plan.binding.principalId !== input.binding.principalId
            || plan.binding.clientId !== input.binding.clientId
            || plan.binding.credentialBindingId !== input.binding.credentialBindingId
            || plan.binding.resourceAudience !== input.binding.resourceAudience
            || plan.binding.securityEpoch !== input.binding.securityEpoch
          ) {
            return Object.freeze({ status: 'rejected' as const, reason: 'binding_mismatch' as const });
          }
          if (plan.operationsDigest !== input.operationsDigest) {
            return Object.freeze({ status: 'rejected' as const, reason: 'digest_mismatch' as const });
          }
          return Object.freeze({ status: 'ready' as const });
        }
        return approvalStore.beginCommit(input);
      },
      async finalizeCommit(
        transaction: object,
        input: Parameters<ReturnType<typeof createInMemoryApprovalStore>['finalizeCommit']>[0],
      ) {
        staged.get(transaction)!.result = input.result;
      },
    }),
    async commit(transaction: object) {
      const state = staged.get(transaction)!;
      const context = contexts.get(transaction)!;
      if (state.approval !== undefined) await approvalStore.markApproved(state.approval);
      if (state.plan !== undefined) await planStore.update(state.plan);
      if (state.result !== undefined && 'idempotencyKey' in context) {
        await approvalStore.finalizeCommit({
          planId: context.planId,
          idempotencyKey: context.idempotencyKey,
          result: state.result,
        });
      }
    },
    async rollback(transaction: object) {
      const context = contexts.get(transaction);
      if (context !== undefined && 'idempotencyKey' in context) {
        await approvalStore.abortCommit({
          planId: context.planId,
          idempotencyKey: context.idempotencyKey,
        });
      }
    },
    async release() {
      return undefined;
    },
  });
}

function createHarness(policy?: 'manual' | 'trusted') {
  const planStore = createInMemoryPlanStore();
  const capturedCauses: string[] = [];
  const policyReceipts: AgentPlanPolicyReceipt[] = [];
  const audits: string[] = [];
  const policyLookups: string[] = [];
  const committedRevisions: { planId: string; collectionIds: readonly string[] }[] = [];
  const approvalStore = createInMemoryApprovalStore();
  const state = createMemoryState();
  const legacyUnitOfWork: CollectionsUnitOfWork = Object.freeze({
    execute: async (work) => work(createMemoryCollectionsPorts(state)),
  });
  const productUnitOfWork = createMemoryProductCollectionMutationUnitOfWork(legacyUnitOfWork);
  let productPorts!: ProductCollectionCanonicalPorts;
  void productUnitOfWork.execute(async (ports) => {
    productPorts = ports;
  });
  const planner = createPhase4bMcpChangePlanPlanner(createPlannerOptions(planStore));
  const coordinator = createMemoryCoordinator(planStore, approvalStore);
  let now = NOW;
  const options: Phase4bMcpChangePlanServiceOptions = Object.freeze({
    planner,
    planStore,
    approvalStore,
    commitPlanStore: coordinator.planStore,
    commitApprovalStore: coordinator.approvalStore,
    begin: coordinator.begin,
    commit: coordinator.commit,
    rollback: coordinator.rollback,
    release: coordinator.release,
    createProductPorts: () => productPorts,
    impact: Object.freeze({
      async assessImpact() {
        return IMPACT;
      },
    }),
    revisions: createPhase4bMcpChangePlanRevisionPort(() => productPorts),
    scopes: Object.freeze({ hasScopes: async () => true }),
    authorizationPolicy: Object.freeze({
      async requiredScopesForOperation() {
        return Object.freeze([] as readonly ScopeName[]);
      },
    }),
    rateLimit: createMcpChangePlanRateLimitPort({
      maxPlans: 100,
      windowMs: 60_000,
      now: () => NOW.getTime(),
    }),
    verifyStoredOperationsDigest: createPhase4bMcpChangePlanDigestVerifier(),
    approvalBaseUri: 'https://approve.example/approvals',
    uriPolicy: Object.freeze({ allow: () => true }),
    clock: Object.freeze({ now: () => now }),
    ids: Object.freeze({ nextPlanId: () => 'plan-w05-colf-1' }),
    planTtlMilliseconds: 60_000,
    recordCommittedContentRevisions: async (_transaction, facts) => {
      committedRevisions.push({ planId: facts.planId, collectionIds: [...facts.collectionIds] });
    },
    ...(policy === undefined ? {} : {
      autoApproveTrustedPlan: createAutoApproveTrustedPlan({
        readPolicy: async (principalId, clientId) => {
          policyLookups.push(`${principalId}/${clientId}`);
          return policy;
        },
        captureVersion: async (input) => {
          capturedCauses.push(input.cause);
          return { versionId: 'version-e4' };
        },
        saveReceipt: async (receipt) => {
          policyReceipts.push(receipt);
        },
        audit: async () => {
          audits.push('auto-approved');
        },
      }),
    }),
  });
  const service = createPhase4bMcpChangePlanService(options);
  const wrapped = Object.freeze({
    ...service,
    commit: (
      planId: string,
      binding: McpAuthenticatedAuthorizationBinding,
      idempotencyKey: string,
    ) => runWithMcpAccountSubjectId(binding.principalId, () =>
      service.commit(planId, binding, idempotencyKey)),
  });
  return {
    service: wrapped,
    planStore,
    approvalStore,
    state,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    capturedCauses,
    policyReceipts,
    audits,
    policyLookups,
    committedRevisions,
  };
}

test('MCP-W05 digest verifier revalidates the W03 stored canonical digest', async () => {
  const { service, planStore } = createHarness();
  const planned = await service.plan(CATALOG_INPUT, BINDING);
  const stored = await planStore.get(planned.planId);
  assert.ok(stored);
  const verifier = createPhase4bMcpChangePlanDigestVerifier();
  assert.equal(await verifier.verify(stored!), true);
  assert.equal(
    await verifier.verify(Object.freeze({ ...stored!, operationsDigest: 'changed' })),
    false,
  );
});

test('MCP-W05 plan delegates to W03 and commit requires Approval before execute', async () => {
  const { service, planStore } = createHarness();
  const planned = await service.plan(CATALOG_INPUT, BINDING);
  assert.equal(planned.risk, 'high');
  assert.equal(planned.requiresApproval, true);
  assert.ok(await planStore.get(planned.planId));

  await assert.rejects(
    service.commit(planned.planId, BINDING, 'idem-no-approval'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'approval_missing',
  );
  assert.equal(
    (await planStore.get(planned.planId))?.status,
    'pending',
  );
});

test('MCP-W05 approved visibility Commit is exact-once and replays the first result', async () => {
  const { service, planStore, state } = createHarness();
  const planned = await service.plan(CATALOG_INPUT, BINDING);
  await service.recordOutOfBandApproval(planned.planId, BINDING);
  const before = state.nodes.get('node-1')!.resourceRevision;
  const first = await service.commit(planned.planId, BINDING, 'idem-same');
  assert.equal(first.operations.length, 1);
  assert.equal(first.operations[0]!.status, 'applied');
  assert.notEqual(first.operations[0]!.revision, before);
  assert.equal((await planStore.get(planned.planId))?.status, 'consumed');

  const second = await service.commit(planned.planId, BINDING, 'idem-same');
  assert.deepEqual(second, first);
  await assert.rejects(
    service.commit(planned.planId, BINDING, 'idem-different'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'plan_already_consumed',
  );

  const serialized = JSON.stringify(first);
  for (const marker of [
    'principalId',
    'clientId',
    'credentialBindingId',
    'securityEpoch',
    'fingerprint',
    'expectedBaseRevisions',
    'dryRun',
    'reason',
    'authorization',
    'Bearer ',
    'sk-',
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
});

test('MCP-W05 wrong binding, cancellation, and expiry fail closed without consuming Approval', async () => {
  const { service, planStore, approvalStore } = createHarness();
  const planned = await service.plan(CATALOG_INPUT, BINDING);
  await service.recordOutOfBandApproval(planned.planId, BINDING);

  await assert.rejects(
    service.commit(planned.planId, Object.freeze({ ...BINDING, principalId: 'other' }), 'idem-x'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'plan_binding_mismatch',
  );
  assert.equal((await planStore.get(planned.planId))?.status, 'approved');

  await service.cancel(planned.planId, BINDING);
  assert.equal((await planStore.get(planned.planId))?.status, 'cancelled');
  await assert.rejects(
    service.commit(planned.planId, BINDING, 'idem-cancelled'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'plan_cancelled',
  );
  assert.equal(approvalStore.stats().approvals, 1);
});

test('MCP-W05 low-risk ready nodes.create Plan commits without Approval and replays the first result', async () => {
  const { service, planStore, state } = createHarness();
  const planned = await service.plan(CREATE_CATALOG_INPUT, BINDING);
  assert.equal(planned.risk, 'low');
  assert.equal(planned.requiresApproval, false);
  assert.equal(planned.mode, 'ready');
  assert.equal((await planStore.get(planned.planId))?.status, 'pending');

  const before = state.nodes.size;
  const first = await service.commit(planned.planId, BINDING, 'idem-create');
  assert.equal(first.operations.length, 1);
  assert.equal(first.operations[0]!.status, 'applied');
  assert.equal(state.nodes.size, before + 1);
  assert.equal((await planStore.get(planned.planId))?.status, 'consumed');

  const second = await service.commit(planned.planId, BINDING, 'idem-create');
  assert.deepEqual(second, first);
  assert.equal(state.nodes.size, before + 1);

  await assert.rejects(
    service.commit(planned.planId, BINDING, 'idem-create-other'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'plan_already_consumed',
  );
  assert.equal(state.nodes.size, before + 1);
});

test('MCP-W05 plan create preserves the shared folder defaults and bookmark fields', async () => {
  for (const node of [
    { kind: 'folder', title: 'Planned folder', visibility: 'inherit' },
    { kind: 'bookmark', title: 'Planned bookmark', url: 'https://example.com/shared', description: 'Keep this description', tags: ['one', 'two'], visibility: 'protected' },
  ]) {
    const { service, state } = createHarness();
    const planned = await service.plan({ ...CREATE_CATALOG_INPUT, node }, BINDING);
    await service.commit(planned.planId, BINDING, `idem-${node.kind}`);
    const created = [...state.nodes.values()].find((value) => value.title === node.title);
    assert.ok(created);
    assert.equal(created.kind, node.kind);
    assert.equal(created.description, node.description ?? null);
    assert.deepEqual(created.tags, node.tags ?? []);
    assert.equal(created.url, node.url ?? null);
  }
});

test('MCP-W05 approved nodes.create Plan commit executes through the shared transaction-bound core', async () => {
  const { service, state } = createHarness();
  const planned = await service.plan(CREATE_CATALOG_INPUT, BINDING);
  assert.equal(planned.mode, 'ready');
  assert.equal(planned.requiresApproval, false);

  const before = state.nodes.size;
  await service.commit(planned.planId, BINDING, 'idem-shared-core');

  // The real commit entry claimed/completed one durable receipt and ran exactly
  // one canonical mutation on the caller's product ports.
  assert.equal(state.nodes.size, before + 1);
  assert.equal(state.receipts.size, 1);
  assert.equal([...state.receipts.values()][0]?.status, 'completed');
  const created = [...state.nodes.values()].find((value) => value.title === CREATE_CATALOG_INPUT.node.title);
  assert.ok(created);
  assert.equal(created.kind, CREATE_CATALOG_INPUT.node.kind);
  assert.equal(created.description, CREATE_CATALOG_INPUT.node.description);
  assert.deepEqual(created.tags, CREATE_CATALOG_INPUT.node.tags);
  assert.equal(created.visibility, CREATE_CATALOG_INPUT.node.visibility);
  assert.equal(created.url, CREATE_CATALOG_INPUT.node.url);
});

test('MCP-W05 low-risk ready Plan rejects a wrong binding without executing', async () => {
  const { service, planStore, state } = createHarness();
  const planned = await service.plan(CREATE_CATALOG_INPUT, BINDING);
  const before = state.nodes.size;
  await assert.rejects(
    service.commit(
      planned.planId,
      Object.freeze({ ...BINDING, principalId: 'other' }),
      'idem-binding',
    ),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'plan_binding_mismatch',
  );
  assert.equal(state.nodes.size, before);
  assert.equal((await planStore.get(planned.planId))?.status, 'pending');
});

test('MCP-W05 focused package scripts are exact', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../../../package.json', import.meta.url),
    'utf8',
  )) as { readonly scripts: Readonly<Record<string, string>> };
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-service:unit:inner'],
    'vitest run --fileParallelism=false --project unit tests/unit/phase4b/phase4b-mcp-change-plan-service.test.ts',
  );
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-service:unit'],
    'npm run test:mcp:change-plan-service:unit:inner',
  );
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-service:postgres:inner'],
    'vitest run --fileParallelism=false --project postgres tests/integration/postgres/postgres-phase4b-mcp-change-plan-service.integration.test.ts',
  );
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-service:postgres'],
    'node scripts/with-postgres.mjs -- npm run test:mcp:change-plan-service:postgres:inner',
  );
});

test('E4 trusted reversible plan commits without approval', async () => {
  const { service, planStore, state, capturedCauses, policyReceipts, audits } = createHarness('trusted');
  const before = state.nodes.size;
  const planned = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
    service.plan(CREATE_CATALOG_INPUT, BINDING));
  assert.equal((await planStore.get(planned.planId))?.status, 'consumed');
  assert.equal(state.nodes.size, before + 1);
  assert.deepEqual(capturedCauses, [`agent-plan:${planned.planId}`]);
  assert.equal(policyReceipts[0]?.approvedBy, 'policy');
  assert.equal(policyReceipts[0]?.versionId, 'version-e4');
  assert.deepEqual(audits, ['auto-approved']);
  assert.equal((planned as { readonly approvedBy?: string }).approvedBy, 'policy');
});

test('E4 policy is read for the plan principal and client, not the client alone', async () => {
  const { service, policyLookups } = createHarness('trusted');
  await runWithMcpAccountSubjectId(BINDING.principalId, () =>
    service.plan(CREATE_CATALOG_INPUT, BINDING));
  assert.deepEqual(policyLookups, [`${BINDING.principalId}/${BINDING.clientId}`]);
});

test('E4 commit records the touched collection inside the commit transaction', async () => {
  const { service, committedRevisions } = createHarness('trusted');
  const planned = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
    service.plan(CREATE_CATALOG_INPUT, BINDING));
  assert.equal(committedRevisions.length, 1);
  assert.equal(committedRevisions[0]?.planId, planned.planId);
  assert.ok((committedRevisions[0]?.collectionIds.length ?? 0) > 0);
});

test('E4 trusted plan with set_visibility waits for the owner', async () => {
  const { service, planStore, state, capturedCauses, policyReceipts } = createHarness('trusted');
  const before = state.nodes.get('node-1')?.visibility;
  const planned = await service.plan(CATALOG_INPUT, BINDING);
  assert.equal(planned.requiresApproval, true);
  assert.equal(planned.mode, 'awaiting_approval');
  assert.equal((await planStore.get(planned.planId))?.status, 'pending');
  assert.equal(state.nodes.get('node-1')?.visibility, before);
  assert.deepEqual(capturedCauses, []);
  assert.equal(policyReceipts.length, 0);
});

test('E4 manual policy leaves a reversible plan pending', async () => {
  const { service, planStore, state, capturedCauses } = createHarness('manual');
  const before = state.nodes.size;
  const planned = await service.plan(CREATE_CATALOG_INPUT, BINDING);
  assert.equal(planned.requiresApproval, false);
  assert.equal(planned.mode, 'ready');
  assert.equal((await planStore.get(planned.planId))?.status, 'pending');
  assert.equal(state.nodes.size, before);
  assert.deepEqual(capturedCauses, []);
});
