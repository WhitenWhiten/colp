import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { digestJson } from '../src/bookmark-event-codec.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.store.close(); });
async function setup() {
  const f = await fixture(new IDBFactory(), { mappedNode: true }); fixtures.push(f);
  f.api.put(bookmark('mapped', 'root-selected', 1, 'Server before', 'https://example.test/before'));
  return f;
}
const tagsBase = { revision: 'server-revision-7', tags: [] as string[], eventId: 'tags-intent' };
const pinBase = { revision: 'server-revision-7', extensions: {}, eventId: 'pin-intent' };

for (const tags of [['repeat', 'repeat'], [''], ['x'.repeat(65)], Array.from({ length: 65 }, (_, i) => `tag${i}`)]) {
  test(`invalid tags (${tags.length}/${tags[0]!.length}) never allocate an operation or change the projection`, async () => {
    const f = await setup(), before = await f.store.exportScope(scope);
    await assert.rejects(f.queue.tagged('mapped', tags, tagsBase), /bookmark_annotation_invalid/);
    assert.deepEqual(await f.store.exportScope(scope), before);
  });
}

test('unchanged empty descriptions, tags and pins are no-ops even in old projections without those fields', async () => {
  const f = await setup();
  assert.deepEqual(await f.queue.described('folder-parent', null), { outcome: 'filtered' });
  assert.deepEqual(await f.queue.tagged('mapped', [], tagsBase), { outcome: 'filtered' });
  assert.deepEqual(await f.queue.pinned('mapped', false, pinBase), { outcome: 'filtered' });
  assert.deepEqual(await f.store.listBookmarkEventsByStatus(scope, 'pending'), []);
  assert.deepEqual(await f.store.listQueue(scope), []);
});

test('metadata methods reject the wrong node kind and managed bookmarks before staging', async () => {
  const f = await setup();
  assert.deepEqual(await f.queue.described('mapped', 'folder-only'), { outcome: 'filtered' });
  assert.deepEqual(await f.queue.tagged('folder-parent', ['bookmark-only'], tagsBase), { outcome: 'filtered' });
  assert.deepEqual(await f.queue.pinned('folder-parent', true, pinBase), { outcome: 'filtered' });
  f.api.put({ ...f.api.node('mapped'), unmodifiable: 'managed' });
  assert.deepEqual(await f.queue.tagged('mapped', ['private'], tagsBase), { outcome: 'filtered' });
  assert.deepEqual(await f.queue.pinned('mapped', true, pinBase), { outcome: 'filtered' });
  assert.deepEqual(await f.store.listBookmarkEventsByStatus(scope, 'pending'), []);
  assert.deepEqual(await f.store.listQueue(scope), []);
});

test('an explicit description intent keeps its original baseline when current independently reached the same value', async () => {
  const f = await setup();
  const current = (await f.store.getMappingByNativeId(scope, 'folder-parent'))!;
  const { scopeKey: _scope, ...mapping } = current;
  await f.store.putMapping(scope, { ...mapping, nodeKind: 'folder', projection: { revision: 'server-new',
    digest: digestJson({ title: 'Parent' }), content: { title: 'Parent', description: 'Independent same value' } } });
  const baseline = { revision: 'server-old', description: 'Old value', eventId: 'offline-description' };
  assert.equal((await f.queue.described('folder-parent', 'Independent same value', baseline)).outcome, 'staged');
  await f.queue.flush();
  const rows = await f.store.listQueue(scope); assert.equal(rows.length, 1);
  assert.equal(rows[0]!.baseRevision, 'server-old');
  assert.deepEqual(rows[0]!.payload.payload, { base: { description: 'Old value' }, value: { description: 'Independent same value' } });
  assert.deepEqual(await f.queue.described('folder-parent', 'Independent same value', baseline), { outcome: 'filtered' });
  assert.equal((await f.store.listQueue(scope)).length, 1);
});
