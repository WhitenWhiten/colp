import { afterEach, expect, test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.(); close = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function setup() {
  const f = await liveWorker(); close = f.close;
  f.permission.granted = true; const scope = await f.connect();
  f.api.seed({ id: '4', parentId: '1', index: 0, title: 'Destination' });
  const store = f.runtime.syncState;
  await store.putMapping(scope, { nativeId: '4', colpId: 'destination', rootNativeId: '4', mountId: 'destination',
    nodeKind: 'folder', projection: { revision: 'r1', digest: 'destination', childrenRevision: 'children-old',
      content: { title: 'Destination' } } });
  await store.putMountBinding(scope, { mountId: 'destination', nativeRootId: '4', remoteMountNodeId: 'destination',
    status: 'active', boundaryVersion: '1', materialized: true, customSourceKey: 'folder:4' });
  vi.stubGlobal('navigator', { onLine: false });
  const worker = await import('../src/sw/bookmarks.js');
  expect(worker.bookmarkListenerLifecycle.install()).toBe(true);
  const { createPullApplier } = await import('../src/pull-applier.js');
  const { createChromePullBookmarkApi } = await import('../src/pull-bookmark-api.js');
  const applier = () => createPullApplier({ scope, store, api: createChromePullBookmarkApi(),
    session: { acceptedProtocolVersion: '0.2', sessionId: 'root-create-events', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`, effectPageAuthority: scope.serverOrigin });
  await applier().stage(pullFixtures.page({ events: [pullFixtures.createEvent({ kind: 'Bookmark',
    sequence: 1, collectionId: scope.collectionId, parentId: 'destination', title: 'Remote' })],
  nextCursor: 'root-next', collectionRevision: 'root-next-r1' }));
  async function settled() {
    await worker.bookmarkListenerLifecycle.settled(); await f.runtime.workCoordinator.drain();
  }
  async function emitCreated(id: string) {
    f.nativeEvents.onCreated.emit(id, f.api.getNode(id)); await settled();
  }
  async function reconcile() {
    f.alarms.emit({ name: f.runtime.BOOKMARK_RECONCILE_ALARM, scheduledTime: Date.now() });
    await f.runtime.workCoordinator.drain();
  }
  return { ...f, scope, store, worker, applier, settled, emitCreated, reconcile };
}

/** An independent user create occurs after the final children read but before
 * the last parent read returns. All registered ingress/queue code is real. */
async function manualDuringFinalRead(f: Awaited<ReturnType<typeof setup>>) {
  const rawCreate = f.api.create.bind(f.api);
  const { subscriptionStore } = await import('../src/bookmark-subscriptions/store.js');
  const pending = subscriptionStore.pendingOperations.bind(subscriptionStore);
  let admitted = false, childrenRead = false, manualId = '', intentId = '';
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const rows = await pending();
    const intent = (await f.store.listApplyIntents(f.scope)).find(row => row.colpId === 'node-created-1'
      && row.replayState === 'started' && row.state === 'browser_call_started');
    if (intent) { admitted = true; intentId = intent.intentId; }
    return rows;
  });
  const getChildren = chrome.bookmarks.getChildren.bind(chrome.bookmarks);
  vi.spyOn(chrome.bookmarks, 'getChildren').mockImplementation(async id => {
    const rows = await getChildren(id); if (admitted && id === '4') childrenRead = true; return rows;
  });
  const get = chrome.bookmarks.get.bind(chrome.bookmarks);
  vi.spyOn(chrome.bookmarks, 'get').mockImplementation(async id => {
    const rows = await get(id);
    if (!manualId && childrenRead && id === '4') {
      manualId = (await rawCreate({ parentId: '4', title: 'Remote', url: 'https://example.test/' })).id;
      await f.emitCreated(manualId);
      expect((await f.store.getApplyIntent(f.scope, intentId))?.nativeEventEvidence).toMatchObject({ nativeId: manualId });
    }
    return rows;
  });
  return { get manualId() { return manualId; }, get intentId() { return intentId; }, rawCreate };
}

test.each(['before-api-return', 'after-api-return-and-reopen'] as const)(
  'ordinary Pull create retains its authoritative identity with a competing candidate: %s', async timing => {
    const f = await setup(); const race = await manualDuringFinalRead(f); let ownId = '';
    vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
      ownId = (await race.rawCreate(details)).id;
      if (timing === 'before-api-return') await f.emitCreated(ownId);
      return f.api.getNode(ownId) as unknown as chrome.bookmarks.BookmarkTreeNode;
    });
    await f.applier().resume();
    expect(race.manualId).not.toBe(''); expect(ownId).not.toBe(race.manualId);
    expect((await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation)
      .toEqual({ kind: 'api_return', nativeId: ownId });
    if (timing === 'after-api-return-and-reopen') {
      f.store.close(); await f.store.open(); await f.emitCreated(ownId);
    }
    await f.reconcile();
    await vi.waitFor(async () => expect(await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100)).toHaveLength(1));
    expect(await f.store.getMappingByNativeId(f.scope, ownId)).toMatchObject({ colpId: 'node-created-1' });
    expect(await f.store.getMappingByColpId(f.scope, 'node-created-1')).toMatchObject({ nativeId: ownId });
    expect(await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100)).toHaveLength(0);
    const manual = (await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100))[0]!;
    expect(manual.kind).toBe('create');
    expect((await f.store.listQueue(f.scope)).filter(row => row.opId === manual.opId)).toHaveLength(1);
    expect((await f.store.getQueueByOpId(f.scope, manual.opId!))?.payload).toMatchObject({ type: 'create_node',
      payload: { parentId: 'destination', node: { kind: 'bookmark', title: 'Remote', url: 'https://example.test/' } } });
    f.store.close(); await f.store.open(); await f.reconcile(); await f.applier().resume();
    expect(await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100)).toHaveLength(1);
    expect(await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100)).toHaveLength(0);
    expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(2);
  });
