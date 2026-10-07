/**
 * MCP-CQ-07: compat write lifecycle over real OAuth, Fastify, Postgres, and
 * the Product approval HTTP route. Does not use InMemoryWriteToolFixture or
 * recordOutOfBandApproval().
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, test } from 'vitest';
import { createProductWriteApprovalClient } from '../../../generated/openapi/product-v1.client.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES } from '../../../src/modules/mcp/index.js';
import {
  assertCompatCallToolEnvelope,
  compatJsonRpc,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  assertAwaitingApproval,
  assertNoMrtrOrElicitation,
  listedTool,
  listedToolNames,
} from '../../support/phase4b-mcp-compat-write-assertions.js';
import {
  CQ07_APPROVAL_BASE_URI,
  CQ07_FROZEN_POLICY_REJECTED,
  CQ07_PRODUCT_ORIGIN,
  assertCompatJsonSuccess,
  assertCsrfFailed,
  assertRejectedCompatCall,
  callCompat,
  createCompatWriteLifecycleHarness,
  createOwnedCompatWriteCollection,
  mintAlignedCompatWriteTokens,
  queryCompatWriteBusinessCounts,
  type CompatWriteCollectionFixture,
  type CompatWriteLifecycleAuth,
} from '../../support/phase4b-mcp-compat-write-lifecycle.js';
import {
  bindListedNodesCreateArguments,
  listedNodesCreateInputSchema,
  minimalNodesCreateArgumentsFromListedSchema,
} from '../../support/phase4b-mcp-node-create-catalog.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession, type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('MCP-CQ-07 compat OAuth/Postgres/approval write lifecycle', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let auth: CompatWriteLifecycleAuth;
  let harness: ReturnType<typeof createCompatWriteLifecycleHarness>;
  let fixture: CompatWriteCollectionFixture;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_cq07', {
      maxConnections: 16,
      applicationName: 'known-mcp-cq07-test',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    owner = await issueTestSession({
      factory,
      subject: `cq07-owner-${randomUUID()}`,
      handle: `cq07o${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    outsider = await issueTestSession({
      factory,
      subject: `cq07-other-${randomUUID()}`,
      handle: `cq07r${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    auth = await mintAlignedCompatWriteTokens({ runtime, owner, outsider });
    harness = createCompatWriteLifecycleHarness({
      runtime,
      databaseUrl: isolated.databaseUrl,
      factory,
      auth,
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.closeApp();
    await isolated?.close();
  });

  afterEach(async () => {
    await harness?.closeApp();
  });

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade`);
    fixture = await createOwnedCompatWriteCollection(runtime, owner);
  });

  test('tools/list publishes write schemas; schema-minimal nodes.create apply writes once as owner', async () => {
    const server = await harness.startApp();
    const listed = await callCompat(server.app, mcpCompatToolsListBody(1), auth.ownerToken);
    assertCompatJsonSuccess(listed, 1);
    const names = listedToolNames(listed);
    assert.deepEqual(names.sort(), [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort());
    for (const name of ['nodes.create', 'changes.plan', 'changes.commit'] as const) {
      const tool = listedTool(listed, name);
      assert.ok(tool, `tools/list must publish ${name}`);
      assert.equal(tool.inputSchema?.type, 'object');
    }

    const schema = listedNodesCreateInputSchema(
      (compatJsonRpc(listed).result?.tools ?? []) as readonly Readonly<Record<string, unknown>>[],
    );
    const applyArgs = bindListedNodesCreateArguments(
      minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'apply'),
      fixture.collectionId,
      fixture.rootId,
    );
    const created = await callCompat(
      server.app,
      mcpCompatToolsCallBody('nodes.create', 2, applyArgs),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(created, 2);
    const result = compatJsonRpc(created).result ?? {};
    assertCompatCallToolEnvelope(result);
    assert.equal(result.isError === true, false);
    assertNoMrtrOrElicitation(created.payload);
    assert.doesNotMatch(created.payload, /"protocolVersion"|"_meta"/u);
    assert.doesNotMatch(JSON.stringify(result), /awaiting_approval/u);
    const nodeId = (result.structuredContent as { node?: { id?: string } } | undefined)?.node?.id;
    assert.equal(typeof nodeId, 'string');
    assert.ok(nodeId);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where id = $1 and deleted_at is null`,
      [nodeId],
    )).rows[0]?.count, 1);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_change_plans`,
    )).rows[0]?.count, 0);

    const replay = await callCompat(
      server.app,
      mcpCompatToolsCallBody('nodes.create', 3, applyArgs),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(replay, 3);
    const replayResult = compatJsonRpc(replay).result ?? {};
    assertCompatCallToolEnvelope(replayResult);
    assert.equal(replayResult.isError === true, false);
    assert.equal(
      (replayResult.structuredContent as { node?: { id?: string } } | undefined)?.node?.id,
      nodeId,
    );
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes
       where collection_id = $1 and deleted_at is null`,
      [fixture.collectionId],
    )).rows[0]?.count, 2);
  });

  test('preview dry-run maps resultType/preview with zero writes; legacy dryRun also previews', async () => {
    const server = await harness.startApp();
    const listed = await callCompat(server.app, mcpCompatToolsListBody(10), auth.ownerToken);
    assertCompatJsonSuccess(listed, 10);
    const schema = listedNodesCreateInputSchema(
      (compatJsonRpc(listed).result?.tools ?? []) as readonly Readonly<Record<string, unknown>>[],
    );
    const before = await queryCompatWriteBusinessCounts(runtime, fixture);
    const previewArgs = bindListedNodesCreateArguments(
      minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'preview'),
      fixture.collectionId,
      fixture.rootId,
    );
    const preview = await callCompat(
      server.app,
      mcpCompatToolsCallBody('nodes.create', 11, previewArgs),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(preview, 11);
    const previewResult = compatJsonRpc(preview).result ?? {};
    assertCompatCallToolEnvelope(previewResult);
    assert.equal(previewResult.isError === true, false);
    assert.equal(
      (previewResult.structuredContent as { resultType?: string } | undefined)?.resultType,
      'preview',
    );
    assert.equal(
      Object.hasOwn(previewResult.structuredContent as object ?? {}, 'receipt'),
      false,
    );
    assert.deepEqual(await queryCompatWriteBusinessCounts(runtime, fixture), before);

    const applyShape = bindListedNodesCreateArguments(
      minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'apply'),
      fixture.collectionId,
      fixture.rootId,
    );
    const { confirmApply: _ignored, ...legacyDryRun } = applyShape;
    const legacy = await callCompat(
      server.app,
      mcpCompatToolsCallBody('nodes.create', 12, { ...legacyDryRun, dryRun: true }),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(legacy, 12);
    const legacyResult = compatJsonRpc(legacy).result ?? {};
    assertCompatCallToolEnvelope(legacyResult);
    assert.equal(legacyResult.isError === true, false);
    assert.equal(
      (legacyResult.structuredContent as { resultType?: string } | undefined)?.resultType,
      'preview',
    );
    assert.deepEqual(await queryCompatWriteBusinessCounts(runtime, fixture), before);
  });

  test('compat plan persists; unapproved commit does not mutate; browser approve then restart commit is once', async () => {
    const server = await harness.startApp();
    const listed = await callCompat(server.app, mcpCompatToolsListBody(20), auth.ownerToken);
    assertCompatJsonSuccess(listed, 20);
    const schema = listedNodesCreateInputSchema(
      (compatJsonRpc(listed).result?.tools ?? []) as readonly Readonly<Record<string, unknown>>[],
    );
    const applyArgs = bindListedNodesCreateArguments(
      minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'apply'),
      fixture.collectionId,
      fixture.rootId,
    );
    const created = await callCompat(
      server.app,
      mcpCompatToolsCallBody('nodes.create', 21, applyArgs),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(created, 21);
    const nodeId = (compatJsonRpc(created).result?.structuredContent as { node?: { id?: string } } | undefined)
      ?.node?.id;
    assert.ok(nodeId);
    const nodeRow = (await runtime.pool.query<{ resource_revision: string; visibility: string }>(
      `select resource_revision, visibility from nodes where id = $1`,
      [nodeId],
    )).rows[0];
    assert.ok(nodeRow);
    const visibilityBefore = nodeRow.visibility;
    const countsBeforePlan = await queryCompatWriteBusinessCounts(runtime, fixture);

    const planned = await callCompat(
      server.app,
      mcpCompatToolsCallBody('changes.plan', 22, {
        operations: [{
          type: 'set_visibility',
          collectionId: fixture.collectionId,
          baseRevision: nodeRow.resource_revision,
          input: { visibility: 'protected' },
        }],
        reason: 'cq07 publish node',
        dryRun: true,
      }),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(planned, 22);
    assertNoMrtrOrElicitation(planned.payload);
    const planFields = assertAwaitingApproval(compatJsonRpc(planned).result);
    assert.equal(planFields.approvalUri, `${CQ07_APPROVAL_BASE_URI}/${planFields.planId}`);
    assert.equal((await runtime.pool.query<{ status: string }>(
      `select status from mcp_change_plans where plan_id = $1`,
      [planFields.planId],
    )).rows[0]?.status, 'pending');

    const waiting = await callCompat(
      server.app,
      mcpCompatToolsCallBody('changes.commit', 23, {
        planId: planFields.planId,
        idempotencyKey: 'cq07-commit-idem',
      }),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(waiting, 23);
    assertAwaitingApproval(compatJsonRpc(waiting).result, planFields.planId);
    assert.equal((await runtime.pool.query<{ visibility: string }>(
      `select visibility from nodes where id = $1`,
      [nodeId],
    )).rows[0]?.visibility, visibilityBefore);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from mcp_commit_receipts where plan_id = $1 and completed_at is not null`,
      [planFields.planId],
    )).rows[0]?.count, 0);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where collection_id = $1 and deleted_at is null`,
      [fixture.collectionId],
    )).rows[0]?.count, countsBeforePlan.nodes);

    const ownerClient = createProductWriteApprovalClient({
      origin: server.listenOrigin,
      sessionCookie: owner.cookie,
      csrfToken: owner.csrfToken,
      originHeader: CQ07_PRODUCT_ORIGIN,
    });
    const item = await ownerClient.approval(planFields.planId);
    assert.equal(item.planId, planFields.planId);
    assert.equal(item.status, 'pending');
    assert.match(item.etag, /^"approval:[^"]+"$/u);

    await assertCsrfFailed(await fetch(
      `${server.listenOrigin}/api/v1/mcp/approvals/${encodeURIComponent(planFields.planId)}/decision`,
      {
        method: 'POST',
        headers: {
          Cookie: owner.cookie,
          'X-CSRF-Token': owner.csrfToken,
          'Known-Command-Id': randomUUID(),
          'If-Match': item.etag,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    ));
    await assertCsrfFailed(await fetch(
      `${server.listenOrigin}/api/v1/mcp/approvals/${encodeURIComponent(planFields.planId)}/decision`,
      {
        method: 'POST',
        headers: {
          Cookie: owner.cookie,
          Origin: CQ07_PRODUCT_ORIGIN,
          'Known-Command-Id': randomUUID(),
          'If-Match': item.etag,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approve' }),
      },
    ));

    const outsiderClient = createProductWriteApprovalClient({
      origin: server.listenOrigin,
      sessionCookie: outsider.cookie,
      csrfToken: outsider.csrfToken,
      originHeader: CQ07_PRODUCT_ORIGIN,
    });
    await assert.rejects(
      () => outsiderClient.decide(planFields.planId, 'approve', item.etag, randomUUID()),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
    assert.equal((await runtime.pool.query<{ status: string }>(
      `select status from mcp_change_plans where plan_id = $1`,
      [planFields.planId],
    )).rows[0]?.status, 'pending');

    const approved = await ownerClient.decide(planFields.planId, 'approve', item.etag, randomUUID());
    assert.equal(approved.decision, 'approved');
    assert.equal(approved.status, 'approved');
    assert.equal((await runtime.pool.query<{ status: string }>(
      `select status from mcp_change_plans where plan_id = $1`,
      [planFields.planId],
    )).rows[0]?.status, 'approved');
    assert.equal((await runtime.pool.query<{ visibility: string }>(
      `select visibility from nodes where id = $1`,
      [nodeId],
    )).rows[0]?.visibility, visibilityBefore);

    await harness.closeApp();
    const restarted = await harness.startApp();
    const committed = await callCompat(
      restarted.app,
      mcpCompatToolsCallBody('changes.commit', 24, {
        planId: planFields.planId,
        idempotencyKey: 'cq07-commit-idem',
      }),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(committed, 24);
    const commitResult = compatJsonRpc(committed).result ?? {};
    assertCompatCallToolEnvelope(commitResult);
    assert.equal(commitResult.isError === true, false);
    assert.equal(
      (commitResult.structuredContent as { planId?: string } | undefined)?.planId,
      planFields.planId,
    );
    assert.equal((await runtime.pool.query<{ visibility: string }>(
      `select visibility from nodes where id = $1`,
      [nodeId],
    )).rows[0]?.visibility, 'protected');

    const replay = await callCompat(
      restarted.app,
      mcpCompatToolsCallBody('changes.commit', 25, {
        planId: planFields.planId,
        idempotencyKey: 'cq07-commit-idem',
      }),
      auth.ownerToken,
    );
    assertCompatJsonSuccess(replay, 25);
    const replayResult = compatJsonRpc(replay).result ?? {};
    assertCompatCallToolEnvelope(replayResult);
    assert.equal(replayResult.isError === true, false);
    assert.equal(
      (replayResult.structuredContent as { planId?: string } | undefined)?.planId,
      planFields.planId,
    );
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes
       where id = $1 and visibility = 'protected' and deleted_at is null`,
      [nodeId],
    )).rows[0]?.count, 1);
    const lifecycle = await runtime.pool.query<{
      plans: number;
      approvals: number;
      consumed_approvals: number;
      receipts: number;
      completed_receipts: number;
      status: string;
    }>(`select
      (select count(*)::int from mcp_change_plans where plan_id = $1) plans,
      (select count(*)::int from mcp_approvals where plan_id = $1) approvals,
      (select count(*)::int from mcp_approvals where plan_id = $1 and consumed_at is not null) consumed_approvals,
      (select count(*)::int from mcp_commit_receipts where plan_id = $1) receipts,
      (select count(*)::int from mcp_commit_receipts where plan_id = $1 and completed_at is not null) completed_receipts,
      (select status from mcp_change_plans where plan_id = $1) status`,
    [planFields.planId]);
    assert.deepEqual(lifecycle.rows[0], {
      plans: 1,
      approvals: 1,
      consumed_approvals: 1,
      receipts: 1,
      completed_receipts: 1,
      status: 'consumed',
    });
  });

  test('outsider token cannot write the owner private collection', async () => {
    const server = await harness.startApp();
    const listed = await callCompat(server.app, mcpCompatToolsListBody(30), auth.ownerToken);
    assertCompatJsonSuccess(listed, 30);
    const schema = listedNodesCreateInputSchema(
      (compatJsonRpc(listed).result?.tools ?? []) as readonly Readonly<Record<string, unknown>>[],
    );
    const applyArgs = bindListedNodesCreateArguments(
      minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'apply'),
      fixture.collectionId,
      fixture.rootId,
    );
    const before = await queryCompatWriteBusinessCounts(runtime, fixture);
    const denied = await callCompat(
      server.app,
      mcpCompatToolsCallBody('nodes.create', 31, applyArgs),
      auth.outsiderToken,
    );
    assertCompatJsonSuccess(denied, 31);
    assertRejectedCompatCall(compatJsonRpc(denied).result, CQ07_FROZEN_POLICY_REJECTED);
    assert.deepEqual(await queryCompatWriteBusinessCounts(runtime, fixture), before);
  });
});
