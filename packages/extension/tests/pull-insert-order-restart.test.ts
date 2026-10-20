import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test, vi } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { indexedDB, installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';

installKns05IndexedDb();

for (const placement of [
  { name: 'before', anchor: { beforeId: 'node-1' }, index: 0 },
  { name: 'after', anchor: { afterId: 'node-child' }, index: 2 },
  { name: 'between both anchors', anchor: { afterId: 'node-1', beforeId: 'node-child' }, index: 1 },
]) test(`remote insertion ${placement.name} survives restart and expired echoes without uploading a reorder`, async () => {
  const f = await rejoinFixture(); let store = f.store;
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
      parentId: 'root-colp', ...placement.anchor });
    await f.applier.stage(f.page([event]));
    await f.applier.resume();
    const created = await store.getMappingByColpId(scope, 'node-created-1');
    assert.ok(created);
    const expected = ['native-node', 'native-child']; expected.splice(placement.index, 0, created.nativeId);
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), expected);
    assert.deepEqual(f.api.calls, [{ kind: 'create', nativeId: created.nativeId }]);
    assert.equal((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenRevision, 'children-1');
    assert.deepEqual((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder, expected);
    const intents = await store.listApplyIntents(scope);
    assert.equal(intents.length, 1);
    const afterEchoWindow = Math.max(...intents.map(row => row.expiresAt)) + 1;

    // No onCreated callback is delivered. A later worker must use the durable
    // mapping/order, even after every short-lived echo reservation has expired.
    store.close(); store = createSyncStateStore({ indexedDB });
    clock = vi.spyOn(Date, 'now').mockReturnValue(afterEchoWindow);
    assert.ok((await store.listApplyIntents(scope)).every(row => row.expiresAt < Date.now()));
    const before = await store.exportScope(scope);
    const queue = createBookmarkEventQueue({ store, scope, api: f.eventApi, autoFlush: false,
      now: () => new Date(afterEchoWindow).toISOString() });
    await queue.recover(); await queue.recover();
    assert.deepEqual(await store.listQueue(scope), []);
    assert.deepEqual(await store.listBookmarkEvents(scope), []);
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), expected);
    assert.deepEqual((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder, expected);
    assert.deepEqual((await store.exportScope(scope)).mappings, before.mappings);
    assert.equal((await store.getCursor(scope))?.cursor, 'cursor-next');
    assert.ok((await store.listPullPages(scope)).every(row => row.state === 'page_complete'));
    assert.notEqual((await store.getEngineState(scope))?.recoveryFrozen, true);
    assert.deepEqual(f.api.calls, [{ kind: 'create', nativeId: created.nativeId }]);
  } finally { clock?.mockRestore(); store.close(); }
});
