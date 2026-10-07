import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  runMigrations,
  type DatabaseRuntime,
  type DatabaseTransaction,
} from '../../../src/infrastructure/database/index.js';
import {
  allocateMcpPublicationSlug,
  PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME,
  PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS,
  type Phase4bMcpWriteToolAdapterBundle,
} from '../../../src/modules/mcp/index.js';
import type { ProductCollectionCanonicalPorts } from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';
import {
  commitContext,
  createMcpWriteFixture,
  createPostgresPhase4bMcpWriteHarness,
  nodeCreateContext,
  planContext,
  type FixtureFacts,
} from '../../support/postgres-phase4b-mcp-write-tools.js';

const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: PRINCIPAL_ID,
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});
const SCOPES = Object.freeze(['nodes:write', 'access:write', 'changes:commit', 'changes:cancel']);

describeWithPostgres('MCP-W06 Modern Write Tools over PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let store: ReturnType<typeof createPostgresPhase4bMcpWriteHarness>['store'];
  let bundle: Phase4bMcpWriteToolAdapterBundle;
  let createProductPorts: (transaction: DatabaseTransaction) => ProductCollectionCanonicalPorts;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w06', {
      maxConnections: 16,
      applicationName: 'known-mcp-w06-test',
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
      profiles, accounts, mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade`);
    await runtime.pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $1, 'active', 0)`,
      [PRINCIPAL_ID],
    );
    await runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'MCP W06 owner', null)`,
      [PRINCIPAL_ID],
    );
    const harness = createPostgresPhase4bMcpWriteHarness(runtime, BINDING, SCOPES);
    store = harness.store;
    bundle = harness.bundle;
    createProductPorts = harness.createProductPorts;
  });

  test('W06 direct Tool declarations omit nodes.set_visibility', () => {
    assert.deepEqual(PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS, [
      Object.freeze({
        path: Object.freeze(['collectionId']),
        headerName: 'X-Collection-Id',
        type: 'string',
      }),
    ]);
  });

  test('W06 new Plans use a clock that stays compatible with PostgreSQL expiry guards', async () => {
    const fixture = await createFixture();
    const planned = await bundle.adapter.callTool(planContext(BINDING, SCOPES), {
      name: 'changes.plan',
      arguments: {
        operations: [{
          type: 'set_visibility',
          collectionId: fixture.collectionId,
          baseRevision: fixture.resourceRevision,
          input: { visibility: 'protected' },
        }],
        reason: 'assert DB-compatible Plan expiry',
        dryRun: true,
      },
    });
    assert.equal(planned.resultType, 'input_required');
    const planId = (planned.plan as { planId?: string }).planId;
    assert.ok(planId);
    await assertPlanExpiresAfterDatabaseNow(planId!);
  });

  test('low-risk nodes.create confirmApply commits canonically and replays the same command idempotently', async () => {
    const fixture = await createFixture();
    const first = await bundle.adapter.callTool(
      nodeCreateContext(BINDING, SCOPES),
      {
        name: 'nodes.create',
        arguments: {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          node: {
            kind: 'bookmark',
            title: 'W06 low-risk bookmark',
            url: 'https://example.test/w06',
            description: null,
            tags: ['w06'],
            visibility: 'private',
          },
          reason: 'create low-risk bookmark',
          confirmApply: true,
        },
      },
    );
    assert.equal(first.resultType, 'complete');
    const nodeId = (first.structuredContent as { node?: { id?: string } }).node?.id;
    assert.ok(nodeId);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where id = $1`,
      [nodeId],
    )).rows[0]?.count, 1);

    const second = await bundle.adapter.callTool(
      nodeCreateContext(BINDING, SCOPES),
      {
        name: 'nodes.create',
        arguments: {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          node: {
            kind: 'bookmark',
            title: 'W06 low-risk bookmark',
            url: 'https://example.test/w06',
            description: null,
            tags: ['w06'],
            visibility: 'private',
          },
          reason: 'create low-risk bookmark',
          confirmApply: true,
        },
      },
    );
    assert.equal(second.resultType, 'complete');
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes where id = $1`,
      [nodeId],
    )).rows[0]?.count, 1);
  });

  test('explicit nodes.create confirmApply:false previews without rows or receipts', async () => {
    const fixture = await createFixture();
    const before = await businessCounts(fixture);
    const previewArguments = {
      collectionId: fixture.collectionId,
      parentId: fixture.rootId,
      node: {
        kind: 'bookmark',
        title: 'W06 preview bookmark',
        url: 'https://example.test/w06-preview',
        description: null,
        tags: ['w06-preview'],
        visibility: 'private',
      },
      reason: 'preview low-risk bookmark',
      confirmApply: false,
    };
    const first = await bundle.adapter.callTool(
      nodeCreateContext(BINDING, SCOPES),
      { name: 'nodes.create', arguments: previewArguments },
    );
    assert.equal(first.resultType, 'complete');
    const structured = first.structuredContent as {
      readonly resultType?: string;
      readonly receipt?: unknown;
      readonly node?: { readonly id?: string; readonly title?: string };
    };
    assert.equal(structured.resultType, 'preview');
    assert.equal(Object.hasOwn(structured, 'receipt'), false);
    assert.equal(Object.hasOwn(structured.node ?? {}, 'id'), false);
    assert.equal(structured.node?.title, 'W06 preview bookmark');
    assert.deepEqual(await businessCounts(fixture), before);

    const second = await bundle.adapter.callTool(
      nodeCreateContext(BINDING, SCOPES),
      { name: 'nodes.create', arguments: previewArguments },
    );
    assert.equal((second.structuredContent as { resultType?: string }).resultType, 'preview');
    assert.deepEqual(await businessCounts(fixture), before);
  });

  test('legacy nodes.create dryRun without confirmApply previews and does not write', async () => {
    const fixture = await createFixture();
    const before = await businessCounts(fixture);
    const preview = await bundle.adapter.callTool(
      nodeCreateContext(BINDING, SCOPES),
      {
        name: 'nodes.create',
        arguments: {
          collectionId: fixture.collectionId,
          parentId: fixture.rootId,
          node: {
            kind: 'bookmark',
            title: 'W06 legacy dryRun',
            url: 'https://example.test/w06-legacy',
            description: null,
            tags: ['w06-legacy'],
            visibility: 'private',
          },
          reason: 'legacy dryRun is preview',
          dryRun: true,
        },
      },
    );
    assert.equal(preview.resultType, 'complete');
    assert.equal(
      (preview.structuredContent as { resultType?: string }).resultType,
      'preview',
    );
    assert.deepEqual(await businessCounts(fixture), before);
  });

  test('high-risk Plan/Commit lifecycle uses MRTR requestState and a new request after approval', async () => {
    const fixture = await createFixture();
    const planCtx = planContext(BINDING, SCOPES);
    const planned = await bundle.adapter.callTool(planCtx, {
      name: 'changes.plan',
      arguments: {
        operations: [{
          type: 'set_visibility',
          collectionId: fixture.collectionId,
          baseRevision: fixture.resourceRevision,
          input: { visibility: 'protected' },
        }],
        reason: 'publish this node',
        dryRun: true,
      },
    });
    assert.equal(planned.resultType, 'input_required');
    assert.deepEqual(planned.inputRequests, {});
    assert.equal(typeof planned.requestState, 'string');
    const planId = (planned.plan as { planId?: string }).planId;
    assert.ok(planId);

    const commitCtx = commitContext(BINDING, SCOPES);
    const waiting = await bundle.adapter.callTool(commitCtx, {
      name: 'changes.commit',
      arguments: { planId, idempotencyKey: 'idem-w06' },
    });
    assert.equal(waiting.resultType, 'input_required');
    const commitState = waiting.requestState as string;
    assert.ok(commitState);

    await bundle.adapter.recordOutOfBandApproval(planId!, planCtx);

    const retry = await bundle.adapter.callTool(commitCtx, {
      name: 'changes.commit',
      arguments: { planId, idempotencyKey: 'idem-w06' },
      requestState: commitState,
      inputResponses: { approval: { action: 'accept' } },
    });
    assert.equal(retry.resultType, 'complete');
    assert.equal((retry.structuredContent as { planId?: string }).planId, planId);
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes
       where id = $1 and visibility = 'protected'`,
      [fixture.nodeId],
    )).rows[0]?.count, 1);
    assert.equal((await store.planStore.get(planId!))?.status, 'consumed');
  });

  test('high-risk collection public visibility publishes metadata after approval', async () => {
    const fixture = await createFixture();
    const planCtx = planContext(BINDING, SCOPES);
    await assert.rejects(
      () => bundle.adapter.callTool(planCtx, {
        name: 'changes.plan',
        arguments: {
          operations: [{
            type: 'set_visibility',
            collectionId: fixture.collectionId,
            baseRevision: fixture.resourceRevision,
            input: { visibility: 'public' },
          }],
          reason: 'node fence must not publish the library',
          dryRun: true,
        },
      }),
      (error: unknown) => error instanceof Error
        && error.name === PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME
        && !error.message.includes(fixture.resourceRevision)
        && !error.message.includes(fixture.collectionResourceRevision),
    );

    const planned = await bundle.adapter.callTool(planCtx, {
      name: 'changes.plan',
      arguments: {
        operations: [{
          type: 'set_visibility',
          collectionId: fixture.collectionId,
          baseRevision: fixture.collectionResourceRevision,
          input: { visibility: 'public' },
        }],
        reason: 'publish this library',
        dryRun: true,
      },
    });
    assert.equal(planned.resultType, 'input_required');
    const planId = (planned.plan as { planId?: string }).planId;
    assert.ok(planId);

    const commitCtx = commitContext(BINDING, SCOPES);
    const waiting = await bundle.adapter.callTool(commitCtx, {
      name: 'changes.commit',
      arguments: { planId, idempotencyKey: 'idem-w06-public' },
    });
    assert.equal(waiting.resultType, 'input_required');
    const commitState = waiting.requestState as string;
    assert.ok(commitState);

    await bundle.adapter.recordOutOfBandApproval(planId!, planCtx);

    const retry = await bundle.adapter.callTool(commitCtx, {
      name: 'changes.commit',
      arguments: { planId, idempotencyKey: 'idem-w06-public' },
      requestState: commitState,
      inputResponses: { approval: { action: 'accept' } },
    });
    assert.equal(retry.resultType, 'complete');
    const published = (await runtime.pool.query<{
      visibility: string;
      publication_slug: string | null;
    }>(
      `select visibility, publication_slug from collections where id = $1`,
      [fixture.collectionId],
    )).rows[0];
    assert.equal(published?.visibility, 'public');
    assert.equal(published?.publication_slug, allocateMcpPublicationSlug(fixture.collectionId));
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from nodes
       where id = $1 and visibility = 'private'`,
      [fixture.nodeId],
    )).rows[0]?.count, 1);
  });

  async function createFixture(): Promise<FixtureFacts> {
    return createMcpWriteFixture(runtime, BINDING, SCOPES);
  }

  async function businessCounts(fixture: FixtureFacts): Promise<Readonly<Record<string, number | string>>> {
    const counts = (await runtime.pool.query<{
      nodes: number;
      operations: number;
      audits: number;
      outbox: number;
      receipts: number;
      resourceRevisions: number;
      contentRevisions: number;
      childrenRevisions: number;
    }>(`select
      (select count(*)::int from nodes) nodes,
      (select count(*)::int from operations) operations,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from resource_revisions) as "resourceRevisions",
      (select count(*)::int from content_revisions) as "contentRevisions",
      (select count(*)::int from children_revisions) as "childrenRevisions"`)).rows[0]!;
    const collection = (await runtime.pool.query<{
      content_revision: string;
      policy_revision: string;
    }>(
      `select content_revision, policy_revision from collections where id = $1`,
      [fixture.collectionId],
    )).rows[0]!;
    const root = (await runtime.pool.query<{ children_revision: string }>(
      `select children_revision from nodes where id = $1`,
      [fixture.rootId],
    )).rows[0]!;
    return Object.freeze({
      ...counts,
      contentRevision: collection.content_revision,
      policyRevision: collection.policy_revision,
      childrenRevision: root.children_revision,
    });
  }

  async function assertPlanExpiresAfterDatabaseNow(planId: string): Promise<void> {
    const row = (await runtime.pool.query<{ expires_at: number; db_now: number }>(
      `select extract(epoch from expires_at)::float8 as expires_at,
              extract(epoch from current_timestamp)::float8 as db_now
       from mcp_change_plans
       where plan_id = $1`,
      [planId],
    )).rows[0];
    assert.ok(row, `Expected Plan ${planId} to exist in PostgreSQL.`);
    assert.ok(
      row.expires_at > row.db_now,
      'Plan expires_at must remain after PostgreSQL current_timestamp for the lifecycle to commit.',
    );
  }
});
