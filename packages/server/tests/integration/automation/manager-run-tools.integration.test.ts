import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Run, RunOncePreview } from '@know-n/colp/automation';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationManagerFixture } from '../../support/automation-manager-fixture.js';

describeWithPostgres('MCP run-once and compensation', () => {
  test('previews, starts and compensates an exact effect with durable command replay', async () => {
    const f = await automationManagerFixture('mcp_manual_run', ['nodes:write', 'mcp:read:own']);
    try {
      const request = { folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' },
        includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none' };
      const previewArgs = { commandId: randomUUID(), ruleId: f.rule.id, request };
      const preview = await f.value<RunOncePreview>('automation.runs.preview', previewArgs);
      expect(preview).toMatchObject({ canStart: true, sideEffects: false });
      expect(await f.value('automation.runs.preview', previewArgs)).toEqual(preview);
      expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'paper').executeTakeFirstOrThrow()).parent_id).toBe('root');
      const start = { commandId: randomUUID(), ruleId: f.rule.id, request: { previewId: preview.id, previewDigest: preview.previewDigest } };
      const run = await f.value<Run & { childRunIds: string[] }>('automation.runs.start', start);
      expect(await f.value('automation.runs.start', start)).toEqual(run);
      expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'paper').executeTakeFirstOrThrow()).parent_id).toBe('academic');
      const children = await Promise.all(run.childRunIds.map(runId => f.value<Run>('automation.runs.get', { runId })));
      const changed = children.find(child => child.effects.some(effect => effect.undoAvailable))!;
      const effect = changed.effects.find(item => item.undoAvailable)!;
      expect(effect).toBeDefined();
      const undo = { commandId: randomUUID(), runId: changed.id, baseRevision: changed.revision,
        request: { reason: 'Revert the reviewed placement', effectReceiptId: effect.id, expectedEffectDigest: effect.effectDigest } };
      const result = await f.value('automation.runs.undo', undo);
      expect(await f.value('automation.runs.undo', undo)).toEqual(result);
      expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'paper').executeTakeFirstOrThrow()).parent_id).toBe('root');
      expect(await f.call('automation.runs.start', { ...start, request: { ...start.request, previewDigest: 'changed' } }))
        .toMatchObject({ kind: 'rejected', stableCode: 'automation_command_conflict' });
      const limited = { ...f.context, scopes: ['automation:read', 'automation:manage'] };
      expect(await f.api.callTool(limited, 'automation.runs.start', { ...start, commandId: randomUUID() }))
        .toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
    } finally { await f.isolated.close(); }
  });

  test('changed bookmarks invalidate previews and lost collection authority also fences replay', async () => {
    const f = await automationManagerFixture('mcp_manual_stale', ['nodes:write', 'mcp:read:own']);
    try {
      const args = { commandId: randomUUID(), ruleId: f.rule.id, request: {
        folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' },
        includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none' } };
      const preview = await f.value<RunOncePreview>('automation.runs.preview', args);
      await f.rename('paper', 'Edited after preview');
      expect(await f.call('automation.runs.start', { commandId: randomUUID(), ruleId: f.rule.id,
        request: { previewId: preview.id, previewDigest: preview.previewDigest } }))
        .toMatchObject({ kind: 'rejected', stableCode: 'automation_stale_input' });
      await f.db.transaction().execute(async tx => {
        await tx.updateTable('collections').set({ deleted_at: new Date() }).where('id', '=', 'collection').execute();
        await tx.updateTable('nodes').set({ deleted_at: new Date() }).where('collection_id', '=', 'collection').execute();
      });
      expect(await f.call('automation.runs.preview', args)).toMatchObject({ kind: 'rejected', stableCode: 'resource_not_found' });
    } finally { await f.isolated.close(); }
  });
});
