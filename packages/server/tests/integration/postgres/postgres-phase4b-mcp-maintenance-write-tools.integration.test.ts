import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  runMigrations,
  type DatabaseRuntime,
} from '../../../src/infrastructure/database/index.js';
import type { Phase4bMcpWriteToolAdapterBundle } from '../../../src/modules/mcp/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';
import {
  createMcpWriteFixture,
  createPostgresPhase4bMcpWriteHarness,
  planContext,
  writeToolContext,
} from '../../support/postgres-phase4b-mcp-write-tools.js';

const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: PRINCIPAL_ID,
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'https://collections.example.test/collections/-/mcp',
  securityEpoch: 'epoch-1',
});
const SCOPES = Object.freeze(['nodes:write', 'access:write', 'changes:commit', 'changes:cancel']);

describeWithPostgres('MCP maintenance Write Tools over PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let bundle: Phase4bMcpWriteToolAdapterBundle;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_maintenance_write', {
      maxConnections: 12,
      applicationName: 'known-mcp-maintenance-write-test',
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
    bundle = createPostgresPhase4bMcpWriteHarness(runtime, BINDING, SCOPES).bundle;
  });

  test('nodes.update and collections.update commit through PostgreSQL UoWs', async () => {
    const fixture = await createMcpWriteFixture(runtime, BINDING, SCOPES);
    const nodeResult = await bundle.adapter.callTool(
      writeToolContext(BINDING, SCOPES, 'nodes.update', fixture.collectionId),
      {
        name: 'nodes.update',
        arguments: {
          collectionId: fixture.collectionId,
          nodeId: fixture.nodeId,
          baseRevision: fixture.resourceRevision,
          patch: { title: 'W06 updated bookmark' },
        },
      },
    );
    assert.equal(nodeResult.resultType, 'complete');
    const nodeOutput = nodeResult.structuredContent as {
      readonly resultType?: string;
      readonly revision?: string;
    };
    assert.equal(nodeOutput.resultType, 'complete');
    const nodeRow = (await runtime.pool.query<{ title: string; resource_revision: string }>(
      `select title, resource_revision from nodes where id = $1`,
      [fixture.nodeId],
    )).rows[0];
    assert.equal(nodeRow?.title, 'W06 updated bookmark');
    assert.equal(nodeRow?.resource_revision, nodeOutput.revision);

    const collectionBefore = (await runtime.pool.query<{ resource_revision: string }>(
      `select resource_revision from collections where id = $1`,
      [fixture.collectionId],
    )).rows[0];
    assert.ok(collectionBefore);
    const collectionResult = await bundle.adapter.callTool(
      writeToolContext(BINDING, SCOPES, 'collections.update', fixture.collectionId),
      {
        name: 'collections.update',
        arguments: {
          collectionId: fixture.collectionId,
          baseRevision: collectionBefore.resource_revision,
          patch: { title: 'W06 updated collection' },
        },
      },
    );
    assert.equal(collectionResult.resultType, 'complete');
    const collectionOutput = collectionResult.structuredContent as {
      readonly resultType?: string;
      readonly revision?: string;
    };
    assert.equal(collectionOutput.resultType, 'complete');
    const collectionRow = (await runtime.pool.query<{ title: string; resource_revision: string }>(
      `select title, resource_revision from collections where id = $1`,
      [fixture.collectionId],
    )).rows[0];
    assert.equal(collectionRow?.title, 'W06 updated collection');
    assert.equal(collectionRow?.resource_revision, collectionOutput.revision);
  });

  test('annotation preview stays read-only and create/update commit through PostgreSQL UoWs', async () => {
    const fixture = await createMcpWriteFixture(runtime, BINDING, SCOPES);
    const context = writeToolContext(
      BINDING,
      SCOPES,
      'annotations.create',
      fixture.collectionId,
    );
    const before = (await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from annotations`,
    )).rows[0]?.count;
    const preview = await bundle.adapter.callTool(context, {
      name: 'annotations.create',
      arguments: {
        collectionId: fixture.collectionId,
        nodeId: fixture.nodeId,
        value: 'W06 preview note',
        dryRun: true,
      },
    });
    assert.equal((preview.structuredContent as { resultType?: string }).resultType, 'preview');
    assert.equal((await runtime.pool.query<{ count: number }>(
      `select count(*)::int count from annotations`,
    )).rows[0]?.count, before);

    const created = await bundle.adapter.callTool(context, {
      name: 'annotations.create',
      arguments: {
        collectionId: fixture.collectionId,
        nodeId: fixture.nodeId,
        value: 'W06 durable note',
        format: 'markdown',
      },
    });
    assert.equal(created.resultType, 'complete');
    const createOutput = created.structuredContent as {
      readonly annotationId?: string;
      readonly revision?: string;
    };
    assert.ok(createOutput.annotationId);
    const createdRow = (await runtime.pool.query<{
      value_json: unknown;
      resource_revision: string;
    }>(`select value_json, resource_revision from annotations where id = $1`, [
      createOutput.annotationId,
    ])).rows[0];
    assert.equal(createdRow?.value_json, 'W06 durable note');
    assert.equal(createdRow?.resource_revision, createOutput.revision);

    const updated = await bundle.adapter.callTool(
      writeToolContext(BINDING, SCOPES, 'annotations.update', fixture.collectionId),
      {
        name: 'annotations.update',
        arguments: {
          collectionId: fixture.collectionId,
          annotationId: createOutput.annotationId,
          baseRevision: createOutput.revision,
          patch: { value: 'W06 updated durable note' },
        },
      },
    );
    assert.equal(updated.resultType, 'complete');
    const updateOutput = updated.structuredContent as { readonly revision?: string };
    const updatedRow = (await runtime.pool.query<{
      value_json: unknown;
      resource_revision: string;
    }>(`select value_json, resource_revision from annotations where id = $1`, [
      createOutput.annotationId,
    ])).rows[0];
    assert.equal(updatedRow?.value_json, 'W06 updated durable note');
    assert.equal(updatedRow?.resource_revision, updateOutput.revision);
  });

  test('changes.get reads the current principal Plan from PostgreSQL', async () => {
    const fixture = await createMcpWriteFixture(runtime, BINDING, SCOPES);
    const planned = await bundle.adapter.callTool(planContext(BINDING, SCOPES), {
      name: 'changes.plan',
      arguments: {
        operations: [{
          type: 'set_visibility',
          collectionId: fixture.collectionId,
          baseRevision: fixture.resourceRevision,
          input: { visibility: 'protected' },
        }],
        reason: 'inspect this PostgreSQL-backed Plan',
        dryRun: true,
      },
    });
    const planId = (planned.plan as { readonly planId?: string }).planId;
    assert.ok(planId);
    const result = await bundle.adapter.callTool(
      writeToolContext(BINDING, SCOPES, 'changes.get'),
      { name: 'changes.get', arguments: { planId } },
    );
    assert.equal(result.resultType, 'complete');
    const projected = result.structuredContent as {
      readonly planId?: string;
      readonly status?: string;
      readonly decision?: string;
    };
    assert.equal(projected.planId, planId);
    assert.equal(projected.status, 'pending');
    assert.equal(projected.decision, 'pending');
  });
});
