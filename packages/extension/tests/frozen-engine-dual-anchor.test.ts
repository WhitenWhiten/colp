import { afterEach, expect, test, vi } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { indexedDB, installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { duringNativeAdmission, pullNativeWrapperFixture } from './pull-native-wrapper-fixture.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';

installKns05IndexedDb();
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await subscriptionStore.close(); });

test('both anchors preserve an earlier local sibling reorder and recover its single uplink after restart', async () => {
  const f = await rejoinFixture(); let store = f.store;
  try {
    // Chrome has already accepted the user's drag, but the callback was lost.
    // The remote insertion's canonical order remains A, new, B.
    await f.api.move('native-child', { parentId: 'native-root', index: 0 });
    await f.applier.stage(f.page([pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: scope.collectionId, parentId: 'root-colp', afterId: 'node-1', beforeId: 'node-child' })]));
    await f.applier.resume();
    const created = (await store.getMappingByColpId(scope, 'node-created-1'))!;
    expect(created).toBeDefined();
    const localOrder = ['native-child', 'native-node', created.nativeId];
    expect((await f.api.getChildren('native-root')).map(row => row.id)).toEqual(localOrder);
    expect((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder)
      .toEqual(['native-node', created.nativeId, 'native-child']);
    expect(await store.listQueue(scope)).toEqual([]);
    store.close(); store = createSyncStateStore({ indexedDB });
    const queue = createBookmarkEventQueue({ store, scope, api: f.eventApi, autoFlush: false });
    await queue.recover();
    const rows = await store.listQueue(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ type: 'move_node', targetId: 'node-child',
      payload: { newParentId: 'root-colp', beforeId: 'node-1' } });
    expect(rows[0]?.payload.payload).not.toHaveProperty('afterId');
    expect((await store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenOrder).toEqual(localOrder);
    await queue.recover();
    expect((await store.listQueue(scope)).map(row => row.opId)).toEqual(rows.map(row => row.opId));
    expect((await f.api.getChildren('native-root')).map(row => row.id)).toEqual(localOrder);
    expect(f.api.calls).toEqual([{ kind: 'move', nativeId: 'native-child' }, { kind: 'create', nativeId: created.nativeId }]);
    expect((await store.getCursor(scope))?.cursor).toBe('cursor-next');
  } finally { store.close(); }
});

test('both anchors cannot reverse while the real create adapter awaits admission', async () => {
  const f = await pullNativeWrapperFixture();
  try {
    for (const [nativeId, colpId, index] of [['6', 'after', 0], ['7', 'before', 1]] as const) {
      await f.store.putMapping(f.scope, { ...f.target, nativeId, colpId,
        parentNativeId: '4', parentColpId: 'destination' });
      f.native.seed({ id: nativeId, parentId: '4', index, title: colpId, url: `https://${colpId}.test/` });
    }
    const applier = await f.applier();
    await applier.stage(pullFixtures.page({ events: [pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: f.scope.collectionId, parentId: 'destination', afterId: 'after', beforeId: 'before' })],
    nextCursor: 'next', collectionRevision: 'next-r1' }));
    const injected = duringNativeAdmission(() => f.native.move('7', { parentId: '4', index: 0 }));
    await expect(applier.resume()).rejects.toBeInstanceOf(NativeWriteNotStartedError);
    expect(injected()).toBe(true);
    expect(f.native.calls).toEqual([{ kind: 'move', nativeId: '7' }]);
    expect((await f.native.getChildren('4')).map(row => row.id)).toEqual(['7', '6']);
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
      apiPhase: 'intent_prepared', replayState: 'not_started', nativeResult: 'not_started',
      apiResultEvidence: null, nativeEventEvidence: null });
    f.restart();
    expect((await f.store.listApplyIntents(f.scope))[0]).toMatchObject({ state: 'intent_prepared',
      apiPhase: 'intent_prepared', replayState: 'not_started', nativeResult: 'not_started' });
    expect((await f.store.getCursor(f.scope))?.cursor).not.toBe('next');
    expect(await f.store.listAckIntents(f.scope)).toEqual([]);
  } finally { f.close(); }
});
