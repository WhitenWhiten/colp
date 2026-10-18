import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { ack, json, scope, setup } from './durable-sync-engine-harness.js';

const stamp = { collectionId: scope.collectionId, createdAt: '2026-07-28T00:00:00Z',
  updatedAt: '2026-07-28T00:00:00Z', extensions: {} };

function snapshot(title = 'Child', newParent = false) {
  const root = { id: 'root-server', kind: 'root' as const, parentId: null, position: null,
    folderRole: 'root' as const, revision: 'revision-root', title: 'Engine', ...stamp };
  const mount = { id: 'mount-bar', kind: 'folder' as const, parentId: 'root-server', position: 'p1',
    folderRole: 'bookmarks-bar' as const, revision: 'revision-mount', title: 'Bar', ...stamp };
  const folderA = { id: 'folder-a', kind: 'folder' as const, parentId: 'mount-bar', position: 'p2',
    revision: 'revision-folder-a', title: 'A', ...stamp };
  const folderB = { id: 'folder-b', kind: 'folder' as const, parentId: 'mount-bar', position: 'p3',
    revision: 'revision-folder-b', title: 'B', ...stamp };
  const folderC = { id: 'folder-c', kind: 'folder' as const, parentId: 'mount-bar', position: 'p4',
    revision: 'revision-folder-c', title: 'C', ...stamp };
  const folderD = { id: 'folder-d', kind: 'folder' as const, parentId: 'mount-bar', position: 'p5',
    revision: 'revision-folder-d', title: 'D', ...stamp };
  const child = { id: 'child-a', kind: 'bookmark' as const, parentId: newParent ? 'folder-d' : 'folder-b', position: 'p6',
    revision: 'revision-child', title, url: 'https://example.test/child', ...stamp };
  return {
    protocolVersion: '0.2', snapshotId: 'snapshot-placement', mode: 'sync', complete: true,
    collection: { schemaVersion: '0.1', id: scope.collectionId, kind: 'bookmarks', title: 'Engine',
      rootNodeId: 'root-server', visibility: 'private', createdAt: stamp.createdAt,
      updatedAt: stamp.updatedAt, revision: 'revision-snapshot-placement', extensions: {} },
    nodes: [root, mount, folderA, folderB, folderC, ...(newParent ? [folderD] : []), child],
    annotations: [], attachments: [], relations: [], tombstones: [],
    revision: 'revision-snapshot-placement', syncCursor: 'placement-cursor', generatedAt: stamp.updatedAt,
    parentRevisions: [{ parentId: 'root-server', childrenRevision: 'children-root' },
      { parentId: 'mount-bar', childrenRevision: 'children-mount' },
      { parentId: 'folder-a', childrenRevision: 'children-a' },
      { parentId: 'folder-b', childrenRevision: 'children-b' },
      { parentId: 'folder-c', childrenRevision: 'children-c' },
      ...(newParent ? [{ parentId: 'folder-d', childrenRevision: 'children-d' }] : [])],
    page: { nextCursor: null, hasMore: false, sequence: 1 }, warnings: [],
    recoveryCapability: 'src1.recovery-capability',
  };
}

async function fixtureFor(options: { readonly localParent?: '2' | '5'; readonly title?: string; readonly newParent?: boolean } = {}) {
  const fixture = await setup({ snapshotRequired: true, emptyCollection: true, allowSnapshotMoves: true });
  await fixture.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: '1',
    remoteMountNodeId: 'mount-bar', boundaryVersion: '1', materialized: true,
    status: 'active', rootRole: 'bookmarks-bar' });
  await fixture.store.putMapping(scope, { nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder',
    parentColpId: 'root-server', rootRole: 'bookmarks-bar', mountId: 'mount-bar',
    projection: { revision: 'old-mount', digest: 'old-mount', childrenRevision: 'old-mount-children', content: { title: 'Bar' } } });
  for (const [nativeId, colpId, title, revision] of [
    ['2', 'folder-a', 'A', 'old-a'], ['3', 'folder-b', 'B', 'old-b'], ['5', 'folder-c', 'C', 'old-c'],
  ] as const) {
    await fixture.store.putMapping(scope, { nativeId, colpId, rootNativeId: '1', nodeKind: 'folder',
      parentColpId: 'mount-bar', parentNativeId: '1', mountId: 'mount-bar',
      projection: { revision, digest: revision, childrenRevision: `${revision}-children`, content: { title } } });
  }
  await fixture.store.putMapping(scope, { nativeId: '4', colpId: 'child-a', rootNativeId: '1', nodeKind: 'bookmark',
    parentColpId: 'folder-a', parentNativeId: '2', mountId: 'mount-bar',
    projection: { revision: 'old-child', digest: 'old-child', content: { title: 'Before', url: 'https://example.test/child' } } });
  fixture.chromeNodes.set('2', { id: '2', parentId: '1', title: 'A' });
  fixture.chromeNodes.set('3', { id: '3', parentId: '1', title: 'B' });
  fixture.chromeNodes.set('5', { id: '5', parentId: '1', title: 'C' });
  fixture.chromeNodes.set('4', { id: '4', parentId: options.localParent ?? '2', title: 'Before', url: 'https://example.test/child' });
  fixture.snapshotResponses.push(json(200, snapshot(options.title, options.newParent === true)));
  fixture.ackResponses.push(json(200, ack('placement-cursor')));
  const events = createBookmarkEventQueue({ scope, store: fixture.store, autoFlush: false,
    api: {
      async get(id) {
        const node = fixture.chromeNodes.get(id); if (!node) return [];
        const siblings = [...fixture.chromeNodes.values()].filter(item => item.parentId === node.parentId);
        return [{ ...node, title: node.title ?? '', index: siblings.findIndex(item => item.id === id) }];
      },
      async getChildren(id) { return [...fixture.chromeNodes.values()]
        .filter(node => node.parentId === id).map((node, index) => ({ ...node, title: node.title ?? '', index })); },
    } });
  return { fixture, events };
}

test('moves existing native bookmark to the remote parent and does not echo it on reconcile', async () => {
  const { fixture, events } = await fixtureFor({ title: 'Remote title' });
  try {
    assert.equal((await fixture.engine.wake('startup'))?.lastError, undefined);
    assert.equal(fixture.ackRequests.length, 1);
    assert.equal(fixture.chromeNodes.get('4')?.parentId, '3');
    assert.equal(fixture.chromeNodes.get('4')?.title, 'Remote title');
    const mapping = await fixture.store.getMappingByColpId(scope, 'child-a');
    assert.equal(mapping?.parentNativeId, '3');
    assert.equal(mapping?.projection.revision, 'revision-child');
    assert.equal(mapping?.projection.content?.title, 'Remote title');
    await events.recover();
    assert.equal((await fixture.store.listQueueByTarget(scope, 'child-a')).length, 0);
    assert.equal((await fixture.store.listBookmarkEventsByStatus(scope, 'pending', 0, 100)).length, 0);
  } finally { await fixture.store.close(); }
});

test('creates a remote parent before moving an existing native bookmark into it', async () => {
  const { fixture, events } = await fixtureFor({ newParent: true });
  try {
    assert.equal((await fixture.engine.wake('startup'))?.lastError, undefined);
    const parent = await fixture.store.getMappingByColpId(scope, 'folder-d');
    const child = await fixture.store.getMappingByColpId(scope, 'child-a');
    assert.ok(parent?.nativeId && !parent.nativeId.startsWith('recovery:'));
    assert.equal(child?.parentColpId, 'folder-d');
    assert.equal(child?.parentNativeId, parent?.nativeId);
    assert.equal(fixture.chromeNodes.get('4')?.parentId, parent?.nativeId);
    await events.recover();
    assert.equal((await fixture.store.listQueueByTarget(scope, 'child-a')).length, 0);
  } finally { await fixture.store.close(); }
});

test('replays a native move after the worker crashes after Chrome commit', async () => {
  const { fixture } = await fixtureFor();
  fixture.crashAt = 'after_snapshot_native_move';
  try {
    await assert.rejects(() => fixture.engine.wake('startup'), /worker_crash/);
    assert.equal(fixture.chromeNodes.get('4')?.parentId, '3');
    assert.equal(fixture.ackRequests.length, 0);
    assert.equal((await fixture.reopen().wake('startup'))?.lastError, undefined);
    assert.equal(fixture.ackRequests.length, 1);
    assert.equal(fixture.snapshotMoveCalls.length, 1);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'child-a'))?.parentNativeId, '3');
  } finally { await fixture.store.close(); }
});

for (const phase of ['inbox', 'queue', 'uncaptured'] as const) {
  test(`preserves a ${phase} local move Base while applying remote placement`, async () => {
    const { fixture, events } = await fixtureFor({ localParent: '5' });
    if (phase !== 'uncaptured') {
      assert.equal((await events.moved('4', { parentId: '5', index: 0, oldParentId: '2', oldIndex: 0 })).outcome, 'staged');
      if (phase === 'queue') await events.flush();
    }
    try {
      assert.equal((await fixture.engine.wake('startup'))?.lastError, undefined);
      assert.equal(fixture.chromeNodes.get('4')?.parentId, '3');
      const queueBeforeRecover = await fixture.store.listQueueByTarget(scope, 'child-a');
      const inboxBeforeRecover = await fixture.store.listBookmarkEventsByStatus(scope, 'pending', 0, 100);
      if (phase === 'queue') assert.equal(queueBeforeRecover[0]?.baseRevision, 'old-child');
      if (phase === 'inbox') assert.equal((inboxBeforeRecover[0]?.details.mapping as any)?.parentNativeId, '5');
      if (phase === 'uncaptured') assert.equal((inboxBeforeRecover[0]?.details.mapping as any)?.parentNativeId, '5');
      await events.recover();
      const queueAfterRecover = await fixture.store.listQueueByTarget(scope, 'child-a');
      assert.equal(queueAfterRecover.length, 1);
      assert.equal(queueAfterRecover[0]?.baseRevision, 'old-child');
      assert.equal((await fixture.store.getMappingByColpId(scope, 'child-a'))?.parentNativeId, '3');
    } finally { await fixture.store.close(); }
  });
}

test('does not suppress a user move callback whose destination differs from the projection intent', async () => {
  const { fixture, events } = await fixtureFor();
  await fixture.store.replaceProjectionIntents(scope, [{ intentId: 'move:child-a', kind: 'move', colpId: 'child-a',
    order: 1, nativeId: '4', parentColpId: 'folder-b', parentNativeId: '3', index: 0,
    suppression: 'recovery:move:child-a', generation: scope.generation, state: 'pending' }]);
  try {
    assert.equal((await events.moved('4', { parentId: '5', index: 0, oldParentId: '2', oldIndex: 0 })).outcome, 'staged');
    assert.equal((await fixture.store.listBookmarkEventsByStatus(scope, 'pending', 0, 100)).length, 1);
  } finally { await fixture.store.close(); }
});

test('an unproven local placement stays one issue across Snapshot cutover and the next worker wake', async () => {
  const { fixture } = await fixtureFor();
  try {
    fixture.chromeNodes.set('6', { id: '6', parentId: '1', title: 'Unmapped local folder' });
    fixture.chromeNodes.set('4', { ...fixture.chromeNodes.get('4')!, parentId: '6' });
    fixture.snapshotResponses.pop();
    const incoming = snapshot(); incoming.nodes.find(node => node.id === 'folder-c')!.title = 'Independent remote folder';
    fixture.snapshotResponses.push(json(200, incoming));
    await fixture.engine.wake('manual');
    assert.equal((await fixture.store.listLocalIssues(scope))[0]?.nativeId, '4');
    assert.equal(fixture.chromeNodes.get('4')?.parentId, '6');
    assert.equal(fixture.chromeNodes.get('5')?.title, 'Independent remote folder');
    fixture.clock.now += 30_000; await fixture.reopen().wake('startup');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, false);
  } finally { fixture.store.close(); }
});
