import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, mapping, bookmark, folder, scope } from './bookmark-event-queue-harness.js';

test('DS-02 a bookmark moving behind the scan does not become a cloud deletion', async () => {
  const f = await fixture(new IDBFactory());
  await mapping(f.store, 'later', 'later-colp', 'root-selected', 'r-later', { title: 'Later' }, 'root-selected');
  await mapping(f.store, 'moving', 'moving-colp', 'root-selected', 'r-moving',
    { title: 'Move me', url: 'https://move.test/' }, 'later');
  f.api.put(folder('later', 'root-selected', 1, 'Later'));
  f.api.put(bookmark('moving', 'later', 0, 'Move me', 'https://move.test/'));
  const read = f.api.getChildren.bind(f.api);
  f.api.getChildren = async id => {
    if (id === 'later') f.api.put(bookmark('moving', 'folder-parent', 0, 'Move me', 'https://move.test/'));
    return read(id);
  };
  await f.queue.recover();
  assert.equal(f.api.node('moving').parentId, 'folder-parent');
  assert.equal((await f.store.listQueue(scope)).some(row => String(row.payload.type).startsWith('delete_')), false);
  await f.queue.recover();
  assert.ok((await f.store.listQueue(scope)).some(row => row.payload.type === 'move_node'));
});

for (const failure of ['Permission denied', 'bookmark backend unavailable', 'empty', "Can't find bookmark for id."]) {
  test(`DS-02 deletion needs a classified absence: ${failure}`, async () => {
    const f = await fixture(new IDBFactory(), { mappedNode: true });
    const get = f.api.get.bind(f.api);
    f.api.get = async id => {
      if (id !== 'mapped') return get(id);
      if (failure === 'empty') return [];
      throw new Error(failure);
    };
    if (failure === "Can't find bookmark for id.") {
      await f.queue.recover();
      assert.ok((await f.store.listQueue(scope)).some(row => row.payload.type === 'delete_node'));
    } else {
      await assert.rejects(f.queue.recover());
      assert.equal((await f.store.listQueue(scope)).some(row => String(row.payload.type).startsWith('delete_')), false);
    }
  });
}
