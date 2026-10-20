import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createPullApplier } from '../src/pull-applier.js';
import { installKns05IndexedDb, setup as setupPull, scope as pullScope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

for (const autoFlush of [false, true]) for (const sameParent of [false, true]) {
  test(`a local undo and redo after remote move survives autoFlush=${autoFlush}, sameParent=${sameParent}`, async () => {
  const f = await setupPull();
  try {
    f.api.seed({ id: 'native-folder', parentId: 'native-root', index: 2, title: 'Folder' });
    await f.store.putMapping(pullScope, { nativeId: 'native-folder', colpId: 'folder-colp', rootNativeId: 'native-root',
      parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'folder',
      projection: { revision: 'folder-r1', childrenRevision: 'folder-children', digest: 'folder', content: { title: 'Folder' } } });
    const away = { parentId: sameParent ? 'native-root' : 'native-folder', index: sameParent ? 1 : 0 };
    await f.api.move('native-node', away);
    const old = (await f.store.getMappingByNativeId(pullScope, 'native-node'))!;
    const { scopeKey: _scopeKey, ...mapping } = old;
    await f.store.putMapping(pullScope, { ...mapping, parentNativeId: away.parentId, parentColpId: sameParent ? 'root-colp' : 'folder-colp' });
    const queue = createBookmarkEventQueue({ scope: pullScope, store: f.store, autoFlush, api: {
      get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    } });
    await createPullApplier(f.options).stage(f.page([f.mutationEvent('move')]));
    await createPullApplier(f.options).resume();
    const echo = f.api.lastEvent!;
    assert.equal(echo.kind, 'move');
    assert.equal((await queue.moved(echo.nativeId, echo.details)).outcome, 'apply_intent_reserved');
    await f.api.move('native-node', away);
    assert.equal((await queue.moved('native-node', f.api.lastEvent!.details)).outcome, 'staged');
    // A duplicate original callback arriving while the user is away is still an echo.
    assert.equal((await queue.moved(echo.nativeId, echo.details)).outcome, 'apply_intent_reserved');
    await f.api.move('native-node', { parentId: 'native-root', index: 0 });
    const restartedQueue = createBookmarkEventQueue({ scope: pullScope, store: f.store, autoFlush, api: {
      get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
      getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })),
    } });
    const final = await restartedQueue.moved('native-node', f.api.lastEvent!.details);
    assert.equal(final.outcome, 'staged', 'The final deliberate local move was mistaken for the completed remote move echo');
  } finally { f.store.close(); }
});
}
