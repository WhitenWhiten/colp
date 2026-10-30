import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { automationManagerFixture } from '../../support/automation-manager-fixture.js';
import { deleteCollectionNode } from '../../../src/modules/collections/index.js';
import type { ProductSyncTrashPage, ProductSyncTrashDetail, ProductSyncTrashRestoreView } from '../../../src/modules/sync/index.js';
import { recordMcpDeleteSubtreeTombstones } from '../../../src/infrastructure/sync/index.js';

describeWithPostgres('MCP owner trash recovery', () => {
  test('lists and restores a reviewed deletion with revision, scope and command replay fences', async () => {
    const f = await automationManagerFixture('mcp_trash', ['nodes:write', 'mcp:read:own'], { sync: true });
    try {
      const before = await f.db.selectFrom('nodes').select('resource_revision').where('id', '=', 'paper').executeTakeFirstOrThrow();
      const deleted = await f.canonical.execute(ports => deleteCollectionNode(ports, { actor: f.actor, command: f.command(),
        collectionId: 'collection', nodeId: 'paper', ifMatch: `"${before.resource_revision}"`, recursive: false }));
      if (deleted.kind !== 'deleted') throw Error('Delete did not commit');
      // MCP commit records Sync trash for its canonical delete through this production recorder.
      await f.db.transaction().execute(tx => recordMcpDeleteSubtreeTombstones(tx, { collectionId: 'collection', rootTargetId: 'paper',
        operationId: deleted.operationId, commitOrdinal: deleted.commitOrdinal }));
      const page = await f.value<ProductSyncTrashPage>('automation.trash.list', { collectionId: 'collection', limit: 1 });
      expect(page.items).toMatchObject([{ nodeId: 'paper', kind: 'bookmark' }]);
      const detail = await f.value<ProductSyncTrashDetail>('automation.trash.get', { deletionId: page.items[0]!.deletionId });
      expect(detail).toMatchObject({ nodeId: 'paper', url: 'https://arxiv.org/abs/fixture', collectionId: 'collection' });
      const args = { commandId: randomUUID(), deletionId: detail.deletionId, baseRevision: detail.revision };
      expect(await f.call('automation.trash.restore', { ...args, commandId: randomUUID(), baseRevision: 'stale' }))
        .toMatchObject({ kind: 'rejected', stableCode: 'precondition_failed' });
      expect(await f.api.callTool({ ...f.context, scopes: ['automation:manage', 'mcp:read:own'] }, 'automation.trash.restore', args))
        .toMatchObject({ kind: 'rejected', stableCode: 'unknown_tool' });
      const restored = await f.value<ProductSyncTrashRestoreView>('automation.trash.restore', args);
      expect(restored).toMatchObject({ nodeId: 'paper', parentId: 'root' });
      expect(await f.value('automation.trash.restore', args)).toEqual(restored);
      expect(await f.call('automation.trash.restore', { ...args, baseRevision: 'changed' }))
        .toMatchObject({ kind: 'rejected', stableCode: 'automation_command_conflict' });
      expect((await f.db.selectFrom('nodes').select('deleted_at').where('id', '=', 'paper').executeTakeFirstOrThrow()).deleted_at).toBeNull();
      expect((await f.value<ProductSyncTrashPage>('automation.trash.list', { collectionId: 'collection' })).items).toEqual([]);
      expect(await f.call('automation.trash.list', { collectionId: 'unowned' })).toMatchObject({ kind: 'rejected', stableCode: 'resource_not_found' });
    } finally { await f.isolated.close(); }
  });

  test('restores a folder and its original deleted children without recreating identities', async () => {
    const f = await automationManagerFixture('mcp_trash_subtree', ['nodes:write', 'mcp:read:own'], { sync: true });
    try {
      await f.createNode('branch', 'root', 'Branch');
      await f.createNode('child', 'branch', 'Child', 'https://example.test/child');
      const node = await f.db.selectFrom('nodes').select('resource_revision').where('id', '=', 'branch').executeTakeFirstOrThrow();
      const collection = await f.db.selectFrom('collections').select('content_revision').where('id', '=', 'collection').executeTakeFirstOrThrow();
      const deleted = await f.canonical.execute(ports => deleteCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
        nodeId: 'branch', ifMatch: `"${node.resource_revision}"`, recursive: true, ifContentMatch: `"${collection.content_revision}"` }));
      if (deleted.kind !== 'deleted') throw Error('Delete did not commit');
      await f.db.transaction().execute(tx => recordMcpDeleteSubtreeTombstones(tx, { collectionId: 'collection', rootTargetId: 'branch',
        operationId: deleted.operationId, commitOrdinal: deleted.commitOrdinal }));
      const page = await f.value<ProductSyncTrashPage>('automation.trash.list', { collectionId: 'collection' });
      const root = page.items.find(item => item.nodeId === 'branch')!;
      const args = { commandId: randomUUID(), deletionId: root.deletionId, baseRevision: root.revision };
      const result = await f.value<{ summary: { applied: number } }>('automation.trash.restore_subtree', args);
      expect(result.summary.applied).toBe(2);
      expect(await f.value('automation.trash.restore_subtree', args)).toEqual(result);
      expect(await f.db.selectFrom('nodes').select(['id', 'parent_id', 'deleted_at']).where('id', 'in', ['branch', 'child']).orderBy('id').execute())
        .toEqual([{ id: 'branch', parent_id: 'root', deleted_at: null }, { id: 'child', parent_id: 'branch', deleted_at: null }]);
    } finally { await f.isolated.close(); }
  });
});
