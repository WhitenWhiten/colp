import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { automationDeviceFixture } from '../../support/automation-device-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createPostgresProductSyncCenterUnitOfWork } from '../../../src/infrastructure/sync/index.js';
import { callAutomationAccountTool } from '../../../src/modules/mcp/automation-account-tools.js';

describeWithPostgres('agent Sync center recovery', () => {
  let f: Awaited<ReturnType<typeof automationDeviceFixture>>;
  beforeAll(async () => { f = await automationDeviceFixture('mcp_sync_recovery'); });
  afterAll(async () => { await f?.isolated.close(); });
  test('replica plan and commands preserve ownership, revision fences and durable replay without renewing a lease', async () => {
    const sync = createPostgresProductSyncCenterUnitOfWork(f.db, { cursorSecret: 'mcp-sync-recovery-cursor-secret-at-least-32',
      conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 7), keyVersion: 1 }, retained: [] } });
    const actor = { ...f.owner, clientId: 'manager', credentialBindingId: 'binding', scopes: ['automation:read', 'automation:manage', 'nodes:write'] };
    const replicaId = f.replica.replicaId;
    const replica = await f.db.selectFrom('sync_replicas').select(['lifecycle_revision', 'lease_expires_at']).where('replica_id', '=', replicaId).executeTakeFirstOrThrow();
    await sql`INSERT INTO sync_replica_reports(replica_id,account_id,health_state,health_since,health_revision,health_reported_at,health_actions,issues,issue_total)
      VALUES(${replicaId},${actor.accountId},'degraded',clock_timestamp(),1,clock_timestamp(),ARRAY['retry','rebuild'],
      ${JSON.stringify([{ issueId: 'issue', code: 'record_invalid', direction: 'push', count: 1, actions: ['retry'] }])}::jsonb,1)`.execute(f.db);
    const plan = await callAutomationAccountTool({ sync }, actor, 'automation.sync.replica_plan', { replicaId });
    expect(plan).toMatchObject({ lifecycleRevision: replica.lifecycle_revision.toString(), actions: ['retry', 'rebuild'] });
    const args = { replicaId, baseRevision: replica.lifecycle_revision.toString(), action: 'retry', commandId: randomUUID() };
    await expect(callAutomationAccountTool({ sync }, actor, 'automation.sync.replica_command', { ...args, baseRevision: '999999' }))
      .rejects.toMatchObject({ code: 'precondition_failed' });
    const first = await callAutomationAccountTool({ sync }, actor, 'automation.sync.replica_command', args);
    expect(first).toMatchObject({ state: 'pending', action: 'retry' });
    expect(await callAutomationAccountTool({ sync }, actor, 'automation.sync.replica_command', args)).toEqual(first);
    await callAutomationAccountTool({ sync }, actor, 'automation.sync.retry_issue', { replicaId, issueId: 'issue', commandId: randomUUID() });
    expect((await f.db.selectFrom('sync_replica_commands').select('command_id').where('replica_id', '=', replicaId).execute())).toHaveLength(2);
    const other = await f.issue('foreign-agent-owner');
    await expect(callAutomationAccountTool({ sync }, { ...actor, ...other }, 'automation.sync.replica_command', { ...args, commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'resource_not_found' });
    expect((await f.db.selectFrom('sync_replicas').select('lease_expires_at').where('replica_id', '=', replicaId).executeTakeFirstOrThrow()).lease_expires_at)
      .toEqual(replica.lease_expires_at);
  });
});
