import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationManagerFixture } from '../../support/automation-manager-fixture.js';

describeWithPostgres('MCP automation manager configuration', () => {
  let f: Awaited<ReturnType<typeof automationManagerFixture>>;
  beforeAll(async () => { f = await automationManagerFixture('mcp_manager_configuration'); });
  afterAll(async () => { await f?.isolated.close(); });
  test('global pause uses the observed revision and exact command receipts', async () => {
    const before = await f.call('automation.pause.get'); expect(before.kind).toBe('complete');
    if (before.kind !== 'complete') throw Error('Pause read failed');
    const state = before.structuredContent as { paused: boolean; revision: string };
    const args = { commandId: randomUUID(), baseRevision: state.revision, change: { paused: true, reason: 'Pause from manager' } };
    const paused = await f.call('automation.pause.set', args);
    expect(paused).toMatchObject({ kind: 'complete', structuredContent: { paused: true } });
    if (paused.kind !== 'complete') throw Error('Pause mutation failed');
    expect(await f.call('automation.pause.set', args)).toEqual(paused);
    expect(await f.call('automation.pause.set', { ...args, commandId: randomUUID(), change: { paused: false } }))
      .toMatchObject({ kind: 'rejected', stableCode: 'precondition_failed' });
    const revision = (paused.structuredContent as { revision: string }).revision;
    expect(await f.call('automation.pause.set', { commandId: randomUUID(), baseRevision: revision, change: { paused: false } }))
      .toMatchObject({ kind: 'complete', structuredContent: { paused: false } });
    expect(await f.api.callTool({ ...f.context, scopes: ['automation:read'] }, 'automation.pause.set', args))
      .toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
  });
});
