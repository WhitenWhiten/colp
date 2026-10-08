import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { Kysely } from 'kysely';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  OperationResult,
  ScopeName,
} from '@know-n/colp/types';
import { createPostgresMcpChangePlanStore, createPostgresProductCommandReceiptPort, runMigrations, type DatabaseRuntime, type DatabaseSchema, type DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { createPostgresCanonicalMutationPorts, createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionWritePort, createPostgresCollectionsClock, createPostgresNodeWritePort, type PostgresCanonicalMutationFaultInjector } from '../../../src/infrastructure/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import {
  createPhase4bMcpAgentApprovalApi,
  createPostgresAutoApproveTrustedPlan,
  recordMcpPlanCommitRevisions,
} from '../../../src/infrastructure/collections/index.js';
import { AgentPlanUndoError } from '../../../src/modules/mcp/agent-plan-policy.js';
import {
  createCanonicalMutationApplication,
  createOwnedCollectionCanonical,
  type CreateOwnedCollectionInput,
  type ProductCollectionCanonicalPorts,
} from '../../../src/modules/collections/index.js';
import {
  createPhase4bMcpChangePlanPlanner,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpStoredPlan,
} from '../../../src/modules/mcp/change-plan-planner.js';
import {
  createPhase4bMcpLowRiskNodeCreateService,
  type Phase4bMcpLowRiskNodeCreateContext,
} from '../../../src/modules/mcp/low-risk-node-create.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import {
  createPhase4bMcpChangePlanDigestVerifier,
  createPhase4bMcpChangePlanRevisionPort,
  createPhase4bMcpChangePlanService,
  type Phase4bMcpChangePlanService,
  type Phase4bMcpChangePlanServiceOptions,
} from '../../../src/modules/mcp/change-plan-service.js';
import { createMcpChangePlanRateLimitPort } from '../../../src/bootstrap/mcp-write-composition.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const NOW = new Date();

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: PRINCIPAL_ID,
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

interface FixtureFacts {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly rootId: string;
  readonly resourceRevision: string;
  readonly policyRevision: string;
  readonly contentRevision: string;
}

interface CanonicalCounts {
  readonly nodes: number;
  readonly operations: number;
  readonly audits: number;
  readonly outbox: number;
  readonly productReceipts: number;
  readonly mcpReceipts: number;
  readonly approvals: number;
}

interface DeferredTransactionState {
  readonly transaction: DatabaseTransaction;
  readonly resolveFinish: (value: unknown) => void;
  readonly promise: Promise<unknown>;
}

function createDeferredTransactionCoordinator(db: Kysely<DatabaseSchema>) {
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
      if (state === undefined) throw new Error('commit without an open MCP-W05 transaction');
      state.resolveFinish(undefined);
      await state.promise;
      states.delete(transaction);
    },
    async rollback(transaction: DatabaseTransaction, cause: unknown): Promise<void> {
      const state = states.get(transaction);
      if (state === undefined) throw new Error('rollback without an open MCP-W05 transaction');
      state.resolveFinish(Promise.reject(cause));
      try {
        await state.promise;
      } catch {
        // The Kysely transaction rolled back as expected.
      }
      states.delete(transaction);
    },
    async release(): Promise<void> {
      return undefined;
    },
  });
}

function createPostgresProductPorts(
  transaction: DatabaseTransaction,
  faultInjector?: PostgresCanonicalMutationFaultInjector,
): ProductCollectionCanonicalPorts {
  const rawCanonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(
    transaction,
    faultInjector === undefined ? {} : { faultInjector },
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
        throw new Error('MCP-W05 executor never bootstraps collections');
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
    }),
    accessPolicy,
  });
}

describeWithPostgres('MCP-W05 approved Change Plan Commit over PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w05', {
      maxConnections: 16,
      applicationName: 'known-mcp-w05-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      profiles, accounts, mcp_commit_receipts, mcp_approvals, mcp_change_plans,
      mcp_plan_policy_receipts, mcp_plan_commit_revisions, agent_policies,
      collection_version_restore_receipts, collection_tree_versions cascade`);
    await runtime.pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $1, 'active', 0)`,
      [PRINCIPAL_ID],
    );
    await runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'MCP W05 owner', null)`,
      [PRINCIPAL_ID],
    );
  });

  async function createFixture(): Promise<FixtureFacts> {
    const collectionId = randomBytes(16).toString('base64url');
    const rootId = randomBytes(16).toString('base64url');
    const commandId = randomUUID();
    const operationId = randomUUID();
    const input: CreateOwnedCollectionInput = {
      actor: {
        principalId: PRINCIPAL_ID,
        principalType: 'account',
        subjectId: PRINCIPAL_ID,
      },
      command: {
        commandId,
        fingerprint: 'fixture-collection-fingerprint',
      },
      title: 'MCP W05 Collection',
      summary: null,
      kind: 'bookmarks',
      collectionId,
      rootNodeId: rootId,
      operationId,
    };
    const result = await createPostgresCanonicalMutationUnitOfWork(runtime.db).execute((ports) =>
      createOwnedCollectionCanonical(ports, input));
    assert.equal(result.kind, 'created');
    const initialCollection = (await runtime.pool.query(
      `select content_revision, policy_revision from collections where id = $1`,
      [collectionId],
    )).rows[0];
    const initialRoot = (await runtime.pool.query(
      `select children_revision from nodes where id = $1`,
      [rootId],
    )).rows[0];

    const nodeCreateContext: Phase4bMcpLowRiskNodeCreateContext = Object.freeze({
      binding: BINDING,
      accountSubjectId: BINDING.principalId,
      scope: Object.freeze(['nodes:write']),
    });
    const nodeCreate = createPhase4bMcpLowRiskNodeCreateService({
      unitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
    });
    const created = await nodeCreate.execute(Object.freeze({
      input: Object.freeze({
        tool: 'nodes.create',
        collectionId,
        parentId: rootId,
        afterId: null,
        beforeId: null,
        node: Object.freeze({
          kind: 'bookmark',
          title: 'W05 bookmark',
          url: 'https://example.test/w05',
          description: null,
          tags: Object.freeze(['w05']),
          visibility: 'private',
        }),
        reason: 'create a bookmark',
        confirmApply: true,
      }),
      idempotencyKey: randomUUID(),
      expectedBaseRevisions: Object.freeze({
        [`children.${rootId}`]: initialRoot.children_revision,
        [`content.${collectionId}`]: initialCollection.content_revision,
        [`policy.${collectionId}`]: initialCollection.policy_revision,
      }),
    }), nodeCreateContext);
    if (created.resultType !== 'complete') {
      throw new Error('expected complete nodes.create output');
    }
    const node = (await runtime.pool.query(
      `select resource_revision from nodes where id = $1`,
      [created.node.id],
    )).rows[0];
    const collection = (await runtime.pool.query(
      `select content_revision, policy_revision from collections where id = $1`,
      [collectionId],
    )).rows[0];
    return {
      collectionId,
      nodeId: created.node.id,
      rootId,
      resourceRevision: node.resource_revision,
      policyRevision: collection.policy_revision,
      contentRevision: collection.content_revision,
    };
  }

  function plannerOptions(
    store: ReturnType<typeof createPostgresMcpChangePlanStore>,
    clock: { readonly now: () => Date } = Object.freeze({ now: () => NOW }),
    planTtlMilliseconds?: number,
  ): Phase4bMcpChangePlanPlannerOptions {
    return Object.freeze({
      planStore: Object.freeze({
        save: (plan: Phase4bMcpStoredPlan) => store.planStore.save(plan),
        get: (planId: string) => store.planStore.get(planId),
      }),
      authoritativeState: Object.freeze({
        async resolveCreateBaseRevisions(input: { collectionId: string; parentId: string }) {
          const collection = (await runtime.pool.query(
            `select content_revision, visibility from collections
             where id = $1 and deleted_at is null`,
            [input.collectionId],
          )).rows[0];
          const parent = (await runtime.pool.query(
            `select children_revision from nodes
             where id = $1 and collection_id = $2 and deleted_at is null`,
            [input.parentId, input.collectionId],
          )).rows[0];
          if (collection === undefined || parent === undefined) {
            throw new Error('MCP-W05 fixture create facts disappeared before planning');
          }
          return Object.freeze({
            parentChildrenRevision: parent.children_revision as string,
            collectionContentRevision: collection.content_revision as string,
            collectionVisibility: collection.visibility as 'private' | 'protected' | 'unlisted' | 'public',
          });
        },
        async resolveVisibilityFacts(input: { collectionId: string; nodeId: string }) {
          const node = (await runtime.pool.query(
            `select resource_revision from nodes
             where id = $1 and collection_id = $2`,
            [input.nodeId, input.collectionId],
          )).rows[0];
          const collection = (await runtime.pool.query(
            `select policy_revision from collections where id = $1`,
            [input.collectionId],
          )).rows[0];
          if (node === undefined || collection === undefined) {
            throw new Error('MCP-W05 fixture state disappeared before planning');
          }
          return Object.freeze({
            resourceRevision: node.resource_revision as string,
            policyRevision: collection.policy_revision as string,
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
      clock,
      ids: Object.freeze({
        nextPlanId: () => `plan-w05-${randomUUID().replaceAll('-', '')}`,
        nextOperationId: () => `op-w05-${randomUUID().replaceAll('-', '')}`,
      }),
      inputBudget: Object.freeze({
        maxDepth: 32,
        maxNodes: 1000,
        maxBytes: 65_536,
        maxOperations: 1,
      }),
      ...(planTtlMilliseconds === undefined ? {} : { planTtlMilliseconds }),
    });
  }

  function createHarness(options: {
    readonly scopeAllowed?: boolean;
    readonly rateAllowed?: boolean;
    readonly planTtlMilliseconds?: number;
    readonly faultInjector?: PostgresCanonicalMutationFaultInjector;
    readonly commitFaultPhase?: 'plan_store' | 'approval' | 'revision' | 'receipt';
    readonly verifyStoredOperationsDigest?: Phase4bMcpChangePlanServiceOptions['verifyStoredOperationsDigest'];
  } = {}) {
    const store = createPostgresMcpChangePlanStore(runtime.db);
    const coordinator = createDeferredTransactionCoordinator(runtime.db);
    const createProductPorts = (transaction: DatabaseTransaction) =>
      createPostgresProductPorts(transaction, options.faultInjector);
    let commitFaultsEnabled = false;
    const failCommitPhase = (phase: NonNullable<typeof options.commitFaultPhase>): void => {
      if (commitFaultsEnabled && options.commitFaultPhase === phase) {
        throw new Error(`w05-${phase}-rollback-probe`);
      }
    };
    const commitPlanStore: typeof store.commitPlanStore = Object.freeze({
      async lock(transaction, planId) {
        const value = await store.commitPlanStore.lock(transaction, planId);
        failCommitPhase('plan_store');
        return value;
      },
      update: store.commitPlanStore.update,
    });
    const commitApprovalStore: typeof store.commitApprovalStore = Object.freeze({
      markApproved: store.commitApprovalStore.markApproved,
      async beginCommit(transaction, input) {
        const value = await store.commitApprovalStore.beginCommit(transaction, input);
        failCommitPhase('approval');
        return value;
      },
      async finalizeCommit(transaction, input) {
        await store.commitApprovalStore.finalizeCommit(transaction, input);
        failCommitPhase('receipt');
      },
    });
    const revisionBase = createPhase4bMcpChangePlanRevisionPort(createProductPorts);
    const revisions: typeof revisionBase = Object.freeze({
      resolveBaseRevisions: revisionBase.resolveBaseRevisions,
      async currentRevisions(transaction, baseRevisions, binding) {
        const value = await revisionBase.currentRevisions(transaction, baseRevisions, binding);
        failCommitPhase('revision');
        return value;
      },
    });
    let now = new Date();
    let impactNodes = IMPACT.nodes;
    const planner = createPhase4bMcpChangePlanPlanner(
      plannerOptions(
        store,
        Object.freeze({ now: () => now }),
        options.planTtlMilliseconds,
      ),
    );
    const serviceOptions: Phase4bMcpChangePlanServiceOptions = Object.freeze({
      autoApproveTrustedPlan: createPostgresAutoApproveTrustedPlan(runtime.db),
      recordCommittedContentRevisions: recordMcpPlanCommitRevisions as unknown as NonNullable<
        Phase4bMcpChangePlanServiceOptions['recordCommittedContentRevisions']>,
      planner,
      planStore: store.planStore,
      approvalStore: store.approvalStore,
      commitPlanStore,
      commitApprovalStore,
      begin: coordinator.begin,
      commit: coordinator.commit,
      rollback: coordinator.rollback,
      release: coordinator.release,
      createProductPorts,
      impact: Object.freeze({
        async assessImpact() {
          return Object.freeze({ ...IMPACT, nodes: impactNodes });
        },
      }),
      revisions,
      scopes: Object.freeze({
        hasScopes: async () => options.scopeAllowed ?? true,
      }),
      authorizationPolicy: Object.freeze({
        async requiredScopesForOperation() {
          return Object.freeze([] as readonly ScopeName[]);
        },
      }),
      rateLimit: options.rateAllowed === false
        ? Object.freeze({ allow: async () => false })
        : createMcpChangePlanRateLimitPort({
            maxPlans: 100,
            windowMs: 60_000,
            now: () => now.getTime(),
          }),
      verifyStoredOperationsDigest:
        options.verifyStoredOperationsDigest ?? createPhase4bMcpChangePlanDigestVerifier(),
      approvalBaseUri: 'https://approve.example/approvals',
      uriPolicy: Object.freeze({ allow: () => true }),
      clock: Object.freeze({ now: () => now }),
      ids: Object.freeze({
        nextPlanId: () => `plan-w05-${randomUUID().replaceAll('-', '')}`,
      }),
      ...(options.planTtlMilliseconds === undefined
        ? {}
        : { planTtlMilliseconds: options.planTtlMilliseconds }),
    });
    const service: Phase4bMcpChangePlanService = createPhase4bMcpChangePlanService(serviceOptions);
    const wrapped: Phase4bMcpChangePlanService = Object.freeze({
      ...service,
      commit: (planId, binding, idempotencyKey) =>
        runWithMcpAccountSubjectId(binding.principalId, () =>
          service.commit(planId, binding, idempotencyKey)),
    });
    return {
      service: wrapped,
      store,
      advance(ms: number) {
        now = new Date(now.getTime() + ms);
      },
      setImpactNodes(value: number) {
        impactNodes = value;
      },
      enableCommitFaults() {
        commitFaultsEnabled = true;
      },
    };
  }

  function planInput(fixture: FixtureFacts, visibility = 'protected') {
    return Object.freeze({
      tool: 'nodes.set_visibility',
      collectionId: fixture.collectionId,
      nodeId: fixture.nodeId,
      visibility,
      baseRevision: fixture.resourceRevision,
      reason: 'publish this node',
      dryRun: true,
    });
  }

  function createPlanInput(fixture: FixtureFacts) {
    return Object.freeze({
      tool: 'nodes.create',
      collectionId: fixture.collectionId,
      parentId: fixture.rootId,
      afterId: null,
      beforeId: null,
      node: Object.freeze({
        kind: 'bookmark',
        title: 'W05 planned bookmark',
        url: 'https://example.test/planned',
        description: null,
        tags: Object.freeze(['w05-planned']),
        visibility: 'private',
      }),
      reason: 'create a planned bookmark',
      dryRun: true,
    });
  }

  async function counts(): Promise<CanonicalCounts> {
    const result = await runtime.pool.query<CanonicalCounts>(`select
      (select count(*)::int from nodes) nodes,
      (select count(*)::int from operations) operations,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from product_command_receipts) as "productReceipts",
      (select count(*)::int from mcp_commit_receipts) as "mcpReceipts",
      (select count(*)::int from mcp_approvals) approvals`);
    return result.rows[0]!;
  }

  test('approved visibility Commit is exact-once, persists receipt, and replays the first result', async () => {
    const fixture = await createFixture();
    const harness = createHarness();
    const before = await counts();
    const planned = await harness.service.plan(planInput(fixture), BINDING);
    assert.equal(planned.requiresApproval, true);
    assert.deepEqual(await counts(), before);

    await harness.service.recordOutOfBandApproval(planned.planId, BINDING);
    const first = await harness.service.commit(planned.planId, BINDING, 'idem-same');
    assert.equal(first.operations.length, 1);
    assert.equal(first.operations[0]!.status, 'applied');

    const after = await counts();
    assert.deepEqual(after, {
      ...before,
      operations: before.operations + 1,
      audits: before.audits + 1,
      outbox: before.outbox + 1,
      productReceipts: before.productReceipts + 1,
      mcpReceipts: before.mcpReceipts + 1,
      approvals: before.approvals + 1,
    });
    assert.equal((await harness.store.planStore.get(planned.planId))?.status, 'consumed');
    const node = (await runtime.pool.query(
      `select visibility from nodes where id = $1`,
      [fixture.nodeId],
    )).rows[0];
    assert.equal(node.visibility, 'protected');

    const replay = await harness.service.commit(planned.planId, BINDING, 'idem-same');
    assert.deepEqual(replay, first);
    assert.deepEqual(await counts(), after);

    await assert.rejects(
      harness.service.commit(planned.planId, BINDING, 'idem-different'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'plan_already_consumed',
    );
  });

  test('low-risk ready nodes.create Plan commits without Approval, creates one node, and replays the first result', async () => {
    const fixture = await createFixture();
    const harness = createHarness();
    const before = await counts();
    const planned = await harness.service.plan(createPlanInput(fixture), BINDING);
    assert.equal(planned.risk, 'low');
    assert.equal(planned.requiresApproval, false);
    assert.equal(planned.mode, 'ready');
    assert.equal(planned.operations[0]!.type, 'create_node');
    assert.deepEqual(await counts(), before);

    const first = await harness.service.commit(planned.planId, BINDING, 'idem-create');
    assert.equal(first.operations.length, 1);
    assert.equal(first.operations[0]!.status, 'applied');

    const after = await counts();
    assert.deepEqual(after, {
      ...before,
      nodes: before.nodes + 1,
      operations: before.operations + 1,
      audits: before.audits + 1,
      outbox: before.outbox + 1,
      productReceipts: before.productReceipts + 1,
      mcpReceipts: before.mcpReceipts + 1,
      approvals: before.approvals,
    });
    assert.equal((await harness.store.planStore.get(planned.planId))?.status, 'consumed');
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_approvals where plan_id = $1`,
      [planned.planId],
    )).rows[0]?.count, 0);

    const replay = await harness.service.commit(planned.planId, BINDING, 'idem-create');
    assert.deepEqual(replay, first);
    assert.deepEqual(await counts(), after);

    await assert.rejects(
      harness.service.commit(planned.planId, BINDING, 'idem-create-other'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'plan_already_consumed',
    );
    assert.deepEqual(await counts(), after);
  });

  test('deny, wrong binding, expiry, cancel, revision drift, digest drift, scope, rate, and impact fail closed', async () => {
    const fixture = await createFixture();
    const before = await counts();
    let expected = before;

    const deny = createHarness();
    const denied = await deny.service.plan(planInput(fixture), BINDING);
    await assert.rejects(
      deny.service.commit(denied.planId, BINDING, 'idem-deny'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'approval_missing',
    );
    assert.deepEqual(await counts(), before);

    const binding = createHarness();
    const bound = await binding.service.plan(planInput(fixture), BINDING);
    await binding.service.recordOutOfBandApproval(bound.planId, BINDING);
    expected = await counts();
    await assert.rejects(
      binding.service.commit(
        bound.planId,
        Object.freeze({ ...BINDING, credentialBindingId: 'other-credential' }),
        'idem-binding',
      ),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'plan_binding_mismatch',
    );
    assert.deepEqual(await counts(), expected);

    const scope = createHarness({ scopeAllowed: false });
    const scoped = await scope.service.plan(planInput(fixture), BINDING);
    await scope.service.recordOutOfBandApproval(scoped.planId, BINDING);
    expected = await counts();
    await assert.rejects(
      scope.service.commit(scoped.planId, BINDING, 'idem-scope'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'scope_invalid',
    );
    assert.deepEqual(await counts(), expected);

    const rate = createHarness({ rateAllowed: false });
    const rated = await rate.service.plan(planInput(fixture), BINDING);
    await rate.service.recordOutOfBandApproval(rated.planId, BINDING);
    expected = await counts();
    await assert.rejects(
      rate.service.commit(rated.planId, BINDING, 'idem-rate'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'rate_limited',
    );
    assert.deepEqual(await counts(), expected);

    const impact = createHarness();
    const impacted = await impact.service.plan(planInput(fixture), BINDING);
    await impact.service.recordOutOfBandApproval(impacted.planId, BINDING);
    expected = await counts();
    impact.setImpactNodes(2);
    await assert.rejects(
      impact.service.commit(impacted.planId, BINDING, 'idem-impact'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'impact_exceeded',
    );
    assert.deepEqual(await counts(), expected);

    const expired = createHarness({ planTtlMilliseconds: 60_000 });
    const expiring = await expired.service.plan(planInput(fixture), BINDING);
    await expired.service.recordOutOfBandApproval(expiring.planId, BINDING);
    expected = await counts();
    expired.advance(120_000);
    await assert.rejects(
      expired.service.commit(expiring.planId, BINDING, 'idem-expired'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'plan_expired',
    );
    assert.deepEqual(await counts(), expected);

    const revision = createHarness();
    const revised = await revision.service.plan(planInput(fixture), BINDING);
    await revision.service.recordOutOfBandApproval(revised.planId, BINDING);
    expected = await counts();
    await runtime.pool.query(
      `update nodes set resource_revision = 'drifted-revision' where id = $1`,
      [fixture.nodeId],
    );
    await assert.rejects(
      revision.service.commit(revised.planId, BINDING, 'idem-revision'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'revision_drift',
    );
    assert.deepEqual(await counts(), expected);
    await runtime.pool.query(
      `update nodes set resource_revision = $1 where id = $2`,
      [fixture.resourceRevision, fixture.nodeId],
    );

    const digest = createHarness({
      verifyStoredOperationsDigest: Object.freeze({ verify: async () => false }),
    });
    const digested = await digest.service.plan(planInput(fixture), BINDING);
    await digest.service.recordOutOfBandApproval(digested.planId, BINDING);
    expected = await counts();
    await assert.rejects(
      digest.service.commit(digested.planId, BINDING, 'idem-digest'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'digest_mismatch',
    );
    assert.deepEqual(await counts(), expected);

    const cancelled = createHarness();
    const cancelPlan = await cancelled.service.plan(planInput(fixture), BINDING);
    await cancelled.service.cancel(cancelPlan.planId, BINDING);
    // FIX-L-052: beginCommit rejects a cancelled Plan with the dedicated
    // plan_cancelled reason; the version-locked COLP coordinator maps that
    // unknown rejected reason through its generic single-winner fallback
    // (plan_already_consumed) until the colp mapping is extended.
    await assert.rejects(
      cancelled.service.commit(cancelPlan.planId, BINDING, 'idem-cancel'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'plan_already_consumed',
    );
    assert.deepEqual(await counts(), expected);
  });

  test('concurrent same-key and commit/cancel races have one durable winner', async () => {
    const fixture = await createFixture();
    const harness = createHarness();
    const planned = await harness.service.plan(planInput(fixture), BINDING);
    await harness.service.recordOutOfBandApproval(planned.planId, BINDING);

    const sameKey = await Promise.allSettled([
      harness.service.commit(planned.planId, BINDING, 'idem-race'),
      harness.service.commit(planned.planId, BINDING, 'idem-race'),
    ]);
    const fulfilled = sameKey.filter((entry) => entry.status === 'fulfilled');
    const rejected = sameKey.filter((entry) => entry.status === 'rejected');
    assert.ok(fulfilled.length >= 1);
    if (fulfilled.length === 2) {
      assert.deepEqual(
        (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<Phase4bMcpChangePlanService['commit']>>>).value,
        (fulfilled[1] as PromiseFulfilledResult<Awaited<ReturnType<Phase4bMcpChangePlanService['commit']>>>).value,
      );
    }
    if (rejected.length > 0) {
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      assert.ok(
        reason instanceof Error
        && (reason as { code?: string }).code === 'plan_already_consumed',
      );
    }
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts`,
    )).rows[0]?.count, 1);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where id = $1 and visibility = 'protected'`,
      [fixture.nodeId],
    )).rows[0]?.count, 1);

    const cancelFixture = await createFixture();
    const cancelHarness = createHarness();
    const cancelPlan = await cancelHarness.service.plan(planInput(cancelFixture), BINDING);
    await cancelHarness.service.recordOutOfBandApproval(cancelPlan.planId, BINDING);
    const race = await Promise.allSettled([
      cancelHarness.service.commit(cancelPlan.planId, BINDING, 'idem-cancel-race'),
      cancelHarness.service.cancel(cancelPlan.planId, BINDING),
    ]);
    assert.ok(race.some((entry) => entry.status === 'fulfilled'));
    const status = (await cancelHarness.store.planStore.get(cancelPlan.planId))?.status;
    const visible = (await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where id = $1 and visibility = 'protected'`,
      [cancelFixture.nodeId],
    )).rows[0]?.count;
    if (status === 'consumed') {
      assert.equal(visible, 1);
      assert.equal(
        (await runtime.pool.query<{ count: number }>(
          `select count(*)::int count from mcp_commit_receipts
           where plan_id = $1 and idempotency_key = 'idem-cancel-race'`,
          [cancelPlan.planId],
        )).rows[0]?.count,
        1,
      );
    } else {
      assert.equal(status, 'cancelled');
      assert.equal(visible, 0);
    }
  });

  test('each Plan, Approval, revision, canonical, operation, Audit, Outbox, and receipt fault rolls back', async () => {
    const hostPhases = ['plan_store', 'approval', 'revision', 'receipt'] as const;
    for (const phase of hostPhases) {
      await assertCommitFaultRollsBack(createHarness({ commitFaultPhase: phase }), phase);
    }
    const canonicalPhases = ['resource', 'revision', 'operation', 'audit', 'outbox'] as const;
    for (const phase of canonicalPhases) {
      await assertCommitFaultRollsBack(createHarness({
        faultInjector: Object.freeze({
          afterPhase(context) {
            if (context.phase === phase) throw new Error(`w05-canonical-${phase}-rollback-probe`);
          },
        }),
      }), `canonical_${phase}`);
    }
  }, 120_000);

  async function assertCommitFaultRollsBack(
    harness: ReturnType<typeof createHarness>,
    phase: string,
  ): Promise<void> {
    const fixture = await createFixture();
    const planned = await harness.service.plan(planInput(fixture), BINDING);
    await harness.service.recordOutOfBandApproval(planned.planId, BINDING);
    const afterApproval = await counts();
    harness.enableCommitFaults();
    await assert.rejects(
      harness.service.commit(planned.planId, BINDING, `idem-rollback-${phase}`),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'commit_failed',
    );
    assert.deepEqual(await counts(), afterApproval, `partial write after ${phase} fault`);
    assert.equal((await harness.store.planStore.get(planned.planId))?.status, 'approved');
  }

  test('unknown Plan operations and malformed result shapes fail closed without resource writes', async () => {
    const fixture = await createFixture();
    const harness = createHarness({
      verifyStoredOperationsDigest: Object.freeze({ verify: async () => true }),
    });
    const unknownNow = new Date();
    const unknownPlan = Object.freeze({
      planId: `plan-unknown-${randomUUID().replaceAll('-', '')}`,
      expiresAt: new Date(unknownNow.getTime() + 60_000).toISOString(),
      risk: 'high',
      requiresApproval: true,
      approvalMethod: 'out_of_band',
      approvalUri: 'https://approve.example/approvals/unknown',
      summary: 'unknown operation',
      impact: IMPACT,
      requiredScopes: Object.freeze(['access:write'] as readonly ScopeName[]),
      baseRevisions: Object.freeze({
        [`node.${fixture.nodeId}`]: fixture.resourceRevision,
        [`policy.${fixture.collectionId}`]: fixture.policyRevision,
      }),
      operations: Object.freeze([Object.freeze({
        type: 'unknown_operation',
        collectionId: fixture.collectionId,
        baseRevision: fixture.resourceRevision,
        input: Object.freeze({ visibility: 'protected' }),
      })]),
      operationsDigest: 'sha-256:unknown',
      binding: BINDING,
      untrustedNote: 'unknown operation fixture',
      createdAt: unknownNow.toISOString(),
      status: 'pending',
    });
    await harness.store.planStore.save(unknownPlan);
    await harness.service.recordOutOfBandApproval(unknownPlan.planId, BINDING);
    const afterApproval = await counts();
    await assert.rejects(
      harness.service.commit(unknownPlan.planId, BINDING, 'idem-unknown'),
      (error: unknown) => error instanceof Error
        && (error as { code?: string }).code === 'commit_failed',
    );
    assert.deepEqual(await counts(), afterApproval);
  });

  test('E4 trusted reversible plan commits without approval and Undo restores the pre-commit tree', async () => {
    const fixture = await createFixture();
    await runtime.pool.query(
      `insert into agent_policies (principal_id, client_id, policy) values ($1, $2, 'trusted')`,
      [PRINCIPAL_ID, BINDING.clientId],
    );
    const harness = createHarness();
    const before = await liveTitles(fixture.collectionId);
    const planned = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
      harness.service.plan(createPlanInput(fixture), BINDING));
    assert.equal((await harness.store.planStore.get(planned.planId))?.status, 'consumed');
    assert.equal((planned as { readonly approvedBy?: string }).approvedBy, 'policy');
    const committed = await liveTitles(fixture.collectionId);
    assert.equal(committed.includes('W05 planned bookmark'), true);
    assert.equal(committed.length, before.length + 1);
    const version = (await runtime.pool.query<{ version_id: string; cause: string }>(
      `select version_id, cause from collection_tree_versions where collection_id = $1`,
      [fixture.collectionId],
    )).rows[0];
    assert.ok(version);
    assert.equal(version.cause, `agent-plan:${planned.planId}`);
    const receipt = (await runtime.pool.query<{ approved_by: string; version_id: string }>(
      `select approved_by, version_id from mcp_plan_policy_receipts where plan_id = $1`,
      [planned.planId],
    )).rows[0];
    assert.equal(receipt?.approved_by, 'policy');
    assert.equal(receipt?.version_id, version.version_id);
    const audit = (await runtime.pool.query<{ details: { decision?: string } }>(
      `select payload.details_json as details
         from audit_events event
         join audit_event_payloads payload on payload.event_id = event.hot_payload_id
        where event.event_type = 'mcp.approval_decision'
        order by event.id desc limit 1`,
    )).rows[0];
    assert.equal(audit?.details.decision, 'auto-approved');

    const api = createPhase4bMcpAgentApprovalApi(runtime.db);
    const undone = await api.undo({
      accountId: PRINCIPAL_ID,
      subjectId: PRINCIPAL_ID,
      planId: planned.planId,
      force: false,
      commandId: randomUUID(),
    });
    assert.equal(undone.restored, true);
    const restored = await liveTitles(fixture.collectionId);
    assert.deepEqual(restored.sort(), before.sort());
  });

  test('E4 trusted set_visibility waits and a missing policy stays manual', async () => {
    const fixture = await createFixture();
    await runtime.pool.query(
      `insert into agent_policies (principal_id, client_id, policy) values ($1, $2, 'trusted')`,
      [PRINCIPAL_ID, BINDING.clientId],
    );
    const visibility = (await runtime.pool.query<{ visibility: string }>(
      `select visibility from nodes where id = $1`,
      [fixture.nodeId],
    )).rows[0]?.visibility;
    const trusted = createHarness();
    const waiting = await trusted.service.plan(planInput(fixture), BINDING);
    assert.equal(waiting.requiresApproval, true);
    assert.equal((await trusted.store.planStore.get(waiting.planId))?.status, 'pending');
    assert.equal((await runtime.pool.query<{ visibility: string }>(
      `select visibility from nodes where id = $1`,
      [fixture.nodeId],
    )).rows[0]?.visibility, visibility);
    assert.equal((await runtime.pool.query(
      `select count(*)::int as n from mcp_plan_policy_receipts`,
    )).rows[0]?.n, 0);

    await runtime.pool.query(`delete from agent_policies where client_id = $1`, [BINDING.clientId]);
    const manualFixture = await createFixture();
    const before = await liveTitles(manualFixture.collectionId);
    const manual = createHarness();
    const pending = await manual.service.plan(createPlanInput(manualFixture), BINDING);
    assert.equal((await manual.store.planStore.get(pending.planId))?.status, 'pending');
    assert.deepEqual(await liveTitles(manualFixture.collectionId), before);
  });

  test('E4 Undo refuses a newer version unless forced and refuses a sync tombstone conflict', async () => {
    const fixture = await createFixture();
    await runtime.pool.query(
      `insert into agent_policies (principal_id, client_id, policy) values ($1, $2, 'trusted')`,
      [PRINCIPAL_ID, BINDING.clientId],
    );
    const harness = createHarness();
    const planned = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
      harness.service.plan(createPlanInput(fixture), BINDING));
    await runtime.pool.query(
      `insert into collection_tree_versions (
         version_id, account_id, collection_id, content_revision, kind, label, etag,
         node_count, tree_json, created_at, cause
       )
       select 'newer-version-e4', account_id, collection_id, 'newer-content-revision', kind, label, etag,
              node_count, tree_json, created_at + interval '1 second', 'web'
         from collection_tree_versions
        where collection_id = $1`,
      [fixture.collectionId],
    );
    const api = createPhase4bMcpAgentApprovalApi(runtime.db);
    await assert.rejects(
      api.undo({
        accountId: PRINCIPAL_ID,
        subjectId: PRINCIPAL_ID,
        planId: planned.planId,
        force: false,
        commandId: randomUUID(),
      }),
      (error: unknown) => error instanceof AgentPlanUndoError && error.code === 'newer_version',
    );
    assert.equal((await liveTitles(fixture.collectionId)).includes('W05 planned bookmark'), true);
    const forced = await api.undo({
      accountId: PRINCIPAL_ID,
      subjectId: PRINCIPAL_ID,
      planId: planned.planId,
      force: true,
      commandId: randomUUID(),
    });
    assert.equal(forced.restored, true);
    assert.equal((await liveTitles(fixture.collectionId)).includes('W05 planned bookmark'), false);

    const again = await createFixture();
    const againPlan = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
      harness.service.plan(createPlanInput(again), BINDING));
    await runtime.pool.query(
      `update nodes set deleted_at = current_timestamp where id = $1`,
      [again.nodeId],
    );
    await assert.rejects(
      api.undo({
        accountId: PRINCIPAL_ID,
        subjectId: PRINCIPAL_ID,
        planId: againPlan.planId,
        force: true,
        commandId: randomUUID(),
      }),
      (error: unknown) => error instanceof AgentPlanUndoError
        && error.code === 'sync_tombstone_conflict'
        && error.message.includes('sync tombstone'),
    );
    assert.equal((await liveTitles(again.collectionId)).includes('W05 planned bookmark'), true);
  });

  test('E4 Undo refuses when the collection changed after the plan unless forced', async () => {
    const fixture = await createFixture();
    await runtime.pool.query(
      `insert into agent_policies (principal_id, client_id, policy) values ($1, $2, 'trusted')`,
      [PRINCIPAL_ID, BINDING.clientId],
    );
    const harness = createHarness();
    const planned = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
      harness.service.plan(createPlanInput(fixture), BINDING));
    const recorded = (await runtime.pool.query<{ content_revision: string }>(
      `select content_revision from mcp_plan_commit_revisions where plan_id = $1 and collection_id = $2`,
      [planned.planId, fixture.collectionId],
    )).rows[0]?.content_revision;
    const live = (await runtime.pool.query<{ content_revision: string }>(
      `select content_revision from collections where id = $1`,
      [fixture.collectionId],
    )).rows[0]?.content_revision;
    assert.equal(recorded, live);
    // A later change that creates no version: a manual plan of another client,
    // like a browser sync or a web edit.
    const otherClient = { ...BINDING, clientId: 'client-2' };
    const later = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
      harness.service.plan(createPlanInput(fixture), otherClient));
    await harness.service.recordOutOfBandApproval(later.planId, otherClient);
    await harness.service.commit(later.planId, otherClient, randomUUID());
    assert.equal((await liveTitles(fixture.collectionId)).filter((title) => title === 'W05 planned bookmark').length, 2);
    const api = createPhase4bMcpAgentApprovalApi(runtime.db);
    await assert.rejects(
      api.undo({
        accountId: PRINCIPAL_ID,
        subjectId: PRINCIPAL_ID,
        planId: planned.planId,
        force: false,
        commandId: randomUUID(),
      }),
      (error: unknown) => error instanceof AgentPlanUndoError && error.code === 'newer_changes',
    );
    assert.equal((await liveTitles(fixture.collectionId)).includes('W05 planned bookmark'), true);
    const forced = await api.undo({
      accountId: PRINCIPAL_ID,
      subjectId: PRINCIPAL_ID,
      planId: planned.planId,
      force: true,
      commandId: randomUUID(),
    });
    assert.equal(forced.restored, true);
    assert.equal((await liveTitles(fixture.collectionId)).includes('W05 planned bookmark'), false);
  });

  test('E4 a trusted policy of another account does not auto-approve this account', async () => {
    const fixture = await createFixture();
    await runtime.pool.query(
      `insert into agent_policies (principal_id, client_id, policy) values ($1, $2, 'trusted')`,
      ['another-account', BINDING.clientId],
    );
    const before = await liveTitles(fixture.collectionId);
    const harness = createHarness();
    const planned = await runWithMcpAccountSubjectId(BINDING.principalId, () =>
      harness.service.plan(createPlanInput(fixture), BINDING));
    assert.equal((await harness.store.planStore.get(planned.planId))?.status, 'pending');
    assert.deepEqual(await liveTitles(fixture.collectionId), before);
    const api = createPhase4bMcpAgentApprovalApi(runtime.db);
    assert.equal((await api.getAgentPolicy(PRINCIPAL_ID, BINDING.clientId)).policy, 'manual');
    assert.equal((await api.getAgentPolicy('another-account', BINDING.clientId)).policy, 'trusted');
  });

  async function liveTitles(collectionId: string): Promise<string[]> {
    const rows = (await runtime.pool.query<{ title: string }>(
      `select title from nodes
        where collection_id = $1 and deleted_at is null and not is_root
        order by title`,
      [collectionId],
    )).rows;
    return rows.map((row) => row.title);
  }
});
