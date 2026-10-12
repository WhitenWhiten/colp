import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { reopenT03, setupT03, seedMappedNode, t03Scope } from './srg-t03-delete-harness.js';

for (const url of ['file:///only-copy.pdf', 'https://local.test/']) {
  test(`DS-01 late child survives atomic folder removal: ${url}`, async () => {
    const f = await setupT03();
    await seedMappedNode(f, { nativeId: 'folder', colpId: 'node-1', parentNativeId: 'native-root',
      parentColpId: 'root-colp', nodeKind: 'folder' });
    const remove = f.api.remove.bind(f.api);
    f.api.removeTree = async () => { throw new Error('recursive removal forbidden'); };
    f.api.remove = async id => {
      if (id === 'folder') f.api.seed({ id: 'local-only', parentId: id, title: 'Only copy', url });
      await remove(id);
    };
    await f.applier.stage(f.page([f.subtreeEvent(['node-1'])]));
    await f.applier.resume();
    assert.equal(f.api.getNode('local-only')?.url, url);
    assert.ok(await f.store.getLocalSyncExclusion(t03Scope, 'local-only'));
    const resumed = await reopenT03(f);
    await resumed.applier.resume();
    assert.equal(f.api.getNode('local-only')?.url, url);
    assert.equal((await resumed.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');
  });
}

test('DS-01 permission refusal is not promoted to retained success', async () => {
  const f = await setupT03();
  await seedMappedNode(f, { nativeId: 'folder', colpId: 'node-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'folder' });
  f.api.remove = async () => { throw new Error('Permission denied'); };
  await f.applier.stage(f.page([f.subtreeEvent(['node-1'])]));
  await assert.rejects(f.applier.resume(), /Permission denied/);
  assert.ok(f.api.getNode('folder'));
  assert.notEqual((await f.store.exportScope(t03Scope)).cursor?.cursor, 'cursor-next');
});
