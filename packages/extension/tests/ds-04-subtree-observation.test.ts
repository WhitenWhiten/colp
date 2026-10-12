import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { subtreeDeleteSource } from '@know-n/colp/sync';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { mapping, seedMappedNode, setupT03, t03Scope } from './srg-t03-delete-harness.js';

test('DS-04 removal captures exact descendant revisions and does not refresh them at flush', async () => {
  const f = await setupT03();
  await seedMappedNode(f, { nativeId: 'folder', colpId: 'node-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'folder' });
  await seedMappedNode(f, { nativeId: 'child', colpId: 'node-child', parentNativeId: 'folder',
    parentColpId: 'node-1', nodeKind: 'bookmark', url: 'https://child.test/' });
  const queue = createBookmarkEventQueue({ store: f.store, scope: t03Scope, autoFlush: false,
    api: { get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })) } });
  await queue.removed('folder', { parentId: 'native-root', index: 0,
    node: { id: 'folder', title: 'Folder', type: 'folder' } });
  const child = mapping('child', 'node-child', { parentNativeId: 'folder', parentColpId: 'node-1' });
  await f.store.putMapping(t03Scope, { ...child, projection: { ...child.projection, revision: 'new-unobserved' } });
  await queue.flush();
  const row = (await f.store.listQueue(t03Scope))[0]!;
  assert.deepEqual(row.payload.source, subtreeDeleteSource('node-1',
    [{ id: 'node-1', revision: 'revision-old' }, { id: 'node-child', revision: 'revision-old' }]));
});
