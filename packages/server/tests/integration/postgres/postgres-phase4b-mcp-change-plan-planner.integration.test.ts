import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ScopeName,
} from '@know-n/colp/types';
import { createAuthoritativeState } from '../../../src/bootstrap/mcp-write-composition.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresMcpChangePlanStore, runMigrations, type PostgresMcpStoredPlan } from '../../../src/infrastructure/database/index.js';
import {
  createOwnedCollectionCanonical,
  type CreateOwnedCollectionInput,
} from '../../../src/modules/collections/index.js';
import {
  Phase4bMcpChangePlanPlannerError,
  createPhase4bMcpChangePlanPlanner,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpStoredPlan,
} from '../../../src/modules/mcp/change-plan-planner.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

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

const CREATE_INPUT = Object.freeze({
  tool: 'nodes.create',
  collectionId: 'collection-1',
  parentId: 'root-1',
  afterId: null,
  beforeId: null,
  node: Object.freeze({
    kind: 'bookmark',
    title: 'Example bookmark',
    url: 'https://example.com',
    description: null,
    tags: Object.freeze([]),
    visibility: 'private',
  }),
  reason: 'create a bookmark',
  dryRun: true,
});

const VISIBILITY_INPUT = Object.freeze({
  tool: 'nodes.set_visibility',
  collectionId: 'collection-1',
  nodeId: 'node-1',
  visibility: 'protected',
  baseRevision: 'resource-r1',
  reason: 'publish this node',
  dryRun: true,
});

describeWithPostgres('MCP-W03 registered canonical operation planning over W02 stores', () => {
  let isolated: IsolatedPostgresRuntime;
  let store: ReturnType<typeof createPostgresMcpChangePlanStore>;
  let plannerOptions: Phase4bMcpChangePlanPlannerOptions;
  let planner: ReturnType<typeof createPhase4bMcpChangePlanPlanner>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w03', {
      maxConnections: 8,
    });
    await runMigrations(isolated.runtime.db, 'latest');
    store = createPostgresMcpChangePlanStore(isolated.runtime.db);
    plannerOptions = Object.freeze({
      planStore: Object.freeze({
        save: (plan: Phase4bMcpStoredPlan) =>
          store.planStore.save(plan as unknown as PostgresMcpStoredPlan),
        get: (planId: string) =>
          store.planStore.get(planId) as Promise<Phase4bMcpStoredPlan | undefined>,
      }),
      authoritativeState: Object.freeze({
        resolveCreateBaseRevisions: async () => Object.freeze({
          parentChildrenRevision: 'children-r1',
          collectionContentRevision: 'content-r1',
          collectionVisibility: 'private' as const,
        }),
        resolveVisibilityFacts: async () => Object.freeze({
          resourceRevision: 'resource-r1',
          policyRevision: 'policy-r1',
        }),
      }),
      authorizationPolicy: Object.freeze({
        requiredScopesForOperation: async () => [] as readonly ScopeName[],
      }),
      impact: Object.freeze({
        assessImpact: async () => IMPACT,
      }),
      approvalBaseUri: 'https://approve.example/approvals',
      approvalUriPolicy: Object.freeze({
        allow: (input: { purpose: 'approval'; origin: string }) =>
          input.purpose === 'approval' && input.origin === 'https://approve.example',
      }),
      clock: Object.freeze({ now: () => new Date('2026-08-05T12:00:00.000Z') }),
      ids: Object.freeze({
        nextPlanId: () => `plan-w03-${Math.random().toString(36).slice(2)}`,
        nextOperationId: () => `op-w03-${Math.random().toString(36).slice(2)}`,
      }),
      serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      inputBudget: Object.freeze({
        maxDepth: 32,
        maxNodes: 1000,
        maxBytes: 65_536,
        maxOperations: 1,
      }),
    });
    planner = createPhase4bMcpChangePlanPlanner(plannerOptions);
  }, 120_000);

  afterAll(async () => isolated?.close());

  beforeEach(async () => {
    await isolated.runtime.pool.query(
      'truncate table mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade',
    );
  });

  test('W03 ready and awaiting Plans persist through W02 PostgreSQL stores with unique digests', async () => {
    const ready = await planner.plan(CREATE_INPUT, BINDING);
    const awaiting = await planner.plan(VISIBILITY_INPUT, BINDING);

    const storedReady = await store.planStore.get(ready.planId);
    const storedAwaiting = await store.planStore.get(awaiting.planId);
    assert.ok(storedReady);
    assert.ok(storedAwaiting);
    assert.equal(storedReady.status, 'pending');
    assert.equal(storedReady.risk, 'low');
    assert.equal(storedReady.requiresApproval, false);
    assert.equal(storedAwaiting.status, 'pending');
    assert.equal(storedAwaiting.risk, 'high');
    assert.equal(storedAwaiting.requiresApproval, true);
    assert.equal(storedAwaiting.approvalMethod, 'out_of_band');
    assert.equal(storedAwaiting.approvalUri, 'https://approve.example/approvals/' + awaiting.planId);
    assert.equal(storedReady.operationsDigest, ready.operationsDigest);
    assert.equal(storedAwaiting.operationsDigest, awaiting.operationsDigest);
    assert.notEqual(ready.operationsDigest, awaiting.operationsDigest);
    assert.deepEqual(storedReady.requiredScopes, ['nodes:write']);
    assert.deepEqual(storedAwaiting.requiredScopes, ['access:write']);
    assert.equal((storedReady.operations[0] as { type: string }).type, 'create_node');
    assert.equal((storedAwaiting.operations[0] as { type: string }).type, 'set_visibility');

    const counts = await isolated.runtime.pool.query<{
      collections: number;
      nodes: number;
      operations: number;
      outbox: number;
      audits: number;
    }>(`select
      (select count(*)::int from collections) collections,
      (select count(*)::int from nodes) nodes,
      (select count(*)::int from operations) operations,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from audit_events) audits`);
    assert.deepEqual(counts.rows[0], {
      collections: 0,
      nodes: 0,
      operations: 0,
      outbox: 0,
      audits: 0,
    });
  });

  test('W03 rejects stale revisions without creating a Plan row', async () => {
    await assert.rejects(
      planner.plan({ ...VISIBILITY_INPUT, baseRevision: 'stale-r1' }, BINDING),
      (error: unknown) => error instanceof Error && /stale/u.test(error.message),
    );
    const count = await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from mcp_change_plans',
    );
    assert.equal(count.rows[0]?.count, 0);
  });

  test('W03 rejects public and unlisted visibility without creating a Plan row', async () => {
    for (const visibility of ['public', 'unlisted'] as const) {
      await assert.rejects(
        planner.plan({ ...VISIBILITY_INPUT, visibility }, BINDING),
        (error: unknown) => error instanceof Error
          && (error as { code?: string }).code === 'invalid_catalog_input',
      );
    }
    const count = await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from mcp_change_plans',
    );
    assert.equal(count.rows[0]?.count, 0);
  });

  function canonicalOpaqueId(): string {
    return randomBytes(16).toString('base64url');
  }

  const OWNER_ACCOUNT_ID = canonicalOpaqueId();
  const OWNER_SUBJECT_ID = canonicalOpaqueId();
  const STRANGER_ACCOUNT_ID = canonicalOpaqueId();
  const STRANGER_SUBJECT_ID = canonicalOpaqueId();

  async function seedOwnedCollection(): Promise<{
    readonly collectionId: string;
    readonly rootId: string;
    readonly contentRevision: string;
    readonly childrenRevision: string;
  }> {
    await truncateFixtureTables(isolated.runtime.pool, `truncate table mcp_commit_receipts, mcp_approvals, mcp_change_plans,
      product_command_receipts, outbox_events, audit_events, operations, policy_revisions, content_revisions,
      children_revisions, resource_revisions, collection_policies, collection_members, nodes, collections,
      resource_id_ledger, profiles, accounts cascade`);
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $2, 'active', 0), ($3, $4, 'active', 0)`,
      [OWNER_ACCOUNT_ID, OWNER_SUBJECT_ID, STRANGER_ACCOUNT_ID, STRANGER_SUBJECT_ID],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'T-A5 owner', null), ($2, 'T-A5 stranger', null)`,
      [OWNER_ACCOUNT_ID, STRANGER_ACCOUNT_ID],
    );
    const input: CreateOwnedCollectionInput = {
      actor: {
        principalId: OWNER_ACCOUNT_ID,
        principalType: 'account',
        subjectId: OWNER_SUBJECT_ID,
      },
      command: {
        commandId: randomUUID(),
        fingerprint: `ta5-collection-${randomUUID()}`,
      },
      title: 'T-A5 owner collection',
      summary: null,
      kind: 'bookmarks',
      collectionId: canonicalOpaqueId(),
      rootNodeId: canonicalOpaqueId(),
      operationId: randomUUID(),
    };
    const result = await createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db).execute((ports) =>
      createOwnedCollectionCanonical(ports, input));
    assert.equal(result.kind, 'created');
    return {
      collectionId: result.collection.id,
      rootId: result.root.id,
      contentRevision: result.collection.contentRevision,
      childrenRevision: result.root.childrenRevision,
    };
  }

  function authorizedPlanner() {
    return createPhase4bMcpChangePlanPlanner({
      ...plannerOptions,
      authoritativeState: createAuthoritativeState(isolated.runtime.db),
    });
  }

  function ownerBinding(): McpAuthenticatedAuthorizationBinding {
    return Object.freeze({ ...BINDING, principalId: OWNER_ACCOUNT_ID });
  }

  function strangerBinding(): McpAuthenticatedAuthorizationBinding {
    return Object.freeze({ ...BINDING, principalId: STRANGER_ACCOUNT_ID });
  }

  test('W03 member path still plans when account subject differs from binding.principalId', async () => {
    const fixture = await seedOwnedCollection();
    const planned = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, () =>
      authorizedPlanner().plan({
        ...CREATE_INPUT,
        collectionId: fixture.collectionId,
        parentId: fixture.rootId,
      }, ownerBinding()));
    assert.equal(planned.mode, 'ready');
    assert.equal(planned.baseRevisions[`children.${fixture.rootId}`], fixture.childrenRevision);
    assert.equal(planned.baseRevisions[`content.${fixture.collectionId}`], fixture.contentRevision);
  });

  test('W03 conceals a nodes:write holder who is not a member, matching a missing resource', async () => {
    const fixture = await seedOwnedCollection();
    const livePlanner = authorizedPlanner();
    const createInput = {
      ...CREATE_INPUT,
      collectionId: fixture.collectionId,
      parentId: fixture.rootId,
    };
    const missingInput = {
      ...CREATE_INPUT,
      collectionId: canonicalOpaqueId(),
      parentId: canonicalOpaqueId(),
    };

    const unauthorized = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
      try {
        await livePlanner.plan(createInput, strangerBinding());
        throw new Error('expected non-member planning to fail');
      } catch (error) {
        return error;
      }
    });
    const missing = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
      try {
        await livePlanner.plan(missingInput, strangerBinding());
        throw new Error('expected missing planning to fail');
      } catch (error) {
        return error;
      }
    });

    assert.ok(unauthorized instanceof Phase4bMcpChangePlanPlannerError);
    assert.ok(missing instanceof Phase4bMcpChangePlanPlannerError);
    assert.equal(unauthorized.code, 'authoritative_state_invalid');
    assert.equal(missing.code, unauthorized.code);
    assert.equal(missing.message, unauthorized.message);
    assert.doesNotMatch(unauthorized.message, /disappeared/u);
    assert.doesNotMatch(unauthorized.message, new RegExp(fixture.childrenRevision, 'u'));
    assert.doesNotMatch(unauthorized.message, new RegExp(fixture.contentRevision, 'u'));
    const count = await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from mcp_change_plans',
    );
    assert.equal(count.rows[0]?.count, 0);
  });

  async function setCollectionVisibility(
    collectionId: string,
    visibility: 'private' | 'protected' | 'unlisted' | 'public',
  ): Promise<void> {
    if (visibility === 'public' || visibility === 'unlisted') {
      const slug = `ta6-${visibility}-${randomBytes(6).toString('hex')}`;
      await isolated.runtime.pool.query(
        `update collections
            set visibility = $2, publication_slug = $3, published_at = current_timestamp
          where id = $1`,
        [collectionId, visibility, slug],
      );
      return;
    }
    await isolated.runtime.pool.query(
      'update collections set visibility = $2 where id = $1',
      [collectionId, visibility],
    );
  }

  function inheritCreateInput(fixture: {
    readonly collectionId: string;
    readonly rootId: string;
  }) {
    return Object.freeze({
      ...CREATE_INPUT,
      collectionId: fixture.collectionId,
      parentId: fixture.rootId,
      node: Object.freeze({
        ...CREATE_INPUT.node,
        visibility: 'inherit',
      }),
    });
  }

  test('W03 inherit create on a public or unlisted collection stays low-risk ready', async () => {
    for (const visibility of ['public', 'unlisted'] as const) {
      const fixture = await seedOwnedCollection();
      await setCollectionVisibility(fixture.collectionId, visibility);
      const planned = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, () =>
        authorizedPlanner().plan(inheritCreateInput(fixture), ownerBinding()));
      assert.equal(planned.mode, 'ready', visibility);
      assert.equal(planned.risk, 'low', visibility);
      assert.equal(planned.requiresApproval, false, visibility);
    }
  });

  test('W03 inherit create on a private collection stays low-risk ready', async () => {
    const fixture = await seedOwnedCollection();
    const planned = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, () =>
      authorizedPlanner().plan(inheritCreateInput(fixture), ownerBinding()));
    assert.equal(planned.mode, 'ready');
    assert.equal(planned.risk, 'low');
    assert.equal(planned.requiresApproval, false);
  });
});
