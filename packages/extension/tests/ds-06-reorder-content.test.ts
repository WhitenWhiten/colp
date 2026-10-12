import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, mapping, bookmark, folder, scope } from './bookmark-event-queue-harness.js';
import { validateMappingRecord } from '../src/sync-state/mapping-repository.js';

test('DS-06 order metadata stays separate and a subsequent rename is uploadable', async () => {
  const f = await fixture(new IDBFactory());
  for (const id of ['a', 'b']) {
    f.api.put(bookmark(id, 'folder-parent', id === 'a' ? 0 : 1, id, `https://${id}.test/`));
    await mapping(f.store, id, `colp-${id}`, 'root-selected', `r-${id}`,
      { title: id, url: `https://${id}.test/` }, 'folder-parent');
  }
  const before = await f.store.getMappingByNativeId(scope, 'folder-parent');
  await f.queue.reordered('folder-parent', ['b', 'a']); await f.queue.flush();
  const reordered = await f.store.getMappingByNativeId(scope, 'folder-parent');
  assert.equal(reordered?.projection.digest, before?.projection.digest);
  assert.deepEqual(reordered?.projection.childrenOrder, ['b', 'a']);
  assert.equal(reordered?.projection.content?.childrenOrder, undefined);
  f.api.put(folder('folder-parent', 'root-selected', 0, 'Renamed'));
  await f.queue.changed('folder-parent', { title: 'Renamed' }); await f.queue.flush();
  const rename = (await f.store.listQueue(scope)).find(row => row.payload.type === 'update_node_content');
  assert.deepEqual(rename?.payload.payload, { base: { title: 'Parent' }, value: { title: 'Renamed' } });
  assert.deepEqual((await f.store.getMappingByNativeId(scope, 'folder-parent'))?.projection.childrenOrder, ['b', 'a']);
});

test('DS-06 reading a legacy record migrates metadata without dropping protocol fields', async () => {
  const row = validateMappingRecord('scope', { scopeKey: 'scope', nativeId: 'folder', colpId: 'colp', rootNativeId: 'root',
    projection: { revision: 'r1', digest: 'old-order-digest', content: { title: 'Folder',
      extensions: { 'https://example.test/': { custom: true } }, childrenOrder: ['a', 'b'], childrenOrderDigest: 'old' } } }, 256_000);
  assert.deepEqual(row.projection.childrenOrder, ['a', 'b']);
  assert.deepEqual(row.projection.content, { title: 'Folder', extensions: { 'https://example.test/': { custom: true } } });
  assert.notEqual(row.projection.digest, 'old-order-digest');
});
