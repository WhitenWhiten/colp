import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { projectVirtualSnapshotChildren, recoverSnapshotProjection } from '../src/recovery-projection-executor.js';
import { mappedSubtreeDeleteSource } from '../src/subtree-observation.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createProjectionSuppression } from '../src/recovery-overlay.js';

const scope: SyncScope = { environment: 'development', serverId: 'paused-delete', serverOrigin: 'https://known.example',
  accountId: 'owner', browserProfileId: 'browser', collectionId: 'collection', replicaId: 'replica', generation: 1 };

async function fixture(capture = true) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', selectedRoots: ['root'], rootStatus: 'ready',
    lease: { leaseId: 'lease', expiresAt: Date.now() + 3600000 }, checkpoint: { serverRevision: 'r1', cursor: 'c1' } });
  const rows: MappingInput[] = [
    { nativeId: '1', colpId: 'root', rootNativeId: '1', nodeKind: 'folder', rootRole: 'bookmarks-bar',
      projection: { revision: 'r1', digest: 'root', childrenRevision: 'cr1', content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } } },
    { nativeId: '2', colpId: 'folder', rootNativeId: '1', parentNativeId: '1', parentColpId: 'root', nodeKind: 'folder',
      projection: { revision: 'r2', digest: 'folder', childrenRevision: 'cr2', content: { title: 'Duplicate folder' } } },
    { nativeId: '3', colpId: 'child', rootNativeId: '1', parentNativeId: '2', parentColpId: 'folder', nodeKind: 'bookmark',
      projection: { revision: 'r3', digest: 'child', content: { title: 'Nested', url: 'https://nested.example/' } } },
  ];
  for (const row of rows) await store.putMapping(scope, row);
  await store.putMountBinding(scope, { mountId: 'bar', nativeRootId: '1', remoteMountNodeId: 'root', rootRole: 'bookmarks-bar',
    status: 'active', boundaryVersion: '1', materialized: true });
  await store.transitionEngine(scope, { phase: 'recovery', recoveryFrozen: true, authorityRefreshRequired: true, updatedAt: 1, notBefore: 0 });
  if (capture) await store.stageBookmarkEvent(scope, { eventId: 'local-delete', dedupeKey: 'delete-2', occurredAt: new Date().toISOString(),
    kind: 'remove', nativeId: '2', details: { draft: { type: 'delete_subtree', targetId: 'folder', baseRevision: 'r2',
      source: mappedSubtreeDeleteSource('folder', rows), payload: { reason: 'browser_event' } }, deleteNativeIds: ['2', '3'] } });
  const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
  const eventApi: BookmarkEventApi = {
    get: async id => (await chrome.api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async id => (await chrome.api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  };
  return { store, rows, chrome, eventApi };
}

for (const path of ['snapshot', 'virtual', 'verified'] as const) test(`${path} recovery preserves a paused local subtree deletion across store restart`, async () => {
  const f = await fixture();
  try {
    f.store.close();
    const staged = f.rows.map(row => ({ ...row, nativeId: `recovery:${row.colpId}`, rootNativeId: 'recovery:root' }));
    await f.store.stageRecoveryPage(scope, { snapshotId: 'snapshot', revision: 'r4', syncCursor: 'spc2.test',
      identityDigest: 'identity', rootNodeId: 'root', page: 0, pageDigest: 'page-0', previousPageDigest: null,
      nextCursor: null, complete: true, nodes: staged.map((mapping, index) => ({ colpId: mapping.colpId,
        parentId: mapping.parentColpId ?? null, position: String(index), kind: mapping.nodeKind === 'bookmark' ? 'Bookmark' : 'Folder',
        payloadDigest: mapping.projection.digest, mapping })) });
    const projected = path === 'snapshot'
      ? await recoverSnapshotProjection({ scope, store: f.store, staged: f.rows, api: f.chrome.api })
      : path === 'virtual' ? await projectVirtualSnapshotChildren({ scope, store: f.store, bound: [f.rows[0]!, ...staged.slice(1)], api: f.chrome.api })
        : await recoverVerifiedOrFreeze({ scope, store: f.store, staged, api: f.chrome.api, freezeUnprovenIdentity: true });
    assert.equal(f.chrome.creates, 0, 'a local delete must not be recreated from the remote snapshot');
    assert.equal(projected.find(row => row.colpId === 'root')?.nativeId, '1');
    for (const row of projected) assert.ok(!row.nativeId.startsWith('recovery:'), 'removed identities are retained without native creates');
    await f.store.finalizeRecoveryMappings(scope, 'snapshot', projected);
    await f.store.commitRecovery(scope, 'snapshot');
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 1, 'the delete remains available for upload');
    await f.store.transitionEngine(scope, { phase: 'sleeping', recoveryFrozen: false, authorityRefreshRequired: false, updatedAt: 2, notBefore: 0 });
    await createBookmarkEventQueue({ scope, store: f.store, api: f.eventApi, autoFlush: false }).flush();
    const queued = await f.store.listQueue(scope, 'pending');
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.payload.type, 'delete_subtree', 'the protected local deletion still uploads after recovery');
  } finally { f.store.close(); }
});

test('restart repairs a missed removal callback before a frozen Snapshot can recreate its subtree', async () => {
  const f = await fixture(false);
  try {
    f.store.close();
    const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.eventApi, autoFlush: false });
    await queue.captureMissingRemovals();
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
    await projectVirtualSnapshotChildren({ scope, store: f.store, bound: [f.rows[0]!, ...f.rows.slice(1)
      .map(row => ({ ...row, nativeId: `recovery:${row.colpId}` }))], api: f.chrome.api });
    assert.equal(f.chrome.creates, 0);
  } finally { f.store.close(); }
});

test('a failed native lookup is never treated as a local delete during recovery', async () => {
  const f = await fixture(false);
  try {
    const api = { ...f.eventApi, get: async () => { throw new Error('permission denied'); } };
    await assert.rejects(createBookmarkEventQueue({ scope, store: f.store, api, autoFlush: false }).captureMissingRemovals());
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

test('an interrupted pre-pause create intent cannot resurrect a folder with a newer local removal', async () => {
  const f = await fixture();
  try {
    await f.store.replaceProjectionIntents(scope, [{ intentId: 'create:folder', kind: 'create', colpId: 'folder', order: 1,
      generation: 1, state: 'pending', parentNativeId: '1', title: 'Duplicate folder', folder: true,
      suppression: createProjectionSuppression('1', 'Duplicate folder') }]);
    f.store.close();
    await projectVirtualSnapshotChildren({ scope, store: f.store, bound: f.rows, api: f.chrome.api });
    assert.equal(f.chrome.creates, 0);
    assert.equal((await f.store.listProjectionIntents(scope))[0]?.state, 'terminal');
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 1);
  } finally { f.store.close(); }
});

test('a newly observed cloud descendant stays a sidecar while the local subtree deletion awaits resolution', async () => {
  const f = await fixture();
  try {
    const incoming = [...f.rows, { nativeId: 'recovery:new-child', colpId: 'new-child', rootNativeId: '1',
      parentColpId: 'folder', nodeKind: 'bookmark' as const, projection: { revision: 'r4', digest: 'new-child',
        content: { title: 'Concurrent child', url: 'https://concurrent.example/' } } }];
    const projected = await projectVirtualSnapshotChildren({ scope, store: f.store, bound: incoming, api: f.chrome.api });
    assert.equal(f.chrome.creates, 0);
    assert.equal(projected.length, incoming.length, 'Snapshot finalization keeps a complete graph');
    assert.equal(projected.find(row => row.colpId === 'new-child')?.nativeId, 'sidecar:local-delete:new-child');
  } finally { f.store.close(); }
});
