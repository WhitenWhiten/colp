import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  ChangePlanImpact,
  ChangePlanOperation,
  ScopeName,
} from '@know-n/colp/types';
import {
  assertNoLegacyMcpSessionFields,
  buildPostgresMcpChangePlanRow,
  createMcpBindingDigest,
  PostgresMcpChangePlanStoreError,
  type PostgresMcpStoredPlan,
} from '../../../src/infrastructure/database/mcp-change-plan-store.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const OPERATION: ChangePlanOperation = Object.freeze({
  type: 'set_visibility',
  collectionId: 'collection-1',
  baseRevision: 'rev-1',
  input: Object.freeze({ visibility: 'public' }),
});

const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 0,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: [],
});

function makePlan(
  overrides: Readonly<Partial<PostgresMcpStoredPlan>> = Object.freeze({}),
): PostgresMcpStoredPlan {
  return Object.freeze({
    planId: 'plan-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    risk: 'high',
    requiresApproval: true,
    approvalMethod: 'out_of_band',
    approvalUri: 'https://approve.example/plan-1',
    summary: 'Review public visibility',
    impact: IMPACT,
    requiredScopes: Object.freeze(['access:write'] as readonly ScopeName[]),
    baseRevisions: Object.freeze({ collection: 'rev-1' }),
    operations: Object.freeze([OPERATION]),
    operationsDigest: 'sha-256:test-digest',
    binding: BINDING,
    untrustedNote: 'untrusted note',
    createdAt: '2029-12-31T23:59:00.000Z',
    status: 'pending',
    ...overrides,
  });
}

test('MCP-W02 row builder emits token-free binding facts and a stable 64-hex binding digest', () => {
  const row = buildPostgresMcpChangePlanRow(makePlan());
  assert.equal(row.binding_kind, 'authenticated');
  assert.equal(row.binding_digest, createMcpBindingDigest(BINDING));
  assert.match(row.binding_digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(row.binding_json, BINDING);
  assert.equal(row.status, 'pending');
  assert.equal(row.operations_digest, 'sha-256:test-digest');
});

test('MCP-W02 binding digest changes when credential binding or security epoch changes', () => {
  const base = createMcpBindingDigest(BINDING);
  const changedCredential = createMcpBindingDigest(Object.freeze({
    ...BINDING,
    credentialBindingId: 'credential-2',
  }));
  const changedEpoch = createMcpBindingDigest(Object.freeze({
    ...BINDING,
    securityEpoch: 'epoch-2',
  }));
  assert.notEqual(changedCredential, base);
  assert.notEqual(changedEpoch, base);
  assert.equal(createMcpBindingDigest(BINDING), base);
});

test('MCP-W02 rejects legacy Session fields in top-level and nested Plan input', () => {
  for (const key of [
    'session',
    'sessionId',
    'session_id',
    'Mcp-Session-Id',
    'mcpSessionId',
    'mcp_session_id',
  ]) {
    const candidate = Object.freeze({
      ...(makePlan() as unknown as Record<string, unknown>),
      [key]: 'legacy',
    });
    assert.throws(
      () => assertNoLegacyMcpSessionFields(candidate),
      (error: unknown) => error instanceof PostgresMcpChangePlanStoreError
        && error.code === 'legacy_session_field_rejected',
    );
  }

  const nested = Object.freeze({
    ...makePlan(),
    binding: Object.freeze({
      ...BINDING,
      sessionId: 'legacy',
    } as unknown as McpAuthenticatedAuthorizationBinding),
  });
  assert.throws(
    () => assertNoLegacyMcpSessionFields(nested),
    (error: unknown) => error instanceof PostgresMcpChangePlanStoreError
      && error.code === 'legacy_session_field_rejected',
  );
});

test('MCP-W02 migration is after the current head and defines session-free durable authority', async () => {
  const migrationUrl = new URL(
    '../../../migrations/202608051000_mcp_write_change_plans.ts',
    import.meta.url,
  );
  const migrations = await readdir(new URL('../../../migrations', import.meta.url));
  const migrationName = '202608051000_mcp_write_change_plans.ts';
  const previousMigrationName = '202608020800_notification_email_suppressions.ts';
  assert.ok(
    migrations.indexOf(migrationName) > migrations.indexOf(previousMigrationName),
    'MCP-W02 migration must sort after the previous stable migration',
  );
  const source = await readFile(migrationUrl, 'utf8');
  assert.ok(source.indexOf('202608020800_notification_email_suppressions') < 0);
  assert.match(source, /CREATE TABLE mcp_change_plans/u);
  assert.match(source, /CREATE TABLE mcp_approvals/u);
  assert.match(source, /CREATE TABLE mcp_commit_receipts/u);

  const planTable = source.slice(
    source.indexOf('CREATE TABLE mcp_change_plans'),
    source.indexOf('CREATE TABLE mcp_approvals'),
  );
  assert.doesNotMatch(planTable, /session_id|sessionId|Mcp-Session-Id|mcpSessionId/u);
  assert.match(planTable, /mcp_change_plans_binding_no_session_check/u);
  assert.match(planTable, /mcp_change_plans_approval_binding_check/u);
  assert.match(planTable, /mcp_change_plans_time_check/u);

  for (const fragment of [
    'mcp_change_plans_binding_immutable',
    'mcp_change_plans_transition_guard',
    'mcp_approvals_binding_immutable',
    'mcp_approvals_consume_guard',
    'mcp_commit_receipts_identity_immutable',
    'mcp_commit_receipts_result_immutable',
    'mcp_commit_receipts_retention_idx',
    'mcp_change_plans_retention_idx',
    'current_timestamp + interval \'30 days\'',
  ]) {
    const escaped = fragment
      .split(' ')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('\\s+');
    assert.match(source, new RegExp(escaped, 'u'));
  }
});

test('the follow-up migration enforces the session-free guard recursively', async () => {
  const source = await readFile(new URL(
    '../../../migrations/202608061000_mcp_recursive_session_guard.ts',
    import.meta.url,
  ), 'utf8');
  assert.match(source, /WITH RECURSIVE json_tree/u);
  assert.match(source, /jsonb_each/u);
  assert.match(source, /jsonb_array_elements/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION mcp_json_has_legacy_session_key/u);
});

test('the MCP-W02 transition guard treats cancelled as schema-terminal (FIX-L-052)', async () => {
  const source = await readFile(new URL(
    '../../../migrations/202608051000_mcp_write_change_plans.ts',
    import.meta.url,
  ), 'utf8');
  const guard = source.slice(source.indexOf('guard_mcp_change_plan_transition'));
  assert.match(guard, /OLD\.status = 'pending' AND NEW\.status IN \('approved', 'cancelled', 'expired'\)/u);
  assert.match(guard, /OLD\.status = 'approved' AND NEW\.status IN \('committing', 'cancelled', 'expired'\)/u);
  // cancelled has no legal outgoing transition: beginCommit must reject it
  // with the dedicated plan_cancelled reason instead of attempting the
  // illegal cancelled -> committing claim (which would raise 23514).
  assert.doesNotMatch(guard, /OLD\.status = 'cancelled'/u);
});

test('MCP Plan list SQL filters by principal only and caps the page in the database', async () => {
  const source = await readFile(
    new URL('../../../src/infrastructure/database/mcp-change-plan-store.ts', import.meta.url),
    'utf8',
  );
  const list = source.slice(
    source.indexOf('async function listPlansByPrincipalIds'),
    source.indexOf('async function lockPlan'),
  );
  assert.match(list, /WHERE principal_id IN/);
  assert.doesNotMatch(list, /security_epoch|securityEpoch/);
  assert.match(list, /ORDER BY created_at DESC, plan_id/);
  assert.match(list, /LIMIT \$\{filter\.limit\}/);
  assert.match(source, /MCP_PLAN_LIST_MAX_LIMIT = 100/);
});

test('MCP-W02 focused package scripts are exact', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../../../package.json', import.meta.url),
    'utf8',
  )) as { readonly scripts: Readonly<Record<string, string>> };
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-store:unit:inner'],
    'vitest run --fileParallelism=false --project unit tests/unit/mcp/mcp-change-plan-store.test.ts',
  );
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-store:unit'],
    'npm run test:mcp:change-plan-store:unit:inner',
  );
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-store:postgres:inner'],
    'vitest run --fileParallelism=false --project postgres tests/integration/postgres/postgres-mcp-change-plan-store.integration.test.ts',
  );
  assert.equal(
    packageJson.scripts['test:mcp:change-plan-store:postgres'],
    'node scripts/with-postgres.mjs -- npm run test:mcp:change-plan-store:postgres:inner',
  );
});
