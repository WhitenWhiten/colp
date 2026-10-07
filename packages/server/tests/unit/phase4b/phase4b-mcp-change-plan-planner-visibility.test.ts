import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ScopeName,
} from '@know-n/colp/types';
import {
  aggregatePhase4bMcpRisk,
  Phase4bMcpChangePlanPlannerError,
  computePhase4bMcpCanonicalDigest,
  createPhase4bMcpChangePlanPlanner,
  phase4bMcpPlanSummary,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpPlannedChange,
  type Phase4bMcpStoredPlan,
} from '../../../src/modules/mcp/change-plan-planner.js';
import type { Phase4bMcpCollectionVisibility } from '../../../src/modules/mcp/write-dependency-gate.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const APPROVAL_ORIGIN = 'https://approve.example';
const APPROVAL_BASE_URI = `${APPROVAL_ORIGIN}/approvals`;
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const NOW = '2026-08-05T12:00:00.000Z';

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

function createRevisions(
  collectionVisibility: Phase4bMcpCollectionVisibility = 'private',
) {
  return Object.freeze({
    parentChildrenRevision: 'children-r1',
    collectionContentRevision: 'content-r1',
    collectionVisibility,
  });
}

function visibilityFacts() {
  return Object.freeze({
    resourceRevision: 'resource-r1',
    policyRevision: 'policy-r1',
  });
}

function policy(decision: readonly ScopeName[] = Object.freeze([])) {
  return Object.freeze({
    requiredScopesForOperation: async () => decision,
  });
}

function options(
  overrides: Readonly<Partial<Phase4bMcpChangePlanPlannerOptions>> = Object.freeze({}),
): Phase4bMcpChangePlanPlannerOptions {
  const plans = new Map<string, Phase4bMcpStoredPlan>();
  return Object.freeze({
    planStore: Object.freeze({
      save(plan: Phase4bMcpStoredPlan) {
        plans.set(plan.planId, plan);
      },
      get(planId: string) {
        return plans.get(planId);
      },
    }),
    authoritativeState: Object.freeze({
      resolveCreateBaseRevisions: async (
        input: { collectionId: string; parentId: string },
        binding: McpAuthenticatedAuthorizationBinding,
      ) => {
        assert.equal(input.collectionId, CREATE_INPUT.collectionId);
        assert.equal(input.parentId, CREATE_INPUT.parentId);
        assert.equal(binding.principalId, BINDING.principalId);
        return createRevisions();
      },
      resolveVisibilityFacts: async (
        input: { collectionId: string; nodeId: string },
        binding: McpAuthenticatedAuthorizationBinding,
      ) => {
        assert.equal(input.collectionId, VISIBILITY_INPUT.collectionId);
        assert.equal(input.nodeId, VISIBILITY_INPUT.nodeId);
        assert.equal(binding.principalId, BINDING.principalId);
        return visibilityFacts();
      },
    }),
    authorizationPolicy: policy(),
    impact: Object.freeze({
      assessImpact: async () => IMPACT,
    }),
    approvalBaseUri: APPROVAL_BASE_URI,
    approvalUriPolicy: Object.freeze({
      allow: (input: { purpose: 'approval'; origin: string }) =>
        input.purpose === 'approval' && input.origin === APPROVAL_ORIGIN,
    }),
    clock: Object.freeze({ now: () => new Date(NOW) }),
    ids: Object.freeze({
      nextPlanId: () => 'plan-w03-1',
      nextOperationId: () => 'op-w03-1',
    }),
    serverUuid: SERVER_UUID,
    inputBudget: Object.freeze({
      maxDepth: 32,
      maxNodes: 1000,
      maxBytes: 65_536,
      maxOperations: 1,
    }),
    ...overrides,
  });
}

function inheritCreateInput() {
  return Object.freeze({
    ...CREATE_INPUT,
    node: Object.freeze({
      ...CREATE_INPUT.node,
      visibility: 'inherit',
    }),
  });
}

function plannerWithCollectionVisibility(collectionVisibility: Phase4bMcpCollectionVisibility) {
  return {
    authoritativeState: Object.freeze({
      resolveCreateBaseRevisions: async () => createRevisions(collectionVisibility),
      resolveVisibilityFacts: async () => visibilityFacts(),
    }),
  };
}

function planner(overrides: Readonly<Partial<Phase4bMcpChangePlanPlannerOptions>> = Object.freeze({})) {
  return createPhase4bMcpChangePlanPlanner(options(overrides));
}

async function planned(
  input: unknown,
  overrides: Readonly<Partial<Phase4bMcpChangePlanPlannerOptions>> = Object.freeze({}),
): Promise<Phase4bMcpPlannedChange> {
  return planner(overrides).plan(input, BINDING);
}

test('MCP-W03 keeps inherit create low and ready on public or unlisted collections', async () => {
  for (const collectionVisibility of ['public', 'unlisted'] as const) {
    const result = await planned(
      inheritCreateInput(),
      plannerWithCollectionVisibility(collectionVisibility),
    );
    assert.equal(result.mode, 'ready', collectionVisibility);
    assert.equal(result.risk, 'low', collectionVisibility);
    assert.equal(result.requiresApproval, false, collectionVisibility);
    assert.equal(
      aggregatePhase4bMcpRisk(result.operations, { collectionVisibility }),
      'low',
      collectionVisibility,
    );
  }
});

test('MCP-W03 keeps inherit create low and ready on private or protected collections', async () => {
  for (const collectionVisibility of ['private', 'protected'] as const) {
    const result = await planned(
      inheritCreateInput(),
      plannerWithCollectionVisibility(collectionVisibility),
    );
    assert.equal(result.mode, 'ready', collectionVisibility);
    assert.equal(result.risk, 'low', collectionVisibility);
    assert.equal(result.requiresApproval, false, collectionVisibility);
    assert.equal(
      aggregatePhase4bMcpRisk(result.operations, { collectionVisibility }),
      'low',
      collectionVisibility,
    );
  }
});

test('MCP-W03 does not raise non-inherit create when the collection is public', async () => {
  const result = await planned(
    CREATE_INPUT,
    plannerWithCollectionVisibility('public'),
  );
  assert.equal(result.mode, 'ready');
  assert.equal(result.risk, 'low');
  assert.equal(result.requiresApproval, false);
});
