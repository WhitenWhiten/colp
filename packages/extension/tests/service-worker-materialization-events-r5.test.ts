import { afterEach, expect, test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import type { MappingInput } from '../src/sync-state-store.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.(); close = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Full registered worker/listener/queue graph. Only the external Chrome port,
 * HTTP and IDB implementation are controlled by liveWorker; no direct observe. */
async function setup() {
  const f = await liveWorker(); close = f.close;
  f.permission.granted = true; const scope = await f.connect();
  // This is a valid tree under Chrome's permanent bookmarks bar, with a
  // detached ordinary source folder and an active destination folder.
  for (const node of [
    { id: '4', parentId: '1', index: 0, title: 'Destination' },
    { id: '8', parentId: '1', index: 1, title: 'Detached source' },
    { id: '2', parentId: '8', index: 0, title: 'Target' },
    { id: '6', parentId: '2', index: 0, title: 'Child', url: 'https://child.test/' },
  ]) f.api.seed(node);
  const store = f.runtime.syncState;
  const rows: MappingInput[] = [
    { nativeId: '4', colpId: 'destination', rootNativeId: '4', mountId: 'destination', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'destination', childrenRevision: 'children-old', content: { title: 'Destination' } } },
    { nativeId: '8', colpId: 'source-root', rootNativeId: '8', mountId: 'source', nodeKind: 'folder',
      projection: { revision: 'r1', digest: 'source', childrenRevision: 'children-old', content: { title: 'Detached source' } } },
    { nativeId: '2', colpId: 'target', rootNativeId: '8', mountId: 'source', nodeKind: 'folder',
      parentNativeId: '8', parentColpId: 'source-root',
      projection: { revision: 'revision-old', digest: 'target', childrenRevision: 'children-old', content: { title: 'Target' } } },
    { nativeId: '6', colpId: 'child', rootNativeId: '8', mountId: 'source', nodeKind: 'bookmark',
      parentNativeId: '2', parentColpId: 'target',
      projection: { revision: 'revision-old', digest: 'child', content: { title: 'Child', url: 'https://child.test/' } } },
  ];
  for (const mapping of rows) await store.putMapping(scope, mapping);
  for (const [mountId, nativeRootId, remoteMountNodeId, status] of [
    ['destination', '4', 'destination', 'active'], ['source', '8', 'source-root', 'detached'],
  ] as const) await store.putMountBinding(scope, { mountId, nativeRootId, remoteMountNodeId, status,
    boundaryVersion: '1', materialized: true, customSourceKey: `folder:${nativeRootId}` });
  // Native ingress remains active offline, just as when a fetched Pull page is
  // applied after connectivity drops. No background network response is forged.
  vi.stubGlobal('navigator', { onLine: false });
  const worker = await import('../src/sw/bookmarks.js');
  expect(worker.bookmarkListenerLifecycle.install()).toBe(true);
  const { createPullApplier } = await import('../src/pull-applier.js');
  const { createChromePullBookmarkApi } = await import('../src/pull-bookmark-api.js');
  const applier = () => createPullApplier({ scope, store, api: createChromePullBookmarkApi(),
    session: { acceptedProtocolVersion: '0.2', sessionId: 'native-event-route', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`, effectPageAuthority: scope.serverOrigin });
  const event = pullFixtures.mutationEvent({ kind: 'move', sequence: 1, collectionId: scope.collectionId,
    targetId: 'target', targetKind: 'folder', parentId: 'destination' });
  await applier().stage(pullFixtures.page({ events: [event], nextCursor: 'next', collectionRevision: 'next-r1' }));
  async function emitCreated(nativeId: string) {
    f.nativeEvents.onCreated.emit(nativeId, f.api.getNode(nativeId));
    await worker.bookmarkListenerLifecycle.settled();
    await f.runtime.workCoordinator.drain();
  }
  return { ...f, scope, store, worker, applier, emitCreated };
}

test('real worker onCreated records a child candidate before its new parent mapping is published', async () => {
  const f = await setup();
  const create = f.api.create.bind(f.api); let childId = '', parentId = '';
  const raw = vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
    const created = await create(details);
    if (details.title === 'Child') {
      childId = created.id; parentId = details.parentId!;
      expect(await f.store.getMappingByNativeId(f.scope, parentId)).toBeNull();
    }
    await f.emitCreated(created.id);
    if (details.title === 'Child') throw new Error('worker_crash');
    return f.api.getNode(created.id) as unknown as chrome.bookmarks.BookmarkTreeNode;
  });
  await expect(f.applier().resume()).rejects.toThrow('worker_crash');
  const before = await f.store.listApplyIntents(f.scope);
  const child = before.find(row => row.colpId === 'child')!;
  const root = before.find(row => row.eventId)!;
  expect(child.nativeEventEvidence).toMatchObject({ nativeId: childId });
  expect(root.nativeResultConfirmation).toEqual({ kind: 'api_return', nativeId: parentId });
  expect(await f.store.listQueue(f.scope)).toHaveLength(0);
  raw.mockRestore();
  await expect(f.applier().resume()).rejects.toThrow('native_result_unknown');
  const listed = await f.send({ kind: 'known.nativeWait.list' });
  expect(listed).toMatchObject({ ok: true, waits: [{ intentId: child.intentId,
    title: 'Child', url: 'https://child.test/', candidates: [{ nativeId: childId }] }] });
  const wait = listed.waits[0];
  expect(await f.send({ kind: 'known.nativeWait.confirm', action: 'bind', userGesture: true,
    waitRef: wait.waitRef, intentId: wait.intentId, generation: wait.generation, nativeId: childId })).toMatchObject({ ok: true });
  await f.applier().resume();
  expect((await f.store.getMappingByColpId(f.scope, 'child'))?.nativeId).toBe(childId);
  expect((await f.store.getApplyIntent(f.scope, root.intentId))?.nativeResultConfirmation).toEqual(root.nativeResultConfirmation);
  expect(f.api.getNode('6')).toMatchObject({ parentId: '2' });
  expect(f.api.getNode('2')).toMatchObject({ parentId: '8' });
  await f.applier().resume();
  expect(f.api.calls.filter(row => row.kind === 'create')).toHaveLength(2);
});

test('a same-shaped manual child observed during final admission is recovered by the ordinary recovery alarm', async () => {
  const f = await setup();
  const create = f.api.create.bind(f.api);
  vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
    const result = await create(details); await f.emitCreated(result.id);
    return f.api.getNode(result.id) as unknown as chrome.bookmarks.BookmarkTreeNode;
  });
  const { subscriptionStore } = await import('../src/bookmark-subscriptions/store.js');
  const pending = subscriptionStore.pendingOperations.bind(subscriptionStore);
  let manualId = '', observedIntentId = '', parentId = '';
  let adapterAdmission = false, finalChildrenRead = false;
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const rows = await pending();
    if (manualId) return rows;
    const child = (await f.store.listApplyIntents(f.scope)).find(row => row.colpId === 'child'
      && row.state === 'browser_call_started' && row.replayState === 'started');
    if (!child?.nativeParentId) return rows;
    adapterAdmission = true; parentId = child.nativeParentId; observedIntentId = child.intentId;
    return rows;
  });
  const getChildren = chrome.bookmarks.getChildren.bind(chrome.bookmarks);
  vi.spyOn(chrome.bookmarks, 'getChildren').mockImplementation(async id => {
    const children = await getChildren(id);
    if (adapterAdmission && id === parentId) finalChildrenRead = true;
    return children;
  });
  const get = chrome.bookmarks.get.bind(chrome.bookmarks);
  vi.spyOn(chrome.bookmarks, 'get').mockImplementation(async id => {
    const rows = await get(id);
    if (manualId || !finalChildrenRead || id !== parentId) return rows;
    // The final guard has read children and is awaiting the parent's native
    // preimage. A user's new sibling does not change that parent's fields.
    // This is an actual API-read boundary, not a fabricated intent receipt.
    const manual = await create({ parentId, title: 'Child', url: 'https://child.test/' });
    manualId = manual.id;
    await f.emitCreated(manualId);
    expect((await f.store.getApplyIntent(f.scope, observedIntentId))?.nativeEventEvidence).toMatchObject({ nativeId: manualId });
    return rows;
  });
  await f.applier().resume();
  expect(manualId).not.toBe('');
  const own = await f.store.getMappingByColpId(f.scope, 'child');
  expect(own?.nativeId).not.toBe(manualId);
  expect((await f.store.getApplyIntent(f.scope, observedIntentId))?.nativeResultConfirmation)
    .toEqual({ kind: 'api_return', nativeId: own!.nativeId });
  // Use the production alarm entry and its engine-settled reconciliation,
  // rather than calling queue.created/reconcile or synthesizing a receipt.
  f.alarms.emit({ name: f.runtime.BOOKMARK_RECONCILE_ALARM, scheduledTime: Date.now() });
  await f.runtime.workCoordinator.drain();
  await vi.waitFor(async () => expect(await f.store.listBookmarkEventsByNative(f.scope, manualId, 0, 100)).toHaveLength(1));
  expect(await f.store.getMappingByNativeId(f.scope, own!.nativeId)).toMatchObject({ colpId: 'child' });
  expect(await f.store.getMappingByColpId(f.scope, 'child')).toMatchObject({ nativeId: own!.nativeId });
  expect(await f.store.listBookmarkEventsByNative(f.scope, own!.nativeId, 0, 100)).toHaveLength(0);
  expect((await f.store.getMappingByNativeId(f.scope, manualId))?.colpId).toMatch(/^pending-/u);
  const manualEvents = await f.store.listBookmarkEventsByNative(f.scope, manualId, 0, 100);
  expect(manualEvents.filter(row => row.kind === 'create')).toHaveLength(1);
  const manualQueue = (await f.store.listQueue(f.scope)).filter(row => row.opId === manualEvents[0]!.opId);
  expect(manualQueue).toHaveLength(1);
  expect(manualQueue[0]!.payload).toMatchObject({ type: 'create_node', payload: { parentId: 'target',
    node: { kind: 'bookmark', title: 'Child', url: 'https://child.test/' } } });
  expect(f.api.getNode(manualId)).toBeDefined();
});
