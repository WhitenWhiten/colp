import { afterEach, expect, test, vi } from 'vitest';
import { liveWorker } from './service-worker-live-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.(); close = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function setup(materialized = false) {
  const f = await liveWorker(); close = f.close;
  f.permission.granted = true; const scope = await f.connect();
  f.api.seed({ id: '4', parentId: '1', index: 0, title: 'Destination' });
  const store = f.runtime.syncState;
  await store.putMapping(scope, { nativeId: '4', colpId: 'destination', rootNativeId: '4', mountId: 'destination',
    nodeKind: 'folder', projection: { revision: 'r1', digest: 'destination', childrenRevision: 'children-old',
      content: { title: 'Destination' } } });
  await store.putMountBinding(scope, { mountId: 'destination', nativeRootId: '4', remoteMountNodeId: 'destination',
    status: 'active', boundaryVersion: '1', materialized: true, customSourceKey: 'folder:4' });
  if (materialized) {
    for (const node of [
      { id: '8', parentId: '1', index: 1, title: 'Detached source' },
      { id: '2', parentId: '8', index: 0, title: 'Target' },
      { id: '6', parentId: '2', index: 0, title: 'Remote', url: 'https://example.test/' },
    ]) f.api.seed(node);
    for (const [nativeId, colpId, parentNativeId, parentColpId, title] of [
      ['8', 'source-root', '1', undefined, 'Detached source'],
      ['2', 'target', '8', 'source-root', 'Target'],
      ['6', 'child', '2', 'target', 'Remote'],
    ] as const) await store.putMapping(scope, { nativeId, colpId, parentNativeId,
      ...(parentColpId ? { parentColpId } : {}), rootNativeId: '8', mountId: 'source',
      nodeKind: nativeId === '6' ? 'bookmark' : 'folder', projection: { revision: 'revision-old', digest: colpId,
        ...(nativeId === '6' ? {} : { childrenRevision: 'children-old' }),
        content: { title, ...(nativeId === '6' ? { url: 'https://example.test/' } : {}) } } });
    await store.putMountBinding(scope, { mountId: 'source', nativeRootId: '8', remoteMountNodeId: 'source-root',
      status: 'detached', boundaryVersion: '1', materialized: true, customSourceKey: 'folder:8' });
  }
  vi.stubGlobal('navigator', { onLine: false });
  const worker = await import('../src/sw/bookmarks.js');
  expect(worker.bookmarkListenerLifecycle.install()).toBe(true);
  const { createPullApplier } = await import('../src/pull-applier.js');
  const { createChromePullBookmarkApi } = await import('../src/pull-bookmark-api.js');
  const applier = (crash?: (boundary: string) => void) => createPullApplier({ scope, store, api: createChromePullBookmarkApi(),
    ...(crash ? { crash } : {}),
    session: { acceptedProtocolVersion: '0.2', sessionId: 'root-create-events', collectionId: scope.collectionId,
      conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: `${scope.serverOrigin}/effects/{effectId}/pages/{pageNumber}`, effectPageAuthority: scope.serverOrigin });
  const event = materialized ? pullFixtures.mutationEvent({ kind: 'move', sequence: 1,
    collectionId: scope.collectionId, targetId: 'target', targetKind: 'folder', parentId: 'destination' })
    : pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
      parentId: 'destination', title: 'Remote' });
  await applier().stage(pullFixtures.page({ events: [event],
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
  return { ...f, scope, store, worker, applier, settled, emitCreated, reconcile,
    colpId: materialized ? 'child' : 'node-created-1', materialized };
}

/** An independent user create occurs after the final children read but before
 * the last parent read returns. All registered ingress/queue code is real. */
async function manualDuringFinalRead(f: Awaited<ReturnType<typeof setup>>) {
  const rawCreate = f.api.create.bind(f.api);
  const { subscriptionStore } = await import('../src/bookmark-subscriptions/store.js');
  const pending = subscriptionStore.pendingOperations.bind(subscriptionStore);
  let admitted = false, childrenRead = false, manualId = '', intentId = '', parentId = '';
  vi.spyOn(subscriptionStore, 'pendingOperations').mockImplementation(async () => {
    const rows = await pending();
    const intent = (await f.store.listApplyIntents(f.scope)).find(row => row.colpId === f.colpId
      && row.replayState === 'started' && row.state === 'browser_call_started');
    if (intent?.nativeParentId) { admitted = true; intentId = intent.intentId; parentId = intent.nativeParentId; }
    return rows;
  });
  const getChildren = chrome.bookmarks.getChildren.bind(chrome.bookmarks);
  vi.spyOn(chrome.bookmarks, 'getChildren').mockImplementation(async id => {
    const rows = await getChildren(id); if (admitted && id === parentId) childrenRead = true; return rows;
  });
  const get = chrome.bookmarks.get.bind(chrome.bookmarks);
  vi.spyOn(chrome.bookmarks, 'get').mockImplementation(async id => {
    const rows = await get(id);
    if (!manualId && childrenRead && id === parentId) {
      manualId = (await rawCreate({ parentId, title: 'Remote', url: 'https://example.test/' })).id;
      await f.emitCreated(manualId);
      expect((await f.store.getApplyIntent(f.scope, intentId))?.nativeEventEvidence).toMatchObject({ nativeId: manualId });
    }
    return rows;
  });
  return { get manualId() { return manualId; }, get intentId() { return intentId; }, rawCreate };
}

test.each([
  ['ordinary', 'before-api-return'], ['ordinary', 'after-api-return-and-reopen'],
  ['child', 'before-api-return'], ['child', 'after-api-return-and-reopen'],
] as const)(
  '%s Pull create retains its authoritative identity with a competing candidate: %s', async (kind, timing) => {
    const f = await setup(kind === 'child'); const race = await manualDuringFinalRead(f); let ownId = '';
    vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
      const created = await race.rawCreate(details);
      if (details.url) ownId = created.id;
      if (!details.url || timing === 'before-api-return') await f.emitCreated(created.id);
      return f.api.getNode(created.id) as unknown as chrome.bookmarks.BookmarkTreeNode;
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
    expect(await f.store.getMappingByNativeId(f.scope, ownId)).toMatchObject({ colpId: f.colpId });
    expect(await f.store.getMappingByColpId(f.scope, f.colpId)).toMatchObject({ nativeId: ownId });
    expect(await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100)).toHaveLength(0);
    const manual = (await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100))[0]!;
    expect(manual.kind).toBe('create');
    expect((await f.store.listQueue(f.scope)).filter(row => row.opId === manual.opId)).toHaveLength(1);
    expect((await f.store.getQueueByOpId(f.scope, manual.opId!))?.payload).toMatchObject({ type: 'create_node',
      payload: { parentId: f.materialized ? 'target' : 'destination',
        node: { kind: 'bookmark', title: 'Remote', url: 'https://example.test/' } } });
    f.store.close(); await f.store.open(); await f.reconcile(); await f.applier().resume();
    expect(await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100)).toHaveLength(1);
    expect(await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100)).toHaveLength(0);
    expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(f.materialized ? 3 : 2);
  });

test.each([
  ['ordinary', 'rename'], ['ordinary', 'delete'], ['child', 'rename'], ['child', 'delete'],
] as const)('%s candidate reservations preserve subsequent user %s callbacks', async (kind, action) => {
  const f = await setup(kind === 'child'); const race = await manualDuringFinalRead(f); let ownId = '';
  vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
    const created = await race.rawCreate(details); if (details.url) ownId = created.id;
    await f.emitCreated(created.id); return f.api.getNode(created.id) as unknown as chrome.bookmarks.BookmarkTreeNode;
  });
  await f.applier().resume();
  const receipt = (await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation;
  expect(receipt).toEqual({ kind: 'api_return', nativeId: ownId });
  if (action === 'rename') {
    for (const [id, title] of [[ownId, 'Own locally renamed'], [race.manualId, 'Manual locally renamed']] as const) {
      await f.api.update(id, { title }); f.nativeEvents.onChanged.emit(id, { title }); await f.settled();
    }
  } else {
    for (const id of [ownId, race.manualId]) {
      const node = f.api.getNode(id)!;
      await f.api.remove(id); f.nativeEvents.onRemoved.emit(id, { parentId: node.parentId, index: node.index, node });
      await f.settled();
    }
  }
  await f.reconcile(); f.store.close(); await f.store.open(); await f.reconcile();
  const ownEvents = await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100);
  expect(ownEvents.filter(row => row.kind === 'create')).toHaveLength(0);
  const ownChange = ownEvents.find(row => row.kind === (action === 'rename' ? 'change' : 'remove'));
  expect(ownChange?.opId).toBeTypeOf('string');
  const ownQueued = await f.store.getQueueByOpId(f.scope, ownChange!.opId!);
  expect(ownQueued?.payload).toMatchObject({ type: action === 'rename' ? 'update_node_content' : 'delete_node', targetId: f.colpId });
  const manualEvents = await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100);
  if (action === 'rename') {
    const creates = manualEvents.filter(row => row.kind === 'create'); expect(creates).toHaveLength(1);
    // Its placement can depend on the still-unacknowledged own rename. The
    // durable event must retain the user's real create while that dependency waits.
    expect(creates[0]!.details.draft).toMatchObject({ type: 'create_node',
      payload: { node: { title: 'Manual locally renamed' } } });
    expect(ownQueued?.payload).toMatchObject({ payload: { value: { title: 'Own locally renamed' } } });
    expect(await f.store.getMappingByNativeId(f.scope, ownId)).toMatchObject({ colpId: f.colpId });
  } else {
    expect(manualEvents.filter(row => row.kind === 'create')).toHaveLength(0);
    expect(f.api.getNode(ownId)).toBeUndefined(); expect(f.api.getNode(race.manualId)).toBeUndefined();
  }
  expect((await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation).toEqual(receipt);
});

test.each(['ordinary', 'child'] as const)('%s competing candidates never prove a lost create result', async kind => {
  const f = await setup(kind === 'child'); const race = await manualDuringFinalRead(f); let ownId = '';
  const create = vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
    const created = await race.rawCreate(details); await f.emitCreated(created.id);
    if (details.url) { ownId = created.id; throw new Error('worker_crash'); }
    return f.api.getNode(created.id) as unknown as chrome.bookmarks.BookmarkTreeNode;
  });
  await expect(f.applier().resume()).rejects.toThrow('worker_crash');
  expect(await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100)).toHaveLength(0);
  expect(await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100)).toHaveLength(0);
  const before = await f.store.getApplyIntent(f.scope, race.intentId);
  expect(before?.nativeEventEvidence).toMatchObject({ nativeId: race.manualId });
  expect(before?.apiResultEvidence ?? null).toBeNull();
  create.mockRestore(); f.store.close(); await f.store.open();
  await expect(f.applier().resume()).rejects.toThrow('native_result_unknown');
  const wait = (await f.send({ kind: 'known.nativeWait.list' })).waits.find((row: { intentId: string }) => row.intentId === race.intentId);
  expect(wait).toMatchObject({ intentId: race.intentId });
  expect((await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation?.kind).toBe('unknown');
  expect(await f.store.getMappingByNativeId(f.scope, ownId)).toBeNull();
  expect(await f.store.getMappingByNativeId(f.scope, race.manualId)).toBeNull();
  expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(f.materialized ? 3 : 2);
  expect(wait.candidates).toContainEqual({ nativeId: race.manualId });
  expect(await f.send({ kind: 'known.nativeWait.confirm', action: 'bind', userGesture: true,
    waitRef: wait.waitRef, intentId: wait.intentId, generation: wait.generation, nativeId: race.manualId }))
    .toMatchObject({ ok: true, result: 'bound' });
  await f.applier().resume();
  expect((await f.store.getMappingByColpId(f.scope, f.colpId))?.nativeId).toBe(race.manualId);
  expect((await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation)
    .toEqual({ kind: 'candidate_event', nativeId: race.manualId });
  expect(f.api.getNode(ownId)).toBeDefined();
  expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(f.materialized ? 3 : 2);
});

test('a real API receipt wins over the earlier manual candidate after interruption and reopen', async () => {
  const f = await setup(); const race = await manualDuringFinalRead(f); let ownId = '';
  vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
    ownId = (await race.rawCreate(details)).id; await f.emitCreated(ownId);
    return f.api.getNode(ownId) as unknown as chrome.bookmarks.BookmarkTreeNode;
  });
  await expect(f.applier(boundary => {
    if (boundary === 'after_evidence_before_mapping') throw new Error('worker_crash');
  }).resume()).rejects.toThrow('worker_crash');
  const partial = await f.store.getApplyIntent(f.scope, race.intentId);
  expect(partial?.nativeEventEvidence).toMatchObject({ nativeId: race.manualId });
  expect(partial?.nativeResultConfirmation).toEqual({ kind: 'api_return', nativeId: ownId });
  expect(await f.store.getMappingByNativeId(f.scope, ownId)).toBeNull();
  f.store.close(); await f.store.open(); await f.applier().resume();
  expect((await f.store.getMappingByColpId(f.scope, f.colpId))?.nativeId).toBe(ownId);
  await f.reconcile();
  expect((await f.store.getMappingByNativeId(f.scope, ownId))?.colpId).toBe(f.colpId);
  expect(await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100)).toHaveLength(0);
  expect((await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100)).filter(row => row.kind === 'create')).toHaveLength(1);
  expect((await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation).toEqual(partial?.nativeResultConfirmation);
  expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(2);
});

test.each(['rename', 'delete'] as const)('a user %s after the receipt survives interruption before mapping publication', async action => {
  const f = await setup(); const race = await manualDuringFinalRead(f); let ownId = '';
  let original: chrome.bookmarks.BookmarkTreeNode | undefined;
  vi.spyOn(chrome.bookmarks, 'create').mockImplementation(async details => {
    ownId = (await race.rawCreate(details)).id;
    original = structuredClone(f.api.getNode(ownId)) as unknown as chrome.bookmarks.BookmarkTreeNode;
    await f.emitCreated(ownId); return original;
  });
  await expect(f.applier(boundary => {
    if (boundary === 'after_evidence_before_mapping') throw new Error('worker_crash');
  }).resume()).rejects.toThrow('worker_crash');
  const receipt = (await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation;
  expect(receipt).toEqual({ kind: 'api_return', nativeId: ownId });
  expect(await f.store.getMappingByNativeId(f.scope, ownId)).toBeNull();
  if (action === 'rename') {
    await f.api.update(ownId, { title: 'User edit during interruption' });
    f.nativeEvents.onChanged.emit(ownId, { title: 'User edit during interruption' });
  } else {
    await f.api.remove(ownId);
    f.nativeEvents.onRemoved.emit(ownId, { parentId: original!.parentId, index: original!.index, node: original });
  }
  await f.settled();
  f.store.close(); await f.store.open();
  // Chrome's delayed onCreated retains the original event snapshot, even
  // though the current native state has since changed or disappeared.
  f.nativeEvents.onCreated.emit(ownId, original); await f.settled();
  await f.applier().resume(); await f.reconcile();
  const events = await f.store.listBookmarkEventsByNative(f.scope, ownId, 0, 100);
  expect(events.filter(row => row.kind === 'create')).toHaveLength(0);
  const changed = events.find(row => row.kind === (action === 'rename' ? 'change' : 'remove'));
  expect(changed?.opId).toBeTypeOf('string');
  const queued = await f.store.getQueueByOpId(f.scope, changed!.opId!);
  expect(queued?.payload).toMatchObject({ type: action === 'rename' ? 'update_node_content' : 'delete_node', targetId: f.colpId });
  if (action === 'rename') {
    expect(f.api.getNode(ownId)?.title).toBe('User edit during interruption');
    expect(queued?.payload).toMatchObject({ payload: { value: { title: 'User edit during interruption' } } });
  } else expect(f.api.getNode(ownId)).toBeUndefined();
  expect((await f.store.getApplyIntent(f.scope, race.intentId))?.nativeResultConfirmation).toEqual(receipt);
  expect((await f.store.listBookmarkEventsByNative(f.scope, race.manualId, 0, 100)).filter(row => row.kind === 'create')).toHaveLength(1);
  expect(f.api.calls.filter(call => call.kind === 'create')).toHaveLength(2);
});
