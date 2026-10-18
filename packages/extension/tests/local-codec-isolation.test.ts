import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';

test('an unstoreable native capture retains a bounded subject and independent capture queues', async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true, maxRecordBytes: 8000 });
  try {
    f.api.put({ id: 'mapped', parentId: 'root-selected', index: 1, title: 'x'.repeat(4000), url: 'https://example.test/before' });
    const captured = await f.queue.changed('mapped', { title: 'x'.repeat(4000) });
    assert.equal(captured.outcome, 'set_aside');
    assert.ok((await readOpenSyncIssues(f.store, scope)).nativeRoots.has('mapped'));
    assert.ok(await f.store.getLocalSyncExclusion(scope, 'mapped'));
    f.api.put({ id: 'independent', parentId: 'folder-parent', index: 0, title: 'Independent', url: 'https://independent.test/' });
    await f.queue.created('independent', { id: 'independent', parentId: 'folder-parent', index: 0, title: 'Independent', url: 'https://independent.test/' });
    await f.queue.flush();
    assert.equal((await f.store.listQueue(scope, 'pending')).length, 1);
  } finally { f.store.close(); }
});
