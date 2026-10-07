import { createInMemoryApprovalStore, createInMemoryPlanStore } from '../../support/mcp-memory-stores.js';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  type McpChangePlanServiceOptions,
} from '@know-n/colp/mcp';
import { authenticatedBinding } from '../../support/mcp-authenticated-binding-fixture.js';
import { createCommitCoordinatorFixture, resolveFixtureBaseRevisions } from '../../support/mcp-commit-coordinator-fixture.js';
import { createPhase4bMcpGatewayPlanner } from '../../../src/modules/mcp/change-plan-gateway-planner.js';
import { createPhase4bMcpChangePlanDigestVerifier } from '../../../src/modules/mcp/change-plan-service.js';

const binding = authenticatedBinding({ principalId: 'gateway-planner-principal', clientId: 'gateway-planner-client' });
const impact = { collections: 1, nodes: 1, annotations: 0, attachments: 0, relations: 0, privateFieldsExcluded: [] };

test('gateway planner persists Plans whose digest the Phase4b Commit verifier accepts', async () => {
  const clock = { now: () => new Date('2026-09-29T12:00:00.000Z') };
  const planStore = createInMemoryPlanStore({ clock });
  const approvalStore = createInMemoryApprovalStore({ clock });
  const options: McpChangePlanServiceOptions = {
    planStore, approvalStore,
    commitCoordinator: createCommitCoordinatorFixture(planStore, approvalStore, { execute: async () => [] }),
    impact: { assessImpact: async () => impact },
    revisions: {
      resolveBaseRevisions: async (op) => resolveFixtureBaseRevisions(op),
      currentRevisions: async (_transaction, base) => base,
    },
    scopes: { hasScopes: async () => true },
    authorizationPolicy: { requiredScopesForOperation: async () => [] },
    rateLimit: { allow: async () => true },
    approvalBaseUri: 'https://approval.example.test/review', uriPolicy: { allow: () => true },
    clock, ids: { nextPlanId: () => 'gateway-planner-plan' },
  };
  const planner = createPhase4bMcpGatewayPlanner(options);
  const planned = await planner.plan({
    operations: [{
      type: 'set_visibility', collectionId: 'gateway-planner-collection', baseRevision: 'acl_1',
      input: { visibility: 'public' },
    }],
    dryRun: true,
    reason: 'gateway planner digest',
  }, binding);

  const stored = await planStore.get(planned.planId);
  assert.ok(stored);
  assert.equal(createPhase4bMcpChangePlanDigestVerifier().verify(stored), true);
  assert.equal(
    createPhase4bMcpChangePlanDigestVerifier().verify({ ...stored, operationsDigest: 'sha-256:tampered' }),
    false,
  );
});
