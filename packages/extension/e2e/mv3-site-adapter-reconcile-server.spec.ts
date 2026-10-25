import { test, expect } from '@playwright/test';
import { startRealStack } from './real-stack.js';
test('server reconciliation publishes ordinary Sync effects for move, rename, restore and undo without invalidating replicas', async () => {
  test.setTimeout(120000); const stack = await startRealStack();
  try {
    const fixture = await stack.seedCanonicalFixture(false, true);
    await stack.sourceArchiveProbe!(undefined, stack.extensionBinding);
    const call = async (action: string, input: unknown): Promise<any> => {
      const result = await stack.sourceArchiveProbe!({ version: 1, action, input }); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body;
    };
    const read = async () => (await call('managed.node', { collectionId: stack.collectionId, nodeId: fixture.bookmarkId })).node;
    const command = (id: string, expected: any, action: string, extra = {}) => ({ commandId: id, collectionId: stack.collectionId,
      replicaId: stack.extensionBinding.replicaId, action, expected, slot: null, parentId: expected.parentId, title: expected.title, retire: false, ...extra });
    const undo = (id: string, original: string) => call('managed.reconcile.undo', { commandId: id, original, collectionId: stack.collectionId, replicaId: stack.extensionBinding.replicaId });
    const original = await read(), move = command('move-source-personal', original, 'move', { parentId: fixture.folderId });
    const moved = await call('managed.reconcile', move); expect(moved.after.parentId).toBe(fixture.folderId);
    expect(await call('managed.reconcile', move)).toEqual(moved);
    expect((await undo('undo-source-personal', move.commandId)).after.parentId).toBe(original.parentId);
    const rename = command('rename-source-personal', await read(), 'rename', { title: 'Updated title' });
    expect((await call('managed.reconcile', rename)).after.title).toBe('Updated title');
    expect((await undo('undo-source-title', rename.commandId)).after.title).toBe(original.title);
    const node = await read(), canonical = (await stack.observations()).canonicalNodes as any[];
    const slot = { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: 'reader', sourceCollectionId: 'saved',
      content: { site: 'fixture.posts', identityVersion: 1, itemId: 'post', accountId: null } } };
    await call('managed.save', { commandId: 'adopt-source-test', replicaId: stack.extensionBinding.replicaId, collectionId: stack.collectionId,
      parentId: node.parentId, parentRevision: canonical.find(n => n.id === node.parentId).resource_revision, slot,
      title: node.title, url: node.url, adopt: { nodeId: node.nodeId, revision: node.revision } });
    await stack.resilience!.deleteNode(node.nodeId);
    await call('managed.manual', { collectionId: stack.collectionId, slot, nodeId: node.nodeId, state: 'suppressed', revision: 0 });
    const restore = command('restore-source-test', await read(), 'restore', { slot, associationRevision: 0 });
    expect((await call('managed.reconcile', restore)).after.deleted).toBe(false);
    expect((await undo('undo-source-restore', restore.commandId)).after.deleted).toBe(true);
    expect((await stack.observations()).replicaStatus).toBe('active');
  } finally { await stack.close(); }
});
