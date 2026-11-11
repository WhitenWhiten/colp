import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, expect, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import { createPhase4bMcpWriteComposition, createMcpChangePlanRateLimitPort } from '../../../src/bootstrap/mcp-write-composition.js';
import { createActivityAgentRoute, createActivityStore, setAgentActivityEnabled } from '../../../src/infrastructure/activity/index.js';
import { setAutomationCaptureEnabled } from '../../../src/infrastructure/automation/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import type { OutboxHandlerContext } from '../../../src/infrastructure/outbox/router.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';
import { createMcpWriteFixture, nodeCreateContext } from '../../support/postgres-phase4b-mcp-write-tools.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';

const OWNER = 'batch-activity-owner';
const BINDING: McpAuthenticatedAuthorizationBinding = { kind: 'authenticated', principalId: OWNER, clientId: 'batch-agent',
  credentialBindingId: 'batch-credential', resourceAudience: 'https://collections.example.test/collections/-/mcp', securityEpoch: 'epoch-1' };
const SCOPES = ['nodes:write', 'changes:commit', 'changes:cancel'];

describeWithPostgres('agent activity from the production MCP bulk move path', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresRuntime>>;
  let composition: ReturnType<typeof createPhase4bMcpWriteComposition>;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('mcp_batch_activity');
    await runMigrations(isolated.runtime.db, 'latest');
    await isolated.runtime.pool.query("INSERT INTO accounts(id,subject_id,status) VALUES($1,$1,'active')", [OWNER]);
    composition = createPhase4bMcpWriteComposition({ db: isolated.runtime.db, serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      approvalBaseUri: 'https://collections.example.test/approvals', requestStateKey: Buffer.alloc(32, 79).toString('base64'),
      allowedScopes: SCOPES, rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 100, windowMs: 60_000 }) });
  }, 120_000);
  afterEach(() => { setAgentActivityEnabled(false); setAutomationCaptureEnabled(false); });
  afterAll(async () => { await isolated?.close(); });

  async function fixture(capture: boolean) {
    const tree = await createMcpWriteFixture(isolated.runtime, BINDING, SCOPES);
    const create = async (node: Record<string, unknown>) => {
      const result = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), { name: 'nodes.create',
        arguments: { collectionId: tree.collectionId, parentId: tree.rootId, node, confirmApply: true } });
      return (result.structuredContent as { node: { id: string } }).node.id;
    };
    const folderId = await create({ kind: 'folder', title: 'Destination', visibility: 'private' });
    const nodeIds = [tree.nodeId, await create({ kind: 'bookmark', title: 'Second', url: 'https://example.test/second', visibility: 'private' })];
    setAutomationCaptureEnabled(capture); setAgentActivityEnabled(true);
    const planned = await composition.adapter.callTool(nodeCreateContext(BINDING, SCOPES), {
      name: 'nodes.move', arguments: { nodeIds, parentId: folderId } });
    const { planId } = planned.structuredContent as { planId: string };
    await composition.changePlanService.recordOutOfBandApproval(planId, BINDING);
    const key = randomUUID();
    return { ...tree, folderId, nodeIds, commit: () => runWithMcpAccountSubjectId(OWNER,
      () => composition.changePlanService.commit(planId, BINDING, key)) };
  }

  test.each([false, true])('every move has attributed durable activity independently of automation capture (%s)', async capture => {
    const f = await fixture(capture), committed = await f.commit();
    expect(committed.operations).toHaveLength(2); expect(await f.commit()).toEqual(committed);
    const rows = await isolated.runtime.db.selectFrom('outbox_events').selectAll()
      .where('handler_name', '=', 'activity_agent').where('aggregate_scope', '=', f.collectionId).execute();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.payload_json.nodeId).sort()).toEqual([...f.nodeIds].sort());
    const route = createActivityAgentRoute(isolated.runtime.db);
    for (const row of rows) {
      expect(row.payload_json).toMatchObject({ action: 'move', agentClientId: BINDING.clientId, credentialBindingId: BINDING.credentialBindingId });
      const operation = await isolated.runtime.db.selectFrom('operations').select('commit_ordinal')
        .where('operation_id', '=', String(row.payload_json.operationId)).executeTakeFirstOrThrow();
      expect(row.commit_ordinal).toBe(operation.commit_ordinal);
      await isolated.runtime.pool.query("UPDATE outbox_events SET state='leased',lease_generation=1,locked_until=clock_timestamp()+interval '60 seconds' WHERE outbox_id=$1", [row.outbox_id]);
      const delivery: OutboxHandlerContext = { signal: new AbortController().signal, idempotencyKey: row.domain_event_id,
        attempt: { outboxId: row.outbox_id, leaseGeneration: '1' }, envelope: { event_id: row.domain_event_id, event_type: row.event_type,
          event_version: row.event_version, aggregate_identity: { aggregate_type: 'collection', aggregate_id: f.collectionId, aggregate_scope: f.collectionId },
          aggregate_revision: null, commit_ordinal: String(row.commit_ordinal), occurred_at: row.occurred_at.toISOString(), payload: row.payload_json } };
      await route.handle(delivery); await route.handle(delivery);
    }
    const activity = await createActivityStore(isolated.runtime.db, 'batch-activity-cursor-key-at-least-32-bytes').list(OWNER, {});
    expect(activity.items.find(item => item.collection?.id === f.collectionId)).toMatchObject({ kind: 'agent_nodes_moved', count: 2 });
    const captureRows = await isolated.runtime.db.selectFrom('outbox_events').select('outbox_id')
      .where('handler_name', '=', 'automation_ingest').where('aggregate_scope', '=', f.collectionId).execute();
    expect(captureRows).toHaveLength(capture ? 2 : 0);
  });

  test('activity enqueue failure rolls back the complete bulk move and the same plan can recover', async () => {
    const f = await fixture(false);
    await isolated.runtime.pool.query(`CREATE FUNCTION reject_batch_activity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.handler_name='activity_agent' THEN RAISE EXCEPTION 'activity storage unavailable'; END IF; RETURN NEW; END $$`);
    await isolated.runtime.pool.query('CREATE TRIGGER reject_batch_activity BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION reject_batch_activity()');
    try {
      await expect(f.commit()).rejects.toThrow();
      const nodes = await isolated.runtime.db.selectFrom('nodes').select('parent_id').where('id', 'in', f.nodeIds).execute();
      expect(nodes.map(node => node.parent_id)).toEqual([f.rootId, f.rootId]);
      expect(await isolated.runtime.db.selectFrom('operations').select('operation_id').where('collection_id', '=', f.collectionId)
        .where('operation_type', '=', 'resource.move').execute()).toHaveLength(0);
      expect(await isolated.runtime.db.selectFrom('outbox_events').select('outbox_id').where('handler_name', '=', 'activity_agent')
        .where('aggregate_scope', '=', f.collectionId).execute()).toHaveLength(0);
    } finally {
      await isolated.runtime.pool.query('DROP TRIGGER reject_batch_activity ON outbox_events');
      await isolated.runtime.pool.query('DROP FUNCTION reject_batch_activity()');
    }
    const committed = await f.commit(); expect(await f.commit()).toEqual(committed);
    expect(await isolated.runtime.db.selectFrom('outbox_events').select('outbox_id').where('handler_name', '=', 'activity_agent')
      .where('aggregate_scope', '=', f.collectionId).execute()).toHaveLength(2);
  });
});
