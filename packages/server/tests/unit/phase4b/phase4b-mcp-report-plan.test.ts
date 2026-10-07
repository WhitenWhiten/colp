import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  approveMcpReportPlan,
  commitMcpReportPlan,
  computeMcpReportPlanDigest,
  createMcpReportPlan,
  McpReportPlanError,
  MCP_REPORT_PLAN_NEGATIVE_CONTROLS,
  type McpReportPlan,
} from '../../../src/modules/mcp/report-plan.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import { createReportMcpWriteToolPort } from '../../../src/modules/mcp/report-write-tools.js';

const binding: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated', principalId: 'p1', clientId: 'c1', credentialBindingId: 'cred1',
  resourceAudience: 'colp://known/collections', securityEpoch: 'e1',
});
const op = Object.freeze({ type: 'report' as const, action: 'series.update' as const,
  targetId: 'series-1', expectedRevision: 'r1', patch: Object.freeze({ title: 'Private draft' }) });

function store() {
  const plans = new Map<string, McpReportPlan>();
  return { plans, save: (p: McpReportPlan) => { plans.set(p.planId, p); }, get: (id: string) => plans.get(id), update: (p: McpReportPlan) => { plans.set(p.planId, p); } };
}

test('typed report plan serializes, binds, approves, and commits exactly once', async () => {
  const s = store();
  const plan = await createMcpReportPlan({ planId: 'rp-1', operations: [op], binding,
    requiredScopes: ['reports:write'], reportRevision: 'r1', sourceRevisions: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(), store: s });
  assert.equal(plan.operations[0]!.type, 'report');
  const approved = await approveMcpReportPlan(s, plan.planId, binding);
  let calls = 0;
  const revisions = { currentReportRevision: () => 'r1', currentSourceRevisions: () => ({}) };
  const first = await commitMcpReportPlan({ planId: plan.planId, binding, scopes: ['reports:write'], idempotencyKey: 'k1', store: s, revisions, executor: { execute: () => { calls += 1; return { ok: true }; } } });
  assert.equal(first.kind, 'committed');
  const replay = await commitMcpReportPlan({ planId: plan.planId, binding, scopes: ['reports:write'], idempotencyKey: 'k1', store: s, revisions, executor: { execute: () => { calls += 1; } } });
  assert.equal(replay.kind, 'replay');
  for (const field of ['principalId', 'clientId', 'credentialBindingId', 'resourceAudience', 'securityEpoch'] as const) {
    await assert.rejects(() => commitMcpReportPlan({ planId: plan.planId,
      binding: { ...binding, [field]: 'foreign' }, scopes: ['reports:write'], idempotencyKey: 'k1',
      store: s, revisions, executor: { execute: () => { calls += 1; } },
    }), (error: unknown) => error instanceof McpReportPlanError && error.code === 'binding_mismatch');
  }
  await assert.rejects(() => commitMcpReportPlan({ planId: plan.planId, binding,
    scopes: [], idempotencyKey: 'k1', store: s, revisions, executor: { execute: () => { calls += 1; } },
  }), (error: unknown) => error instanceof McpReportPlanError && error.code === 'scope_downgrade');

  assert.equal(calls, 1);
  assert.equal(approved.approval.status, 'approved');
  assert.equal(computeMcpReportPlanDigest(plan), plan.operationsDigest);
});

test('publicization requires approval and negative controls are non-empty', async () => {
  const s = store();
  const plan = await createMcpReportPlan({ planId: 'rp-public', operations: [{ ...op, patch: { visibility: 'public' } }], binding,
    requiredScopes: ['reports:write'], reportRevision: 'r1', expiresAt: new Date(Date.now() + 60_000).toISOString(), store: s });
  await assert.rejects(() => commitMcpReportPlan({ planId: plan.planId, binding, scopes: ['reports:write'], idempotencyKey: 'k', store: s,
    revisions: { currentReportRevision: () => 'r1', currentSourceRevisions: () => ({}) }, executor: { execute: () => null } }),
  (error: unknown) => error instanceof McpReportPlanError && error.code === 'approval_required');
  assert.ok(MCP_REPORT_PLAN_NEGATIVE_CONTROLS.length > 0);
});

test('foreign binding, scope downgrade, stale report, and unknown commit fail closed', async () => {
  const s = store();
  const plan = await createMcpReportPlan({ planId: 'rp-neg', operations: [op], binding,
    requiredScopes: ['reports:write'], reportRevision: 'r1', expiresAt: new Date(Date.now() + 60_000).toISOString(), store: s });
  await approveMcpReportPlan(s, plan.planId, binding);
  const foreign = { ...binding, principalId: 'p2' } as McpAuthenticatedAuthorizationBinding;
  await assert.rejects(() => commitMcpReportPlan({ planId: plan.planId, binding: foreign, scopes: ['reports:write'], idempotencyKey: 'x', store: s, revisions: { currentReportRevision: () => 'r1', currentSourceRevisions: () => ({}) }, executor: { execute: () => null } }), /binding/);
  await assert.rejects(() => commitMcpReportPlan({ planId: plan.planId, binding, scopes: [], idempotencyKey: 'x', store: s, revisions: { currentReportRevision: () => 'r1', currentSourceRevisions: () => ({}) }, executor: { execute: () => null } }), /scope/);
  await assert.rejects(() => commitMcpReportPlan({ planId: plan.planId, binding, scopes: ['reports:write'], idempotencyKey: 'x', store: s, revisions: { currentReportRevision: () => 'r2', currentSourceRevisions: () => ({}) }, executor: { execute: () => null } }), /revision/);
  await assert.rejects(() => commitMcpReportPlan({ planId: 'missing', binding, scopes: ['reports:write'], idempotencyKey: 'x', store: s, revisions: { currentReportRevision: () => 'r1', currentSourceRevisions: () => ({}) }, executor: { execute: () => null } }), /found/);
});

test('report plans reject open operation shapes and oversized values before persistence', async () => {
  const s = store();
  await assert.rejects(
    () => createMcpReportPlan({
      planId: 'rp-open-shape',
      operations: [{ ...op, privateField: 'must-not-persist' } as never],
      binding,
      requiredScopes: ['reports:write'],
      reportRevision: 'r1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      store: s,
    }),
    (error: unknown) => error instanceof McpReportPlanError && error.code === 'invalid_plan',
  );
  await assert.rejects(
    () => createMcpReportPlan({
      planId: 'rp-large',
      operations: [{ ...op, patch: { title: 'x'.repeat(513) } }],
      binding,
      requiredScopes: ['reports:write'],
      reportRevision: 'r1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      store: s,
    }),
    (error: unknown) => error instanceof McpReportPlanError && error.code === 'invalid_plan',
  );
  await assert.rejects(
    () => createMcpReportPlan({
      planId: 'rp-binding',
      operations: [op],
      binding: { ...binding, sessionId: 'legacy-session' } as never,
      requiredScopes: ['reports:write'],
      reportRevision: 'r1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      store: s,
    }),
    (error: unknown) => error instanceof McpReportPlanError && error.code === 'invalid_plan',
  );
});

test('report write tool derives publish scope and exposes a typed closed operation schema', async () => {
  const s = store();
  const port = createReportMcpWriteToolPort({
    store: s,
    revisions: { currentReportRevision: () => 'r1', currentSourceRevisions: () => ({}) },
    executePlan: async () => ({ ok: true }),
  });
  const context = (scopes: readonly string[]) => createMcpApplicationContext({
    principal: binding,
    scopes,
    abortSignal: new AbortController().signal,
    budgets: { maxDepth: 16, maxNodes: 20, maxBytes: 16_384, maxOperations: 20 },
    correlationId: 'report-plan-test',
  });
  const listed = await port.listTools(context(['reports:write']));
  const planTool = listed.find((tool) => tool.name === 'reports.plan');
  assert.ok(planTool);
  const schema = planTool.inputSchema as Record<string, unknown>;
  const operations = schema.properties as Record<string, unknown>;
  const operationArray = operations.operations as Record<string, unknown>;
  assert.equal(operationArray.maxItems, 20);
  assert.equal((operationArray.items as Record<string, unknown>).type, 'object');
  assert.ok(Array.isArray((operationArray.items as Record<string, unknown>).oneOf));
  const privatePlan = await port.callTool(context(['reports:write']), 'reports.plan', {
    operations: [{ ...op, patch: { title: 'Private draft' } }], reportRevision: 'r1',
  });
  assert.equal(privatePlan.kind, 'complete');
  const publicPlan = await port.callTool(context(['reports:write']), 'reports.plan', {
    operations: [{ ...op, patch: { visibility: 'public' } }], reportRevision: 'r1',
  });
  assert.deepEqual(publicPlan, {
    kind: 'rejected', stableCode: 'insufficient_scope', safeMessage: 'Insufficient scope.', retryable: false,
  });
});


test('edition updates reject immutable identity fields instead of silently ignoring them', async () => {
  for (const patch of [{ issueKey: 'changed' }, { collectionId: 'other-source' }]) {
    await assert.rejects(() => createMcpReportPlan({ planId: 'immutable', binding,
      operations: [{ type: 'report', action: 'edition.update', targetId: 'edition', expectedRevision: 'r1', patch }],
      requiredScopes: ['reports:write'], reportRevision: 'r1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), store: store(),
    }), (error: unknown) => error instanceof McpReportPlanError && error.code === 'invalid_plan');
  }
});
