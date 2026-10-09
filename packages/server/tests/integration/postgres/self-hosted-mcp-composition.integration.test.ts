import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import { createPhase4bMcpWriteComposition, createMcpChangePlanRateLimitPort } from '../../../src/bootstrap/mcp-write-composition.js';
import { createPhase4bMcpAgentApprovalApi } from '../../../src/infrastructure/collections/index.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { createMcpWriteFixture, nodeCreateContext } from '../../support/postgres-phase4b-mcp-write-tools.js';

const OWNER = 'BgYGBgYGBgYGBgYGBgYGBg';
const BINDING: McpAuthenticatedAuthorizationBinding = {
  kind: 'authenticated', principalId: OWNER, clientId: 'production-agent',
  credentialBindingId: 'production-credential',
  resourceAudience: 'https://collections.example.test/collections/-/mcp', securityEpoch: 'epoch-1',
};
const SCOPES = ['nodes:write', 'access:write', 'changes:commit', 'changes:cancel'];

describeWithPostgres('self-hosted production MCP composition', () => {
  let isolated: IsolatedPostgresRuntime;
  let composition: ReturnType<typeof createPhase4bMcpWriteComposition>;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('self_hosted_mcp', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query("insert into accounts(id, subject_id, status) values ($1, $1, 'active')", [OWNER]);
    composition = createPhase4bMcpWriteComposition({
      db: isolated.runtime.db, serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      approvalBaseUri: 'https://collections.example.test/approvals',
      requestStateKey: Buffer.alloc(32, 77).toString('base64'), allowedScopes: SCOPES,
      rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 100, windowMs: 60_000 }),
    });
  }, 120_000);
  afterAll(async () => { await isolated?.close(); });

  async function fixture() {
    await isolated.runtime.pool.query('delete from agent_policies where principal_id = $1 and client_id = $2', [OWNER, BINDING.clientId]);
    const tree = await createMcpWriteFixture(isolated.runtime, BINDING, SCOPES);
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.create', arguments: { collectionId: tree.collectionId, parentId: tree.rootId,
        node: { kind: 'folder', title: 'Destination', visibility: 'private' }, confirmApply: true },
    });
    return { ...tree, folderId: (result.structuredContent as { node: { id: string } }).node.id };
  }

  async function commit(planId: string) {
    return runWithMcpAccountSubjectId(OWNER, () => composition.changePlanService.commit(planId, BINDING, randomUUID()));
  }

  test('the mounted move tool persists a plan, then approval and commit change the parent', async () => {
    const tree = await fixture();
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId, position: 0 },
    });
    const plan = result.structuredContent as { planId: string; requiresApproval: boolean; impact: string[] };
    assert.equal(plan.requiresApproval, true);
    assert.match(plan.impact[0]!, /Destination/);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
    await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
    await commit(plan.planId);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.folderId);
  });

  test('the mounted delete tool plans without parentId, commits tombstones and preserves trash', async () => {
    const tree = await fixture();
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.delete_subtree', arguments: { nodeId: tree.nodeId },
    });
    const plan = result.structuredContent as { planId: string; risk: string };
    assert.equal(plan.risk, 'medium');
    await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
    await commit(plan.planId);
    const row = (await isolated.runtime.pool.query('select deleted_at from nodes where id = $1', [tree.nodeId])).rows[0];
    assert.ok(row.deleted_at);
    assert.equal((await isolated.runtime.pool.query('select count(*)::int AS count from sync_node_tombstones where target_id = $1', [tree.nodeId])).rows[0].count, 1);
  });

  test('trusted move auto-commits with a version receipt and Undo restores the original parent', async () => {
    const tree = await fixture();
    await isolated.runtime.pool.query("insert into agent_policies(principal_id, client_id, policy) values ($1, $2, 'trusted')", [OWNER, BINDING.clientId]);
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const plan = result.structuredContent as { planId: string; status: string; approvedBy: string; requiresApproval: boolean };
    assert.equal(plan.status, 'consumed');
    assert.equal(plan.approvedBy, 'policy');
    assert.equal(plan.requiresApproval, false);
    const api = createPhase4bMcpAgentApprovalApi(isolated.runtime.db);
    await api.undo({ accountId: OWNER, subjectId: OWNER, planId: plan.planId, force: false, commandId: randomUUID() });
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
  });

  test('trusted client without changes:commit keeps approval and does not mutate the tree', async () => {
    const tree = await fixture();
    await isolated.runtime.pool.query("insert into agent_policies(principal_id, client_id, policy) values ($1, $2, 'trusted') on conflict (principal_id,client_id) do update set policy='trusted'", [OWNER, BINDING.clientId]);
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES.filter(scope => scope !== 'changes:commit')), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const plan = result.structuredContent as { status: string; requiresApproval: boolean };
    assert.equal(plan.status, 'pending');
    assert.equal(plan.requiresApproval, true);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id=$1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
  });

  test('another principal cannot plan a move of the owner node', async () => {
    const tree = await fixture();
    const other = { ...BINDING, principalId: 'another-principal' };
    await assert.rejects(() => composition.adapter.callTool(nodeCreateContext(other, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    }));
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
  });
});
