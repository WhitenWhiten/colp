import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { ChangePlanImpact, ScopeName } from '@know-n/colp/types';
import {
  Phase4bMcpChangePlanPlannerError,
  createPhase4bMcpChangePlanPlanner,
  type Phase4bMcpChangePlanPlannerOptions,
  type Phase4bMcpNodeCreateOperation,
} from '../../../src/modules/mcp/change-plan-planner.js';
import { Phase4bMcpLowRiskNodeCreateError } from '../../../src/modules/mcp/low-risk-node-create.js';
import { phase4bMcpResolvedCreateVisibility } from '../../../src/modules/mcp/write-dependency-gate.js';
import {
  CONTEXT,
  IDEMPOTENCY_KEY,
  createCapturingService,
  createdResult,
} from '../../support/phase4b-mcp-low-risk-node-create-fixture.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const APPROVAL_ORIGIN = 'https://approve.example';
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

function plannerOptions(): Phase4bMcpChangePlanPlannerOptions {
  return Object.freeze({
    planStore: Object.freeze({
      save() {
        return undefined;
      },
      get() {
        return undefined;
      },
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
      requiredScopesForOperation: async () => Object.freeze([] as readonly ScopeName[]),
    }),
    impact: Object.freeze({ assessImpact: async () => IMPACT }),
    approvalBaseUri: `${APPROVAL_ORIGIN}/approvals`,
    approvalUriPolicy: Object.freeze({
      allow: (input: { purpose: 'approval'; origin: string }) =>
        input.purpose === 'approval' && input.origin === APPROVAL_ORIGIN,
    }),
    clock: Object.freeze({ now: () => new Date(NOW) }),
    ids: Object.freeze({
      nextPlanId: () => 'plan-w03-visibility',
      nextOperationId: () => 'op-w03-visibility',
    }),
    serverUuid: SERVER_UUID,
  });
}

function createCatalogInput(node: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    tool: 'nodes.create' as const,
    collectionId: 'collection-1',
    parentId: 'root-1',
    afterId: null,
    beforeId: null,
    node: Object.freeze(node),
    reason: 'create a node',
    dryRun: true as const,
  });
}

function createNodeRequest(node: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    input: Object.freeze({
      tool: 'nodes.create' as const,
      collectionId: 'collection-1',
      parentId: 'root-1',
      afterId: null,
      beforeId: null,
      node: Object.freeze(node),
      reason: 'create a node',
      confirmApply: true as const,
    }),
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedBaseRevisions: Object.freeze({}),
  });
}

// Pre-fix `change-plan-planner.ts` required `node.visibility` through
// `readOwnRequiredString` and validated the enum. The unified parser made it
// optional, so the Plan admission rule must pin the original strictness.
test('MCP-W03 plan admission requires an explicit node visibility', async () => {
  for (const node of [
    { kind: 'folder', title: 'Folder title' },
    { kind: 'bookmark', title: 'Bookmark title', url: 'https://example.com' },
  ] as const) {
    const planner = createPhase4bMcpChangePlanPlanner(plannerOptions());
    await assert.rejects(
      planner.plan(createCatalogInput(node), BINDING),
      (error: unknown) => error instanceof Phase4bMcpChangePlanPlannerError
        && error.code === 'invalid_catalog_input',
      `folder/bookmark plan must reject omitted visibility: ${node.kind}`,
    );
  }
});

test('MCP-W03 plan admission rejects a non-canonical node visibility', async () => {
  for (const visibility of ['', 'public', 'unlisted', 'inherit ', 3] as const) {
    const planner = createPhase4bMcpChangePlanPlanner(plannerOptions());
    await assert.rejects(
      planner.plan(createCatalogInput({ kind: 'folder', title: 'Folder title', visibility }), BINDING),
      (error: unknown) => error instanceof Phase4bMcpChangePlanPlannerError
        && error.code === 'invalid_catalog_input',
      `plan must reject visibility ${JSON.stringify(visibility)}`,
    );
  }
});

test('MCP-W03 plan admission accepts every canonical node visibility', async () => {
  for (const visibility of ['inherit', 'protected', 'private'] as const) {
    const planner = createPhase4bMcpChangePlanPlanner(plannerOptions());
    const result = await planner.plan(
      createCatalogInput({ kind: 'folder', title: 'Folder title', visibility }),
      BINDING,
    );
    const operation = result.operations[0] as Phase4bMcpNodeCreateOperation;
    assert.equal(operation.type, 'create_node', visibility);
    assert.equal(operation.payload.node.visibility, visibility);
  }
});

// Pre-fix `low-risk-node-create.ts` kept `visibility` optional and resolved it
// from the collection through `phase4bMcpResolvedCreateVisibility`.
test('MCP-W04 direct create keeps node visibility optional and resolves it from the collection', async () => {
  for (const collectionVisibility of ['private', 'protected', 'public', 'unlisted'] as const) {
    const { service, probe, capture } = createCapturingService(createdResult(), { collectionVisibility });
    const output = await service.execute(
      createNodeRequest({ kind: 'bookmark', title: 'Bookmark title', url: 'https://example.com' }),
      CONTEXT,
    );
    assert.equal(output.resultType, 'complete', collectionVisibility);
    assert.ok(probe.claimCalls >= 1, collectionVisibility);
    assert.equal(
      capture.kindFields?.visibility,
      phase4bMcpResolvedCreateVisibility(undefined, collectionVisibility),
      collectionVisibility,
    );
  }
});

test('MCP-W04 direct create rejects a non-canonical node visibility', async () => {
  const { service } = createCapturingService(createdResult());
  for (const visibility of ['public', 'unlisted'] as const) {
    await assert.rejects(
      service.execute(
        createNodeRequest({ kind: 'folder', title: 'Folder title', visibility }),
        CONTEXT,
      ),
      (error: unknown) => error instanceof Phase4bMcpLowRiskNodeCreateError
        && error.code === 'invalid_catalog_input',
      visibility,
    );
  }
});
