import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { ack, json, nonemptyMountSnapshot, scope, setup } from './durable-sync-engine-harness.js';

async function existingBookmark() {
  const fixture = await setup({ snapshotRequired: true, emptyCollection: true });
  await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1',
    remoteMountNodeId: 'mount-bar', boundaryVersion: '1', materialized: true,
    status: 'active', rootRole: 'bookmarks-bar' });
  await fixture.store.putMapping(scope, { nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder',
    parentColpId: 'root-server', rootRole: 'bookmarks-bar', mountId: 'mount-bar',
    projection: { revision: 'old-bar', digest: 'old-bar', childrenRevision: 'old-children', content: { title: 'Bookmarks bar' } } });
  await fixture.store.putMapping(scope, { nativeId: '2', colpId: 'child-a', rootNativeId: '1', nodeKind: 'bookmark',
    parentColpId: 'mount-bar', parentNativeId: '1', mountId: 'mount-bar',
    projection: { revision: 'old-child', digest: 'old-child',
      content: { title: 'Before remote edit', url: 'https://example.test/child' } } });
  fixture.chromeNodes.set('2', { id: '2', parentId: '1', title: 'Before remote edit', url: 'https://example.test/child' });
  fixture.snapshotResponses.push(json(200, nonemptyMountSnapshot(true)));
  fixture.ackResponses.push(json(200, ack('bootstrap-cursor')));
  const events = createBookmarkEventQueue({ scope, store: fixture.store, autoFlush: false,
    api: {
      async get(id) {
        const node = fixture.chromeNodes.get(id); if (!node) throw new Error("Can't find bookmark for id.");
        return [{ ...node, title: node.title ?? '' }];
      },
      async getChildren(id) { return [...fixture.chromeNodes.values()].filter(node => node.parentId === id)
        .map(node => ({ ...node, title: node.title ?? '' })); },
    } });
  return { ...fixture, fixture, events };
}

test('snapshot recovery applies changed remote content before publishing authority, without authoring an echo', async () => {
  const fixture = await existingBookmark();
  try {
    const state = await fixture.engine.wake('startup');
    assert.equal(state?.lastError, undefined);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'child-a'))?.projection.content?.title, 'Child');
    assert.equal(fixture.chromeNodes.get('2')?.title, 'Child');
    assert.equal(fixture.chromeNodes.get('1')?.title, 'Bookmarks bar');
    await fixture.events.recover();
    const queue = await fixture.store.listQueue(scope, undefined, 0, 100);
    assert.equal(queue.filter(row => row.payload.type === 'update_node_content').length, 0);
  } finally { await fixture.store.close(); }
});

for (const phase of ['uncaptured', 'inbox', 'queue'] as const) {
  test(`snapshot recovery preserves a local edit in ${phase} and its old Base`, async () => {
    const fixture = await existingBookmark();
    fixture.chromeNodes.set('2', { ...fixture.chromeNodes.get('2')!, title: 'Local edit' });
    if (phase !== 'uncaptured') assert.equal((await fixture.events.changed('2', { title: 'Local edit' }, 'callback')).outcome, 'staged');
    if (phase === 'queue') await fixture.events.flush();
    try {
      assert.equal((await fixture.engine.wake('startup'))?.lastError, undefined);
      assert.equal(fixture.chromeNodes.get('2')?.title, 'Local edit');
      const inbox = await fixture.store.listBookmarkEventsByStatus(scope, 'pending', 0, 100);
      const queued = await fixture.store.listQueue(scope, undefined, 0, 100);
      const draft = (phase === 'queue' ? queued.find(row => row.payload.targetId === 'child-a')?.payload
        : inbox.find(event => event.nativeId === '2')?.details.draft) as {
        baseRevision: string; payload: { base: { title: string }; value: { title: string } };
      };
      assert.equal(draft.baseRevision, 'old-child');
      assert.deepEqual(draft.payload.base, { title: 'Before remote edit' });
      assert.deepEqual(draft.payload.value, { title: 'Local edit' });
      const remote = await fixture.store.getRemoteObservation(scope, 'child-a');
      assert.equal(remote?.payload.title, 'Child');
      assert.equal(remote?.cursor, 'bootstrap-cursor');
    } finally { await fixture.store.close(); }
  });
}

for (const editDuringRestart of [false, true]) {
  test(`snapshot content update replays after native commit and before mapping commit (local edit=${editDuringRestart})`, async () => {
    const fixture = await existingBookmark();
    fixture.fixture.crashAt = 'after_snapshot_native_update';
    try {
      await assert.rejects(() => fixture.engine.wake('startup'), /worker_crash/);
      assert.equal(fixture.chromeNodes.get('2')?.title, 'Child');
      assert.equal(fixture.ackRequests.length, 0);
      if (editDuringRestart) fixture.chromeNodes.set('2', { ...fixture.chromeNodes.get('2')!, title: 'Edited while stopped' });
      assert.equal((await fixture.reopen().wake('startup'))?.lastError, undefined);
      assert.equal(fixture.chromeNodes.get('2')?.title, editDuringRestart ? 'Edited while stopped' : 'Child');
      assert.equal(fixture.ackRequests.length, 1);
      assert.equal((await fixture.store.listProjectionIntents(scope)).every(intent => intent.state === 'terminal'), true);
      if (editDuringRestart) assert.equal((await fixture.store.listBookmarkEventsByStatus(scope, 'pending', 0, 100)).length, 1);
    } finally { await fixture.store.close(); }
  });
}

test('snapshot content updates preserve a private root and its native descendants', async () => {
  const fixture = await existingBookmark();
  const folder = { nativeId: '3', colpId: 'private-folder', rootNativeId: '1', nodeKind: 'folder' as const,
    parentNativeId: '1', parentColpId: 'mount-bar', projection: { revision: 'old-private',
      childrenRevision: 'old-private-children', digest: 'old-private', content: { title: 'Private label' } } };
  await fixture.store.putMapping(scope, folder);
  const child = (await fixture.store.getMappingByColpId(scope, 'child-a'))!;
  const { scopeKey: _key, ...mapping } = child;
  await fixture.store.putMapping(scope, { ...mapping, parentNativeId: '3', parentColpId: 'private-folder' });
  fixture.chromeNodes.set('3', { id: '3', parentId: '1', title: 'Private label' });
  fixture.chromeNodes.set('2', { ...fixture.chromeNodes.get('2')!, parentId: '3' });
  await fixture.store.configureBrowserRoots(scope, { selectedNativeIds: ['1'], privateNativeIds: ['3'], status: 'ready',
    discovered: [{ nativeId: '1', ancestorNativeIds: [] }, { nativeId: '3', ancestorNativeIds: ['1'] }] });
  const snapshot = nonemptyMountSnapshot(true);
  fixture.snapshotResponses[0] = json(200, { ...snapshot,
    nodes: [snapshot.nodes[0], snapshot.nodes[1], {
      id: 'private-folder', collectionId: scope.collectionId, kind: 'folder', parentId: 'mount-bar',
      title: 'Remote private label', position: 'p2', revision: 'new-private', extensions: {},
      createdAt: snapshot.generatedAt, updatedAt: snapshot.generatedAt,
    }, { ...snapshot.nodes[2], parentId: 'private-folder' }],
    parentRevisions: [...snapshot.parentRevisions, { parentId: 'private-folder', childrenRevision: 'new-private-children' }],
  });
  try {
    assert.equal((await fixture.engine.wake('startup'))?.lastError, undefined);
    assert.equal(fixture.chromeNodes.get('3')?.title, 'Private label');
    assert.equal(fixture.chromeNodes.get('2')?.title, 'Before remote edit');
    assert.equal((await fixture.store.listBookmarkEventsByStatus(scope, 'pending', 0, 100)).length, 0);
  } finally { await fixture.store.close(); }
});
