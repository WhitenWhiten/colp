import 'fake-indexeddb/auto';
import { expect, test, vi } from 'vitest';
import type { LocalNodeFact } from '../src/bootstrap/matcher.js';
import { STORES } from '../src/sync-state/schema.js';
import { barMount, baseConfirm, installKns03IndexedDb, root, scope, setup } from './kns-03-bootstrap-harness.js';

installKns03IndexedDb();

test('a fresh 958-bookmark rematch batches only its requested queue identities', async () => {
  const { store, coordinator } = await setup();
  const folders: LocalNodeFact[] = Array.from({ length: 9 }, (_, index) => ({
    nativeId: `folder-${index}`, mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: `Folder ${index}`,
  }));
  const localFacts: LocalNodeFact[] = [...folders, ...Array.from({ length: 958 }, (_, index): LocalNodeFact => ({
    nativeId: `bookmark-${index}`, mountNativeRootId: 'bar', parentNativeId: `folder-${index % 9}`,
    kind: 'bookmark', title: `Bookmark ${index}`, url: `https://queue-budget.test/${index}`,
  }))];
  let queueReads = 0;
  const transaction = IDBDatabase.prototype.transaction;
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase,
    ...args: Parameters<typeof transaction>) {
    const names = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]);
    if ((args[1] ?? 'readonly') === 'readonly' && names.includes(STORES.queue)) queueReads++;
    return transaction.apply(this, args);
  });
  try {
    const view = await coordinator.confirm(baseConfirm({ pauseAfter: 'matching', localFacts,
      mounts: [barMount('cloud-bar')], remoteFacts: [root, { nodeId: 'cloud-bar', parentId: root.nodeId,
        kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar', revision: 'bar-r1' }] }));
    expect(view.report?.localOnly).toHaveLength(967);
    expect(view.queuedOpIds).toEqual([]);
    // The input scale is unchanged from the real slow first sync. The budget
    // counts IDB transactions rather than host timing or mocked repository calls.
    expect(queueReads).toBeLessThanOrEqual(10);
    expect(await store.listQueue(scope)).toEqual([]);
    expect((await store.listBootstrapRuns(scope)).map(run => run.phase)).toEqual(['matching']);
  } finally { spy.mockRestore(); store.close(); }
});
