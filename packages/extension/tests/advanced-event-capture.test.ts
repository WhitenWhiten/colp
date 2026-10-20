import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { captureWhileAdvanced } from '../src/bootstrap/advanced-event-capture.js';
import { activateAdvancedPlan, executeActiveAdvancedPlan } from '../src/bootstrap/advanced-run.js';
import { buildAdvancedPlan } from '../src/bootstrap/advanced-plan.js';
import type { AdvancedNativeApi, AdvancedNativeNode } from '../src/bootstrap/advanced-local-executor.js';
import type { AdvancedStep } from '../src/bootstrap/advanced-plan-types.js';
import { createBookmarkEventQueue, type BookmarkEventApi, type BookmarkEventNode } from '../src/bookmark-event-queue.js';
import type { BookmarkCaptureEvent } from '../src/bookmark-listener-lifecycle.js';
import { createSyncStateStore, type JsonObject, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import type { LocalNodeFact, MountFact, RemoteNodeFact } from '../src/bootstrap/matcher.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

const barMount: MountFact = { nativeRootId: 'bar', rootRole: 'bookmarks-bar', remoteMountNodeId: 'remote-bar' };
const rootFact: RemoteNodeFact = {
  nodeId: 'root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'root-r1',
  childrenRevision: 'root-c1',
};
const remoteBarFact: RemoteNodeFact = {
  nodeId: 'remote-bar', parentId: 'root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
  revision: 'bar-r1', childrenRevision: 'bar-c1',
};
const localBarFact: LocalNodeFact = {
  nativeId: 'bar', mountNativeRootId: 'bar', parentNativeId: '0', kind: 'folder', title: 'Bar',
};
const updateMoveLocalFacts: readonly LocalNodeFact[] = [
  localBarFact,
  { nativeId: 'folder-a', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Folder A', index: 0 },
  { nativeId: 'folder-b', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'folder', title: 'Folder B', index: 1 },
  { nativeId: 'update-target', mountNativeRootId: 'bar', parentNativeId: 'folder-a', kind: 'bookmark',
    title: 'Before', url: 'https://example.test/before', index: 0 },
  { nativeId: 'move-target', mountNativeRootId: 'bar', parentNativeId: 'folder-a', kind: 'bookmark',
    title: 'Move', url: 'https://example.test/move', index: 1 },
];
const updateMoveRemoteFacts: readonly RemoteNodeFact[] = [
  rootFact, remoteBarFact,
  { nodeId: 'remote-a', parentId: 'remote-bar', kind: 'folder', title: 'Folder A', revision: 'folder-a-r1',
    childrenRevision: 'folder-a-c1', position: 'a' },
  { nodeId: 'remote-b', parentId: 'remote-bar', kind: 'folder', title: 'Folder B', revision: 'folder-b-r1',
    childrenRevision: 'folder-b-c1', position: 'b' },
  { nodeId: 'remote-update', parentId: 'remote-a', kind: 'bookmark', title: 'After',
    url: 'https://example.test/after', revision: 'update-r1', position: 'a' },
  { nodeId: 'remote-move', parentId: 'remote-b', kind: 'bookmark', title: 'Move',
    url: 'https://example.test/move', revision: 'move-r1', position: 'a' },
];
const updateMoveMappings = [
  { nativeId: 'folder-a', colpId: 'remote-a' },
  { nativeId: 'folder-b', colpId: 'remote-b' },
  { nativeId: 'update-target', colpId: 'remote-update' },
  { nativeId: 'move-target', colpId: 'remote-move' },
] as const;

type StubNode = BookmarkEventNode & AdvancedNativeNode;
interface ChromeBookmarkStub extends BookmarkEventApi, Pick<AdvancedNativeApi, 'create' | 'update' | 'move' | 'remove'> {
  put(node: StubNode): void;
  node(nativeId: string): StubNode | undefined;
}

interface AdvancedFixture {
  readonly indexedDB: IDBFactory;
  readonly store: ReturnType<typeof createSyncStateStore>;
  readonly api: ChromeBookmarkStub;
  readonly plan: ReturnType<typeof buildAdvancedPlan>;
}

let confirmationSequence = 0;

for (const kind of ['children_reordered', 'reordered'] as const) {
  test('persists ' + kind + ' during advanced execution and drains the final order after restart', async () => {
    const ids = ['native-a', 'native-b', 'native-c'];
    const fixture = await createAdvancedFixture({
      local: [localBarFact, ...ids.map((nativeId, index) => ({ nativeId, mountNativeRootId: 'bar',
        parentNativeId: 'bar', kind: 'bookmark' as const, title: nativeId,
        url: 'https://example.test/' + nativeId, index }))],
      remote: [rootFact, remoteBarFact, ...ids.map((nativeId, index) => ({
        nodeId: 'remote-' + nativeId, parentId: 'remote-bar', kind: 'bookmark' as const,
        title: nativeId, url: 'https://example.test/' + nativeId, revision: 'r-' + nativeId,
        position: ['a', 'b', 'c'][index]! }))],
      mappings: ids.map(nativeId => ({ nativeId, colpId: 'remote-' + nativeId })),
    });
    for (const nativeId of ids) await putMapping(fixture.store, {
      nativeId, colpId: 'remote-' + nativeId, parentNativeId: 'bar', nodeKind: 'bookmark',
      revision: 'r-' + nativeId, content: { title: nativeId, url: 'https://example.test/' + nativeId },
    });
    const parent = await fixture.store.getMappingByNativeId(scope, 'bar');
    assert.ok(parent);
    await fixture.store.putMapping(scope, { nativeId: 'bar', colpId: parent.colpId, rootNativeId: 'bar',
      nodeKind: 'folder', mountId: 'mount:bar', rootRole: 'bookmarks-bar',
      projection: { revision: 'bar-r1', childrenRevision: 'bar-c1', digest: 'sha256:bar',
        content: { title: 'Bar' }, childrenOrder: ids } });
    const finalOrder = ['native-c', 'native-a', 'native-b'];
    finalOrder.forEach((id, index) => fixture.api.put({
      ...bookmarkNode(id, 'bar', id, 'https://example.test/' + id), index,
    }));
    for (const childIds of [['native-b', 'native-a', 'native-c'], finalOrder]) {
      assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
        event: { kind, nativeId: 'bar', childIds } }), true);
    }
    assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
    assert.deepEqual(await fixture.store.listQueue(scope), []);
    assert.deepEqual((await fixture.store.listPendingReorders(scope)).map(row => row.childIds), [finalOrder]);

    fixture.store.close();
    const store = createSyncStateStore({ indexedDB: fixture.indexedDB });
    try {
      assert.deepEqual((await store.listPendingReorders(scope)).map(row => row.childIds), [finalOrder]);
      await executeActiveAdvancedPlan(store, scope, fixture.api);
      assert.equal((await store.readAdvancedPlan(scope, fixture.plan.planId))?.plan.state, 'completed');
      const queue = createBookmarkEventQueue({ store, scope, api: fixture.api, autoFlush: false });
      await queue.recover();
      const uploaded = await store.listQueue(scope);
      assert.deepEqual(uploaded.map(row => [row.payload.type, row.payload.targetId]),
        [['move_node', 'remote-native-c']]);
      assert.equal((uploaded[0]!.payload.payload as JsonObject).beforeId, 'remote-native-a');
      assert.deepEqual((await store.getMappingByNativeId(scope, 'bar'))?.projection.childrenOrder, finalOrder);
      assert.deepEqual(await store.listPendingReorders(scope), []);
      await queue.recover();
      assert.deepEqual((await store.listQueue(scope)).map(row => row.opId), uploaded.map(row => row.opId));
    } finally { store.close(); }
  });
}

test('keeps a user create in the durable inbox while an advanced plan is active and recovers it after restart', async () => {
  const fixture = await createAdvancedFixture();
  const created = bookmarkNode('user-created', 'bar', 'Saved while syncing', 'https://example.test/user-created');
  fixture.api.put(created);

  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'created', nativeId: created.id, node: created } }), true);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
  assert.deepEqual((await fixture.store.listBookmarkEvents(scope)).map((event) => [event.kind, event.status]),
    [['create', 'pending']]);

  fixture.store.close();
  const reopenedStore = createSyncStateStore({ indexedDB: fixture.indexedDB });
  assert.deepEqual((await reopenedStore.listBookmarkEvents(scope)).map((event) => [event.kind, event.status]),
    [['create', 'pending']]);
  assert.deepEqual(await reopenedStore.listQueue(scope), []);

  await executeActiveAdvancedPlan(reopenedStore, scope, fixture.api);
  const resumedQueue = createBookmarkEventQueue({ scope, store: reopenedStore, api: fixture.api,
    autoFlush: false, uuid: () => 'resume-event' });
  await resumedQueue.recover();
  assert.deepEqual((await reopenedStore.listQueue(scope)).map((row) => row.payload.type), ['create_node']);
  assert.equal((await reopenedStore.listBookmarkEvents(scope))[0]?.status, 'processed');
});

test('accumulates concurrent exact local-create observations and keeps them out of the inbox', async () => {
  const remoteBookmark: RemoteNodeFact = {
    nodeId: 'remote-planned', parentId: remoteBarFact.nodeId, kind: 'bookmark', title: 'Planned',
    url: 'https://example.test/planned', revision: 'planned-r1',
  };
  const fixture = await createAdvancedFixture({ remote: [rootFact, remoteBarFact, remoteBookmark] });
  const create = await localStepRecord(fixture, 'create');
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, create.order,
    { expectedState: 'pending', state: 'executing' });

  const observations = await Promise.all([
    captureCreated(fixture, bookmarkNode('native-observed-a', 'bar', 'Planned', remoteBookmark.url!)),
    captureCreated(fixture, bookmarkNode('native-observed-b', 'bar', 'Planned', remoteBookmark.url!)),
  ]);
  assert.deepEqual(observations, [true, true]);
  const loaded = await fixture.store.readAdvancedPlan(scope, fixture.plan.planId);
  const observed = loaded?.steps.find((step) => step.order === create.order)?.evidence?.observedNativeIds;
  assert.ok(Array.isArray(observed));
  assert.deepEqual((observed as string[]).slice().sort(), ['native-observed-a', 'native-observed-b']);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
});

test('suppresses a late own create by terminal native mapping but preserves an external same-URL create', async () => {
  const remoteBookmark: RemoteNodeFact = {
    nodeId: 'remote-planned', parentId: remoteBarFact.nodeId, kind: 'bookmark', title: 'Planned',
    url: 'https://example.test/planned', revision: 'planned-r1',
  };
  const fixture = await createAdvancedFixture({ remote: [rootFact, remoteBarFact, remoteBookmark] });
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  const completed = await fixture.store.readAdvancedPlan(scope, fixture.plan.planId);
  const create = completed?.steps.find((step) => step.definition.side === 'local'
    && step.definition.action === 'create');
  const ownNativeId = typeof create?.evidence?.nativeId === 'string' ? create.evidence.nativeId : '';
  assert.notEqual(ownNativeId, '');
  const own = fixture.api.node(ownNativeId);
  assert.ok(own);
  assert.equal((await fixture.store.getMappingByNativeId(scope, ownNativeId))?.colpId, remoteBookmark.nodeId);

  assert.equal(await captureCreated(fixture, own), true);
  const external = bookmarkNode('external-same-url', 'bar', remoteBookmark.title, remoteBookmark.url!);
  fixture.api.put(external);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'created', nativeId: external.id, node: external } }), false);

  const queue = createBookmarkEventQueue({ scope, store: fixture.store, api: fixture.api,
    autoFlush: false, uuid: () => 'external-event' });
  assert.equal((await queue.created(external.id, external)).outcome, 'staged');
  assert.equal((await fixture.store.listBookmarkEvents(scope)).length, 1);
  assert.equal((await fixture.store.getMappingByNativeId(scope, ownNativeId))?.colpId, remoteBookmark.nodeId);
});

test('retains rename and move events for a target absent from the immutable plan', async () => {
  const fixture = await createAdvancedFixture();
  await putMapping(fixture.store, { nativeId: 'folder-a', colpId: 'folder-a-colp', parentNativeId: 'bar',
    nodeKind: 'folder', content: { title: 'Folder A' }, childrenRevision: 'folder-a-c1' });
  await putMapping(fixture.store, { nativeId: 'folder-b', colpId: 'folder-b-colp', parentNativeId: 'bar',
    nodeKind: 'folder', content: { title: 'Folder B' }, childrenRevision: 'folder-b-c1' });
  await putMapping(fixture.store, { nativeId: 'user-target', colpId: 'user-target-colp', parentNativeId: 'folder-a',
    nodeKind: 'bookmark', content: { title: 'Before', url: 'https://example.test/before' } });
  fixture.api.put(folderNode('folder-a', 'bar', 'Folder A'));
  fixture.api.put(folderNode('folder-b', 'bar', 'Folder B'));
  fixture.api.put(bookmarkNode('user-target', 'folder-a', 'Before', 'https://example.test/before'));

  fixture.api.put(bookmarkNode('user-target', 'folder-a', 'After', 'https://example.test/before'));
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'changed', nativeId: 'user-target', changes: { title: 'After' } } }), true);

  fixture.api.put(bookmarkNode('user-target', 'folder-b', 'After', 'https://example.test/before'));
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'moved', nativeId: 'user-target', move: {
      parentId: 'folder-b', index: 0, oldParentId: 'folder-a', oldIndex: 0,
    } } }), true);

  assert.deepEqual((await fixture.store.listBookmarkEvents(scope)).map((event) => [event.kind, event.nativeId]),
    [['change', 'user-target'], ['move', 'user-target']]);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
});

test('filters protected and out-of-scope browser events before they reach the inbox', async () => {
  const fixture = await createAdvancedFixture();
  const managed = { ...bookmarkNode('managed', 'bar', 'Managed', 'https://example.test/managed'), unmodifiable: 'managed' };
  fixture.api.put(managed);
  const privateParent = folderNode('private', '0', 'Private');
  const outsideParent = folderNode('outside', '0', 'Outside');
  fixture.api.put(privateParent);
  fixture.api.put(outsideParent);
  const privateChild = bookmarkNode('private-child', privateParent.id, 'Private', 'https://example.test/private');
  const outsideChild = bookmarkNode('outside-child', outsideParent.id, 'Outside', 'https://example.test/outside');
  fixture.api.put(privateChild);
  fixture.api.put(outsideChild);

  for (const event of [
    { kind: 'created' as const, nativeId: managed.id, node: managed },
    { kind: 'created' as const, nativeId: privateChild.id, node: privateChild },
    { kind: 'created' as const, nativeId: outsideChild.id, node: outsideChild },
  ]) {
    assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }), true);
  }
  const bar = fixture.api.node('bar');
  assert.ok(bar);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'removed', nativeId: 'bar', removal: { parentId: '0', index: 0, node: bar } } }), true);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
});

test('suppresses an own local remove echo without generating a remote delete', async () => {
  const localOnly: LocalNodeFact = {
    nativeId: 'planned-remove', mountNativeRootId: 'bar', parentNativeId: 'bar', kind: 'bookmark',
    title: 'Remove me', url: 'https://example.test/remove-me',
  };
  const fixture = await createAdvancedFixture({ local: [localBarFact, localOnly] });
  const remove = await localStepRecord(fixture, 'remove');
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, remove.order,
    { expectedState: 'pending', state: 'executing' });
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'removed', nativeId: localOnly.nativeId, removal: {
      parentId: localOnly.parentNativeId!, index: 0, node: bookmarkNode(localOnly.nativeId,
        localOnly.parentNativeId!, localOnly.title, localOnly.url!),
    } } }), true);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
});

test('does not rebind an existing native mapping while recording an exact planned create echo', async () => {
  const remoteBookmark: RemoteNodeFact = {
    nodeId: 'remote-planned', parentId: remoteBarFact.nodeId, kind: 'bookmark', title: 'Planned',
    url: 'https://example.test/planned', revision: 'planned-r1',
  };
  const fixture = await createAdvancedFixture({ remote: [rootFact, remoteBarFact, remoteBookmark] });
  await putMapping(fixture.store, { nativeId: 'preexisting', colpId: 'already-bound', parentNativeId: 'bar',
    nodeKind: 'bookmark', content: { title: 'Existing', url: 'https://example.test/existing' } });
  const create = await localStepRecord(fixture, 'create');
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, create.order,
    { expectedState: 'pending', state: 'executing' });
  const existing = bookmarkNode('preexisting', 'bar', remoteBookmark.title, remoteBookmark.url!);
  fixture.api.put(existing);
  const before = await fixture.store.getMappingByNativeId(scope, existing.id);
  assert.equal(before?.colpId, 'already-bound');
  assert.equal(await captureCreated(fixture, existing), true);
  assert.deepEqual(await fixture.store.getMappingByNativeId(scope, existing.id), before);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
});

test('consumes a late completed remove once without freezing recovery or generating a remote delete', async () => {
  const local: LocalNodeFact = { nativeId: 'late-remove', mountNativeRootId: 'bar', parentNativeId: 'bar',
    kind: 'bookmark', title: 'Local only', url: 'https://example.test/local-only', index: 0 };
  const fixture = await createAdvancedFixture({ local: [localBarFact, local] });
  const node = bookmarkNode(local.nativeId, 'bar', local.title, local.url!);
  fixture.api.put(node);
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  assert.equal((await fixture.store.readAdvancedPlan(scope, fixture.plan.planId))?.plan.state, 'completed');
  const event: Extract<BookmarkCaptureEvent, { kind: 'removed' }> = {
    kind: 'removed', nativeId: node.id, removal: { parentId: 'bar', index: 0, node },
  };
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { ...event, removal: { ...event.removal, index: 1 } } }), false);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { ...event, removal: { ...event.removal, node: { ...node, title: 'Another node' } } } }), false);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }), true);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }), false);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
  assert.notEqual((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
});

test('does not consume a completed remove echo against a newly bound identity', async () => {
  const local: LocalNodeFact = { nativeId: 'rebound', mountNativeRootId: 'bar', parentNativeId: 'bar',
    kind: 'bookmark', title: 'Local only', url: 'https://example.test/local-only' };
  const fixture = await createAdvancedFixture({ local: [localBarFact, local] });
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  await putMapping(fixture.store, { nativeId: local.nativeId, colpId: 'new-identity', parentNativeId: 'bar',
    nodeKind: 'bookmark', content: { title: local.title, url: local.url! } });
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'removed', nativeId: local.nativeId, removal: { parentId: 'bar', index: 0,
      node: bookmarkNode(local.nativeId, 'bar', local.title, local.url!) } } }), false);
});

test('consumes each completed update and move echo once, then leaves the same user changes alone', async () => {
  const fixture = await createUpdateMoveFixture();
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  const update = changedEvent('update-target', 'After', 'https://example.test/after');
  const move = movedEvent('move-target', 'folder-b', 0, 'folder-a', 1);

  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: update }), true);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: move }), true);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: update }), false);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: move }), false);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);

  const loaded = await fixture.store.readAdvancedPlan(scope, fixture.plan.planId);
  const echoes = loaded?.steps.filter((step) => step.evidence?.echoObserved !== undefined);
  assert.equal(echoes?.length, 2);
});

test('uses one CAS winner for concurrent late echo captures', async () => {
  const fixture = await createUpdateMoveFixture();
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  const event = changedEvent('update-target', 'After', 'https://example.test/after');
  const outcomes = await Promise.all([
    captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }),
    captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }),
  ]);
  assert.deepEqual(outcomes.slice().sort(), [false, true]);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
});

test('persists move echo consumption with the observed shifted indices across store restart', async () => {
  const fixture = await createUpdateMoveFixture();
  const move = await localStepRecord(fixture, 'move');
  await seedAfterState(fixture, 'move');
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, move.order,
    { expectedState: 'pending', state: 'executing' });
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, move.order,
    { expectedState: 'executing', state: 'terminal', evidence: {
      nativeId: 'move-target', targetId: 'remote-move', beforeIndex: 3, index: 0,
    } });
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  const event = movedEvent('move-target', 'folder-b', 0, 'folder-a', 3);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }), true);
  await fixture.store.close();
  const reopened = createSyncStateStore({ indexedDB: fixture.indexedDB });
  assert.equal(await captureWhileAdvanced({ store: reopened, scope, api: fixture.api, event }), false);
  assert.deepEqual(await reopened.listBookmarkEvents(scope), []);
  await reopened.close();
});

test('records an active update and move echo before completion and rejects later repeats as user events', async () => {
  const fixture = await createUpdateMoveFixture();
  const update = await localStepRecord(fixture, 'update');
  const move = await localStepRecord(fixture, 'move');
  await seedAfterState(fixture, 'update');
  await seedAfterState(fixture, 'move');
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, update.order,
    { expectedState: 'pending', state: 'executing' });
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, move.order,
    { expectedState: 'pending', state: 'executing' });

  const updateEvent = changedEvent('update-target', 'After', 'https://example.test/after');
  const moveEvent = movedEvent('move-target', 'folder-b', 0, 'folder-a', 1);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: updateEvent }), true);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: moveEvent }), true);
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, update.order,
    { expectedState: 'executing', state: 'terminal', evidence: {
      nativeId: 'update-target', targetId: 'remote-update', revision: 'update-r1',
    } });
  await fixture.store.settleAdvancedStep(scope, fixture.plan.planId, move.order,
    { expectedState: 'executing', state: 'terminal', evidence: {
      nativeId: 'move-target', targetId: 'remote-move', revision: 'move-r1', beforeIndex: 1, index: 0,
    } });
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  assert.equal((await fixture.store.readAdvancedPlan(scope, fixture.plan.planId))?.plan.state, 'completed');
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: updateEvent }), false);
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event: moveEvent }), false);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
});

test('rejects a late echo when the mapping revision no longer matches the remote source revision', async () => {
  const fixture = await createUpdateMoveFixture();
  await executeActiveAdvancedPlan(fixture.store, scope, fixture.api);
  await putMapping(fixture.store, { nativeId: 'update-target', colpId: 'remote-update', parentNativeId: 'folder-a',
    nodeKind: 'bookmark', content: { title: 'After', url: 'https://example.test/after' }, revision: 'newer-revision' });
  const event = changedEvent('update-target', 'After', 'https://example.test/after');
  assert.equal(await captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api, event }), false);
  assert.deepEqual(await fixture.store.listBookmarkEvents(scope), []);
  assert.deepEqual(await fixture.store.listQueue(scope), []);
  const loaded = await fixture.store.readAdvancedPlan(scope, fixture.plan.planId);
  assert.equal(loaded?.steps.some((step) => step.evidence?.echoObserved !== undefined), false);
});

async function createAdvancedFixture(input: {
  readonly local?: readonly LocalNodeFact[];
  readonly remote?: readonly RemoteNodeFact[];
  readonly mappings?: readonly { readonly nativeId: string; readonly colpId: string }[];
  readonly mode?: 'upload' | 'download' | 'mirror';
} = {}): Promise<AdvancedFixture> {
  const indexedDB = new IDBFactory();
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [], rootStatus: 'ready' });
  await store.configureBrowserRoots(scope, { discovered: [
    { nativeId: 'bar', ancestorNativeIds: [] },
    { nativeId: 'private', ancestorNativeIds: [] },
  ], selectedNativeIds: ['bar'], privateNativeIds: ['private'], status: 'ready' });
  const local = input.local ?? [localBarFact];
  const remote = input.remote ?? [rootFact, remoteBarFact];
  const mode = input.mode ?? 'download';
  const mounts = [barMount];
  const confirmationId = `advanced-test-${++confirmationSequence}`;
  const boundaryVersion = (await store.getScope(scope))?.boundaryVersion ?? '0';
  const plan = buildAdvancedPlan({ scope, confirmationId, mode, boundaryVersion, treeDigest: 'tree',
    remoteSnapshotId: 'snapshot', remoteRevision: 'revision', remoteCursor: 'cursor', local, remote,
    mappings: input.mappings ?? [], mounts, rootNodeId: rootFact.nodeId });
  const definitions = [
    ...remote.map((fact) => ({ kind: 'snapshot-fact', fact,
      nativeId: plan.matched.find((pair) => pair.nodeId === fact.nodeId)?.nativeId ?? null })),
    ...plan.steps,
  ];
  const metadata = JSON.parse(JSON.stringify({ mode, mounts, confirmationId, treeDigest: 'tree',
    boundaryVersion, remoteSnapshotId: 'snapshot', remoteRevision: 'revision', remoteCursor: 'cursor' })) as JsonObject;
  const committed = await store.commitAdvancedPlan(scope, { planId: plan.planId, metadata,
    steps: JSON.parse(JSON.stringify(definitions)) as JsonObject[], now: 10 });
  await activateAdvancedPlan(store, scope, committed);
  const barMapping = await store.getMappingByNativeId(scope, 'bar');
  assert.ok(barMapping);
  await store.putMapping(scope, { nativeId: 'bar', colpId: barMapping.colpId, rootNativeId: 'bar',
    nodeKind: 'folder', mountId: 'mount:bar', rootRole: 'bookmarks-bar',
    projection: { revision: 'bar-r1', childrenRevision: 'bar-c1', digest: 'sha256:bar', content: { title: 'Bar' } } });
  const api = chromeBookmarkStub([folderNode('bar', '0', 'Bar'), folderNode('private', '0', 'Private'),
    folderNode('outside', '0', 'Outside')]);
  return { indexedDB, store, api, plan };
}

async function createUpdateMoveFixture(): Promise<AdvancedFixture> {
  const fixture = await createAdvancedFixture({ local: updateMoveLocalFacts, remote: updateMoveRemoteFacts,
    mappings: updateMoveMappings });
  fixture.api.put(folderNode('folder-a', 'bar', 'Folder A'));
  fixture.api.put(folderNode('folder-b', 'bar', 'Folder B'));
  fixture.api.put(bookmarkNode('update-target', 'folder-a', 'After', 'https://example.test/after'));
  fixture.api.put(bookmarkNode('move-target', 'folder-b', 'Move', 'https://example.test/move'));
  await putMapping(fixture.store, { nativeId: 'folder-a', colpId: 'remote-a', parentNativeId: 'bar',
    nodeKind: 'folder', content: { title: 'Folder A' }, childrenRevision: 'folder-a-c1', revision: 'folder-a-r1' });
  await putMapping(fixture.store, { nativeId: 'folder-b', colpId: 'remote-b', parentNativeId: 'bar',
    nodeKind: 'folder', content: { title: 'Folder B' }, childrenRevision: 'folder-b-c1', revision: 'folder-b-r1' });
  await putMapping(fixture.store, { nativeId: 'update-target', colpId: 'remote-update', parentNativeId: 'folder-a',
    nodeKind: 'bookmark', content: { title: 'Before', url: 'https://example.test/before' }, revision: 'old-update-r1' });
  await putMapping(fixture.store, { nativeId: 'move-target', colpId: 'remote-move', parentNativeId: 'folder-a',
    nodeKind: 'bookmark', content: { title: 'Move', url: 'https://example.test/move' }, revision: 'old-move-r1' });
  return fixture;
}

async function seedAfterState(fixture: AdvancedFixture, target: 'update' | 'move'): Promise<void> {
  if (target === 'update') {
    await putMapping(fixture.store, { nativeId: 'update-target', colpId: 'remote-update', parentNativeId: 'folder-a',
      nodeKind: 'bookmark', content: { title: 'After', url: 'https://example.test/after' }, revision: 'update-r1' });
    return;
  }
  await putMapping(fixture.store, { nativeId: 'move-target', colpId: 'remote-move', parentNativeId: 'folder-b',
    nodeKind: 'bookmark', content: { title: 'Move', url: 'https://example.test/move' }, revision: 'move-r1' });
}

async function localStepRecord(fixture: AdvancedFixture, action: 'create' | 'remove' | 'update' | 'move') {
  const planStep = fixture.plan.steps.find((step): step is Extract<AdvancedStep, { side: 'local' }> =>
    step.side === 'local' && step.action === action);
  assert.ok(planStep);
  const loaded = await fixture.store.readAdvancedPlan(scope, fixture.plan.planId);
  const record = loaded?.steps.find((step) => step.definition.stepId === planStep.stepId);
  assert.ok(record);
  return record;
}

function changedEvent(nativeId: string, title: string, url: string): Extract<BookmarkCaptureEvent, { kind: 'changed' }> {
  return { kind: 'changed', nativeId, changes: { title, url } };
}

function movedEvent(nativeId: string, parentId: string, index: number, oldParentId: string, oldIndex: number)
  : Extract<BookmarkCaptureEvent, { kind: 'moved' }> {
  return { kind: 'moved', nativeId, move: { parentId, index, oldParentId, oldIndex } };
}

async function captureCreated(fixture: AdvancedFixture, node: StubNode | undefined): Promise<boolean> {
  assert.ok(node);
  return captureWhileAdvanced({ store: fixture.store, scope, api: fixture.api,
    event: { kind: 'created', nativeId: node.id, node } });
}

async function putMapping(store: ReturnType<typeof createSyncStateStore>, input: {
  readonly nativeId: string; readonly colpId: string; readonly parentNativeId?: string;
  readonly nodeKind: NonNullable<MappingInput['nodeKind']>; readonly content: JsonObject;
  readonly childrenRevision?: string; readonly revision?: string;
}) {
  await store.putMapping(scope, { nativeId: input.nativeId, colpId: input.colpId, rootNativeId: 'bar',
    nodeKind: input.nodeKind, ...(input.parentNativeId ? { parentNativeId: input.parentNativeId } : {}),
    projection: { revision: input.revision ?? `revision-${input.nativeId}`, digest: `sha256:${input.nativeId}`,
      ...(input.childrenRevision ? { childrenRevision: input.childrenRevision } : {}), content: input.content } });
}

function chromeBookmarkStub(initial: readonly StubNode[] = []): ChromeBookmarkStub {
  const nodes = new Map(initial.map((node) => [node.id, structuredClone(node)]));
  let sequence = 0;
  const clone = (node: StubNode): StubNode => structuredClone(node);
  return {
    put(node) { nodes.set(node.id, clone(node)); },
    node(nativeId) { const node = nodes.get(nativeId); return node ? clone(node) : undefined; },
    async get(nativeId) { const node = nodes.get(nativeId); return node ? [clone(node)] : []; },
    async getChildren(parentId) { return [...nodes.values()].filter((node) => node.parentId === parentId).map(clone); },
    async create(input) {
      const node: StubNode = { id: `created-${++sequence}`, parentId: input.parentId, title: input.title,
        ...(input.url === undefined ? { type: 'folder' } : { url: input.url, type: 'bookmark' }) };
      nodes.set(node.id, node); return clone(node);
    },
    async update(nativeId, input) {
      const prior = nodes.get(nativeId); if (!prior) throw new Error(`Can't find bookmark for id ${nativeId}`);
      const next = { ...prior, ...input }; nodes.set(nativeId, next); return clone(next);
    },
    async move(nativeId, input) {
      const prior = nodes.get(nativeId); if (!prior) throw new Error(`Can't find bookmark for id ${nativeId}`);
      const next = { ...prior, parentId: input.parentId }; nodes.set(nativeId, next); return clone(next);
    },
    async remove(nativeId) { nodes.delete(nativeId); },
  };
}

function folderNode(id: string, parentId: string, title: string): StubNode {
  return { id, parentId, title, type: 'folder' };
}

function bookmarkNode(id: string, parentId: string, title: string, url: string): StubNode {
  return { id, parentId, title, url, type: 'bookmark' };
}
