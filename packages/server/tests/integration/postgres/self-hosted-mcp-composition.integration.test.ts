import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from 'vitest';
import { Mcp20260728RequestError, McpChangePlanError } from '@know-n/colp/mcp';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import { createPhase4bMcpWriteComposition, createMcpChangePlanRateLimitPort } from '../../../src/bootstrap/mcp-write-composition.js';
import { createPhase4bMcpAgentApprovalApi } from '../../../src/infrastructure/collections/index.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import { policyCommitIdempotencyKey } from '../../../src/modules/mcp/agent-plan-policy.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { createMcpWriteFixture, nodeCreateContext } from '../../support/postgres-phase4b-mcp-write-tools.js';

const OWNER = 'BgYGBgYGBgYGBgYGBgYGBg';
const BINDING: McpAuthenticatedAuthorizationBinding = {
  kind: 'authenticated', principalId: OWNER, clientId: 'production-agent',
  credentialBindingId: 'production-credential',
  resourceAudience: 'https://collections.example.test/collections/-/mcp', securityEpoch: 'epoch-1',
};
const SCOPES = ['nodes:write', 'nodes:delete', 'access:write', 'changes:commit', 'changes:cancel'];

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

  async function commit(planId: string, idempotencyKey = randomUUID()) {
    return runWithMcpAccountSubjectId(OWNER, () => composition.changePlanService.commit(planId, BINDING, idempotencyKey));
  }

  async function planHistory(collectionId: string, planId: string) {
    const versions = await isolated.runtime.pool.query(
      'select version_id from collection_tree_versions where collection_id = $1 and cause = $2',
      [collectionId, `agent-plan:${planId}`],
    );
    const receipts = await isolated.runtime.pool.query(
      'select approved_by, version_id from mcp_plan_policy_receipts where plan_id = $1', [planId],
    );
    return { versionIds: versions.rows.map((row) => row.version_id as string), receipts: receipts.rows };
  }

  async function capacityFixture(nodeCount: number) {
    const tree = await fixture();
    const prefix = randomUUID().replaceAll('-', '');
    // The fixture already has a bookmark and its destination folder. Seed
    // the remaining live bookmarks directly into this isolated database.
    await isolated.runtime.pool.query(`
      INSERT INTO resource_id_ledger (resource_id, resource_type, committed_at)
      SELECT $1 || '-' || i, 'node', now() FROM generate_series(1, $2::int) AS i
    `, [prefix, nodeCount - 2]);
    await isolated.runtime.pool.query(`
      INSERT INTO nodes (
        id, collection_id, parent_id, kind, title, url, description, tags, position_token, resource_revision, children_revision,
        visibility, created_at, updated_at, payload_json, payload_schema_version, payload_authority_status
      )
      SELECT $1 || '-' || i, $2, $3, 'bookmark', 'Seed ' || i, template.url, template.description, template.tags,
        'zz' || lpad(i::text, 5, '0'), template.resource_revision, template.children_revision,
        template.visibility, template.created_at, template.updated_at,
        template.payload_json || jsonb_build_object(
          'id', $1 || '-' || i, 'parentId', $3::text, 'title', 'Seed ' || i,
          'position', 'zz' || lpad(i::text, 5, '0')
        ), template.payload_schema_version, template.payload_authority_status
      FROM generate_series(1, $4::int) AS i CROSS JOIN nodes template WHERE template.id = $5
    `, [prefix, tree.collectionId, tree.folderId, nodeCount - 2, tree.nodeId]);
    const count = await isolated.runtime.pool.query(
      'select count(*)::int n from nodes where collection_id = $1 and not is_root and deleted_at is null',
      [tree.collectionId],
    );
    assert.equal(count.rows[0].n, nodeCount);
    return tree;
  }

  test.each(['manual', 'trusted'] as const)('%s move at 2001 nodes saves history and supports Undo', async (policy) => {
    const tree = await capacityFixture(2001);
    if (policy === 'trusted') {
      await isolated.runtime.pool.query(
        "insert into agent_policies(principal_id, client_id, policy) values ($1, $2, 'trusted')",
        [OWNER, BINDING.clientId],
      );
    }
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const plan = result.structuredContent as { planId: string };
    const idempotencyKey = policy === 'manual' ? randomUUID() : policyCommitIdempotencyKey(plan.planId);
    if (policy === 'manual') {
      await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
      await commit(plan.planId, idempotencyKey);
    }
    const committed = await commit(plan.planId, idempotencyKey);
    const history = await planHistory(tree.collectionId, plan.planId);
    assert.equal(history.versionIds.length, 1);
    assert.equal(history.receipts[0]?.approved_by, policy === 'manual' ? 'owner' : 'policy');
    const version = await isolated.runtime.pool.query(
      'select node_count from collection_tree_versions where version_id = $1', [history.versionIds[0]],
    );
    assert.equal(version.rows[0].node_count, 2001);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.folderId);
    await createPhase4bMcpAgentApprovalApi(isolated.runtime.db).undo({
      accountId: OWNER, subjectId: OWNER, planId: plan.planId, force: false, commandId: randomUUID(),
    });
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
    await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.create', arguments: { collectionId: tree.collectionId, parentId: tree.folderId,
        node: { kind: 'bookmark', title: 'After Undo', url: 'https://example.test/after-undo', visibility: 'private' }, confirmApply: true },
    });
    // The collection now has a different revision. Replay must return the durable result without a new snapshot
    // or reapplying the original move.
    assert.deepEqual(await commit(plan.planId, idempotencyKey), committed);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
  });

  test.each(['manual', 'trusted'] as const)('%s move above the snapshot byte capacity rejects without consuming the plan or changing the tree', async (policy) => {
    const tree = await capacityFixture(2001);
    await isolated.runtime.pool.query("update nodes set title = repeat('界', 512), url = 'https://example.test/' || repeat('界', 7000) where collection_id = $1 and kind = 'bookmark'", [tree.collectionId]);
    if (policy === 'trusted') {
      await isolated.runtime.pool.query(
        "insert into agent_policies(principal_id, client_id, policy) values ($1, $2, 'trusted')",
        [OWNER, BINDING.clientId],
      );
    }
    const before = await isolated.runtime.pool.query('select content_revision from collections where id = $1', [tree.collectionId]);
    const move = () => composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const capacityRejection = (error: unknown) => {
      assert.ok(error instanceof Mcp20260728RequestError);
      assert.equal(error.kind, 'invalid_params');
      assert.deepEqual(error.data, { code: 'impact_exceeded' });
      assert.match(error.message, /32 MiB of serialized tree data/u);
      assert.match(error.message, /Nothing was changed/u);
      return true;
    };
    if (policy === 'manual') {
      const result = await move();
      const planId = (result.structuredContent as { planId: string }).planId;
      await composition.changePlanService.recordOutOfBandApproval(planId, BINDING);
      const idempotencyKey = randomUUID();
      // A failed commit rolls back the approval claim, so retrying the same
      // key must reject on capacity again rather than consuming the plan.
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(() => composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
          name: 'changes.commit', arguments: { planId, idempotencyKey },
        }), capacityRejection);
      }
    } else {
      await assert.rejects(move, capacityRejection);
    }
    const plans = await isolated.runtime.pool.query(
      "select plan_id, status from mcp_change_plans where operations_json->0->>'collectionId' = $1",
      [tree.collectionId],
    );
    assert.equal(plans.rows.length, 1);
    const plan = plans.rows[0];
    assert.equal(plan.status, policy === 'manual' ? 'approved' : 'pending');
    assert.deepEqual(await planHistory(tree.collectionId, plan.plan_id), { versionIds: [], receipts: [] });
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
    const after = await isolated.runtime.pool.query('select content_revision from collections where id = $1', [tree.collectionId]);
    assert.deepEqual(after.rows, before.rows);
    await runWithMcpAccountSubjectId(OWNER, () => composition.changePlanService.cancel(plan.plan_id, BINDING));
    assert.equal((await composition.store.planStore.get(plan.plan_id))?.status, 'cancelled');
  });

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

  test('an owner-approved move saves its version in the commit and Undo restores it', async () => {
    const tree = await fixture();
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const plan = result.structuredContent as { planId: string };
    await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
    await commit(plan.planId);
    const history = await planHistory(tree.collectionId, plan.planId);
    assert.equal(history.versionIds.length, 1);
    assert.deepEqual(history.receipts, [{ approved_by: 'owner', version_id: history.versionIds[0] }]);
    const api = createPhase4bMcpAgentApprovalApi(isolated.runtime.db);
    const view = await api.get({ id: OWNER }, plan.planId) as { approvedBy: string | null; versionId: string | null };
    assert.equal(view.approvedBy, 'owner');
    assert.equal(view.versionId, history.versionIds[0]);
    await api.undo({ accountId: OWNER, subjectId: OWNER, planId: plan.planId, force: false, commandId: randomUUID() });
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
  });

  test('a stale approved plan rolls back its history capture with the failed commit', async () => {
    const tree = await fixture();
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const planId = (result.structuredContent as { planId: string }).planId;
    await composition.changePlanService.recordOutOfBandApproval(planId, BINDING);
    await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.create', arguments: { collectionId: tree.collectionId, parentId: tree.rootId,
        node: { kind: 'folder', title: 'Later edit', visibility: 'private' }, confirmApply: true },
    });
    await assert.rejects(() => commit(planId), (error: unknown) => {
      assert.ok(error instanceof McpChangePlanError);
      assert.equal(error.code, 'revision_drift');
      return true;
    });
    assert.deepEqual(await planHistory(tree.collectionId, planId), { versionIds: [], receipts: [] });
    assert.equal((await composition.store.planStore.get(planId))?.status, 'approved');
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
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
    // History keeps the tree from before the delete; Undo is only for reversible plans.
    const history = await planHistory(tree.collectionId, plan.planId);
    assert.equal(history.versionIds.length, 1);
    assert.deepEqual(history.receipts, []);
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
    const history = await planHistory(tree.collectionId, plan.planId);
    assert.equal(history.versionIds.length, 1);
    assert.deepEqual(history.receipts, [{ approved_by: 'policy', version_id: history.versionIds[0] }]);
    const api = createPhase4bMcpAgentApprovalApi(isolated.runtime.db);
    await api.undo({ accountId: OWNER, subjectId: OWNER, planId: plan.planId, force: false, commandId: randomUUID() });
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id = $1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
  });

  test('one move plan carries several bookmarks; approval commits them all in order', async () => {
    const tree = await fixture();
    const extra: string[] = [];
    for (const title of ['Second', 'Third']) {
      const made = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
        name: 'nodes.create', arguments: { collectionId: tree.collectionId, parentId: tree.rootId,
          node: { kind: 'bookmark', title, url: `https://example.test/${title}`, visibility: 'private' }, confirmApply: true },
      });
      extra.push((made.structuredContent as { node: { id: string } }).node.id);
    }
    const nodeIds = [tree.nodeId, ...extra];
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeIds, parentId: tree.folderId },
    });
    const plan = result.structuredContent as { planId: string; impact: string[]; requiresApproval: boolean };
    assert.equal(plan.requiresApproval, true);
    assert.equal(plan.impact.length, 3);
    assert.match(plan.impact[2]!, /^move Third from .* to .*Destination/u);
    await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
    await commit(plan.planId);
    const moved = await isolated.runtime.pool.query(
      'select id from nodes where parent_id = $1 and deleted_at is null order by position_token', [tree.folderId]);
    assert.deepEqual(moved.rows.map((row) => row.id), nodeIds);
    assert.equal((await planHistory(tree.collectionId, plan.planId)).receipts[0]?.approved_by, 'owner');
  });

  test('nodes.move refuses nodeId together with nodeIds, and a position for several nodes', async () => {
    const tree = await fixture();
    await assert.rejects(() => composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, nodeIds: [tree.nodeId], parentId: tree.folderId },
    }));
    await assert.rejects(() => composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeIds: [tree.nodeId, tree.folderId], parentId: tree.rootId, position: 0 },
    }));
  });

  test('changes.get agrees with the move result for a policy-approved plan', async () => {
    const tree = await fixture();
    await isolated.runtime.pool.query("insert into agent_policies(principal_id, client_id, policy) values ($1, $2, 'trusted')", [OWNER, BINDING.clientId]);
    const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeId: tree.nodeId, parentId: tree.folderId },
    });
    const plan = result.structuredContent as { planId: string; requiresApproval: boolean };
    assert.equal(plan.requiresApproval, false);
    const got = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'changes.get', arguments: { planId: plan.planId },
    });
    const view = got.structuredContent as { requiresApproval: boolean; approvedBy?: string; status: string };
    assert.equal(view.status, 'consumed');
    assert.equal(view.requiresApproval, false);
    assert.equal(view.approvedBy, 'policy');
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
  async function organize(tree: Awaited<ReturnType<typeof fixture>>) {
    return composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), { name: 'changes.plan', arguments: {
      collectionId: tree.collectionId, dryRun: true, reason: 'Create a folder, file the bookmark and remove the empty old folder', operations: [
        { type: 'create_node', ref: 'organized', parentId: tree.rootId, node: { kind: 'folder', title: 'Organized', visibility: 'private' } },
        { type: 'move_node', nodeId: tree.nodeId, parentRef: 'organized' },
        { type: 'delete_subtree', nodeId: tree.folderId },
      ],
    } });
  }
  test('one mixed plan creates a folder, moves into it and deletes another subtree atomically', async () => {
    const tree = await fixture();
    const planned = await organize(tree), plan = planned.structuredContent as { planId: string; requiresApproval: boolean };
    assert.equal(plan.requiresApproval, true);
    assert.equal((await isolated.runtime.pool.query("select count(*)::int as n from nodes where collection_id=$1 and title='Organized'", [tree.collectionId])).rows[0].n, 0);
    await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
    const key = randomUUID(), first = await commit(plan.planId, key);
    assert.equal(first.operations.length, 3);
    assert.deepEqual(await commit(plan.planId, key), first);
    const folder = (await isolated.runtime.pool.query("select id from nodes where collection_id=$1 and title='Organized' and deleted_at is null", [tree.collectionId])).rows;
    assert.equal(folder.length, 1);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id=$1', [tree.nodeId])).rows[0].parent_id, folder[0].id);
    assert.ok((await isolated.runtime.pool.query('select deleted_at from nodes where id=$1', [tree.folderId])).rows[0].deleted_at);
    assert.equal((await isolated.runtime.pool.query('select count(*)::int as n from sync_node_tombstones where target_id=$1', [tree.folderId])).rows[0].n, 1);
    assert.equal((await planHistory(tree.collectionId, plan.planId)).versionIds.length, 1);
  });
  test('a stale mixed plan makes none of its changes', async () => {
    const tree = await fixture(), planned = await organize(tree);
    const plan = planned.structuredContent as { planId: string };
    await composition.changePlanService.recordOutOfBandApproval(plan.planId, BINDING);
    await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), { name: 'nodes.create', arguments: {
      collectionId: tree.collectionId, parentId: tree.rootId, node: { kind: 'folder', title: 'Owner edit', visibility: 'private' }, confirmApply: true,
    } });
    await assert.rejects(() => commit(plan.planId), (error: unknown) => error instanceof McpChangePlanError && error.code === 'revision_drift');
    assert.equal((await isolated.runtime.pool.query("select count(*)::int as n from nodes where collection_id=$1 and title='Organized'", [tree.collectionId])).rows[0].n, 0);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id=$1', [tree.nodeId])).rows[0].parent_id, tree.rootId);
    assert.equal((await isolated.runtime.pool.query('select deleted_at from nodes where id=$1', [tree.folderId])).rows[0].deleted_at, null);
  });
  test('an invalid mixed plan leaves neither a partial plan nor a folder', async () => {
    const tree = await fixture();
    const before = (await isolated.runtime.pool.query('select count(*)::int as n from mcp_change_plans')).rows[0].n;
    await assert.rejects(() => composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), { name: 'changes.plan', arguments: {
      collectionId: tree.collectionId, dryRun: true, reason: 'Invalid forward reference', operations: [
        { type: 'create_node', ref: 'created', parentId: tree.rootId, node: { kind: 'folder', title: 'Never created', visibility: 'private' } },
        { type: 'move_node', nodeId: tree.nodeId, parentRef: 'unknown' },
      ],
    } }));
    assert.equal((await isolated.runtime.pool.query('select count(*)::int as n from mcp_change_plans')).rows[0].n, before);
  });

  test('a later invalid move rolls back every earlier mixed-plan effect', async () => {
    const tree = await fixture();
    const made = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), { name: 'nodes.create', arguments: {
      collectionId: tree.collectionId, parentId: tree.rootId, node: { kind: 'folder', title: 'Second folder', visibility: 'private' }, confirmApply: true,
    } });
    const second = (made.structuredContent as { node: { id: string } }).node.id;
    const planned = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), { name: 'changes.plan', arguments: {
      collectionId: tree.collectionId, reason: 'An invalid cyclic organization', dryRun: true, operations: [
        { type: 'create_node', parentId: tree.rootId, node: { kind: 'folder', title: 'Rolled back', visibility: 'private' } },
        { type: 'move_node', nodeId: tree.folderId, parentId: second },
        { type: 'move_node', nodeId: second, parentId: tree.folderId },
      ],
    } });
    const planId = (planned.structuredContent as { planId: string }).planId;
    await composition.changePlanService.recordOutOfBandApproval(planId, BINDING);
    await assert.rejects(() => commit(planId));
    const folders = await isolated.runtime.pool.query('select parent_id from nodes where id=ANY($1::text[])', [[second, tree.folderId]]);
    assert.deepEqual(folders.rows.map(row => row.parent_id), [tree.rootId, tree.rootId]);
    assert.equal((await isolated.runtime.pool.query("select count(*)::int as n from nodes where collection_id=$1 and title='Rolled back'", [tree.collectionId])).rows[0].n, 0);
    assert.deepEqual(await planHistory(tree.collectionId, planId), { versionIds: [], receipts: [] });
  });

});
