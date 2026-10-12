import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { mergeSyncTypedUpdate } from '@know-n/colp/sync';
import { fixture, mapping, bookmark, scope } from './bookmark-event-queue-harness.js';
import type { JsonObject } from '../src/sync-state-store.js';

for (const sameField of [false, true]) {
  test(`DS-03 retained observation ${sameField ? 'conflicts' : 'merges'} after remote changes`, async () => {
    const f = await fixture(new IDBFactory(), { mappedNode: true });
    f.api.put(bookmark('mapped', 'root-selected', 0, 'Local title', 'https://example.test/before'));
    await f.queue.changed('mapped', { title: 'Local title' });
    const current = { title: sameField ? 'Remote title' : 'Server before', url: 'https://example.test/remote-new' };
    await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-8', current);
    await f.queue.flush();
    const row = (await f.store.listQueue(scope))[0]!;
    assert.equal(row.baseRevision, 'server-revision-7');
    const payload = row.payload.payload as { base: JsonObject; value: JsonObject };
    const merged = mergeSyncTypedUpdate({ base: payload.base, incoming: payload.value, current });
    assert.equal(merged.status, sameField ? 'conflict' : 'merged');
    if (merged.status === 'merged') assert.deepEqual({ ...current, ...merged.value },
      { title: 'Local title', url: 'https://example.test/remote-new' });
  });
}

test('DS-03 a delayed delete retains its original revision', async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true });
  await f.queue.removed('mapped', { parentId: 'root-selected', index: 0,
    node: bookmark('mapped', 'root-selected', 0, 'Server before', 'https://example.test/before') });
  await mapping(f.store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-8', { title: 'New remote content' });
  await f.queue.flush();
  const row = (await f.store.listQueue(scope))[0]!;
  assert.equal(row.payload.type, 'delete_node');
  assert.equal(row.baseRevision, 'server-revision-7');
});

test('DS-03 legacy drafts without observation cannot fabricate a current base', async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true });
  await f.store.stageBookmarkEvent(scope, { eventId: 'legacy', dedupeKey: 'legacy', kind: 'change', nativeId: 'mapped',
    occurredAt: '2026-09-12T00:00:00Z', details: { draft: { type: 'update_node_content', payload: { value: { title: 'Local' } } } } });
  await f.queue.flush();
  assert.equal((await f.store.listQueue(scope)).length, 0);
  assert.equal((await f.store.getBookmarkEvent(scope, 'legacy'))?.status, 'pending');
});
