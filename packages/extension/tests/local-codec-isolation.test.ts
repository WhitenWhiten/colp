import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { bookmarkRepresentability } from '../src/bookmark-event-codec.js';

test('an unstoreable native capture retains a bounded subject and independent capture queues', async () => {
  const f = await fixture(new IDBFactory(), { mappedNode: true, maxRecordBytes: 8000 });
  try {
    // Keep the capture inside the server ingress profile, then exceed only the
    // smaller injected durable-record budget with the repeated draft/mapping URL.
    const url = `https://example.test/${'x'.repeat(4000)}`;
    const node = { id: 'mapped', parentId: 'root-selected', index: 1, title: 'Local edit', url };
    assert.equal(bookmarkRepresentability(node), 'supported');
    f.api.put(node);
    const captured = await f.queue.changed('mapped', { title: node.title, url });
    assert.equal(captured.outcome, 'set_aside');
    const issues = await readOpenSyncIssues(f.store, scope);
    assert.ok(issues.nativeRoots.has('mapped'));
    assert.ok(issues.local.some(issue => issue.nativeId === 'mapped' && issue.code === 'record_too_large'));
    assert.ok(await f.store.getLocalSyncExclusion(scope, 'mapped'));
    f.api.put({ id: 'independent', parentId: 'folder-parent', index: 0, title: 'Independent', url: 'https://independent.test/' });
    await f.queue.created('independent', { id: 'independent', parentId: 'folder-parent', index: 0, title: 'Independent', url: 'https://independent.test/' });
    await f.queue.flush();
    assert.equal((await f.store.listQueue(scope, 'pending')).length, 1);
  } finally { f.store.close(); }
});
