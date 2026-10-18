import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, scope, bookmark } from './bookmark-event-queue-harness.js';

test('real capture holds placement anchored to an open issue; another folder remains independent', async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true });
  try {
    f.api.put(bookmark('mapped', 'root-selected', 1, 'Server before', 'https://example.test/before'));
    const { scopeKey: _key, ...mapped } = (await f.store.getMappingByNativeId(scope, 'mapped'))!;
    await f.store.putMapping(scope, { ...mapped, parentNativeId: 'root-selected',
      parentColpId: (await f.store.getMappingByNativeId(scope, 'root-selected'))!.colpId });
    await f.store.recordLocalIssue(scope, { nativeId: 'mapped', code: 'recovery_identity_unproven', now: 1 });
    for (const [id, parent, index] of [['related', 'root-selected', 2], ['independent', 'folder-parent', 0]] as const) {
      const native = bookmark(id, parent, index, id, `https://example.test/${id}`); f.api.put(native);
      await f.queue.created(id, native);
    }
    await f.queue.flush();
    const rows = await f.store.listQueue(scope);
    const related = rows.find(row => (row.payload.payload as any).node.title === 'related')!;
    const independent = rows.find(row => (row.payload.payload as any).node.title === 'independent')!;
    assert.equal((related.payload.payload as any).afterId, 'mapped-colp');
    assert.equal(related.status, 'set_aside'); assert.equal(independent.status, 'pending');
  } finally { f.store.close(); }
});
