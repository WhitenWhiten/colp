import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { fixture, scope, bookmark } from './bookmark-event-queue-harness.js';
import { previewRangeChange, releaseReincludedPrivateMappings } from '../src/scope-range.js';
import { executeRemoteDelete, frozenRemoteDeleteCommand } from '../src/scope-commands.js';
import { applyRemoteDeletion } from '../src/pull-delete-apply.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { repairTombstonedNativeMappings } from '../src/tombstone-mapping-repair.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import type { PullBookmarkApi } from '../src/pull-applier-types.js';

const discovered = [{ nativeId: 'root-selected', ancestorNativeIds: [] },
  { nativeId: 'folder-parent', ancestorNativeIds: ['root-selected'] },
  { nativeId: 'child', ancestorNativeIds: ['root-selected', 'folder-parent'] }];
const roots: NormalizedBookmarkRoot[] = [{ nativeId: 'root-selected', title: 'Bar', kind: 'folder', managed: false,
  rootKind: 'bookmarks_bar', children: [{ nativeId: 'folder-parent', title: 'Folder', kind: 'folder', managed: false,
    children: [{ nativeId: 'child', title: 'Child', kind: 'bookmark', url: 'https://example.test/child', managed: false, children: [] }] }] }];

test('a nested folder can be trashed remotely without detaching its browser root, then included as fresh identities', async () => {
  const { store, api, queue } = await fixture(new IDBFactory());
  await store.setFirstRun(scope, 'completed');
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: [], status: 'ready' });
  const bar = (await store.getMappingByNativeId(scope, 'root-selected'))!;
  await store.putMountBinding(scope, { mountId: 'bar', nativeRootId: 'root-selected', remoteMountNodeId: bar.colpId,
    rootRole: 'bookmarks-bar', status: 'active', boundaryVersion: '1', materialized: true });
  await store.putMapping(scope, { nativeId: 'folder-parent', colpId: 'folder-colp', rootNativeId: 'root-selected',
    nodeKind: 'folder', parentNativeId: 'root-selected', parentColpId: bar.colpId,
    projection: { revision: 'folder-r1', childrenRevision: 'folder-c1', digest: 'd', content: { title: 'Folder' } } });
  api.put(bookmark('child', 'folder-parent', 0, 'Child', 'https://example.test/child'));
  await store.putMapping(scope, { nativeId: 'child', colpId: 'child-colp', rootNativeId: 'root-selected',
    nodeKind: 'bookmark', parentNativeId: 'folder-parent', parentColpId: 'folder-colp',
    projection: { revision: 'child-r1', digest: 'd', content: { title: 'Child', url: 'https://example.test/child' } } });
  const { preview, diff } = await previewRangeChange(store, scope, { roots, selectedNativeIds: ['root-selected'], privateNativeIds: ['folder-parent'] });
  assert.deepEqual(diff.removedNativeIds, ['folder-parent']);
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: ['folder-parent'], status: 'ready' });
  const command = frozenRemoteDeleteCommand(preview, 'folder-parent')!;
  assert.equal((await executeRemoteDelete(store, scope, command)).ok, true);
  await executeRemoteDelete(store, scope, command);
  const [queued] = await store.listQueue(scope); assert.ok(queued);
  assert.equal((await store.listQueue(scope)).length, 1);
  assert.equal(queued.payload.type, 'delete_subtree'); assert.equal(queued.payload.targetId, 'folder-colp');
  assert.equal((await store.getMountBinding(scope, 'bar'))!.status, 'active');
  await assert.rejects(previewRangeChange(store, scope, { roots, selectedNativeIds: ['root-selected'], privateNativeIds: [] }), /sync_busy/);
  const deletes: string[] = [];
  const native: PullBookmarkApi = { ...api, async create() { throw new Error('unexpected create') },
    async update() { throw new Error('unexpected update') }, async move() { throw new Error('unexpected move') },
    async remove(id) { deletes.push(id) }, async removeTree(id) { deletes.push(id) } };
  const event = pullFixtures.subtreeEvent({ sequence: 1, collectionId: scope.collectionId, targetId: 'folder-colp', members: ['folder-colp', 'child-colp'], paged: false });
  const applied = await applyRemoteDeletion({ store, scope, api: native, event, eventId: 'private-delete', now: 1,
    mounts: await store.listMountBindings(scope), requireMapping: async id => (await store.getMappingByColpId(scope, id))!,
    parentRevisionMapping: async () => bar });
  assert.deepEqual(deletes, []); assert.deepEqual(applied.deleteNativeIds, []);
  for (const row of applied.observations) await store.putRemoteObservation(scope, row);
  await repairTombstonedNativeMappings(store, scope, native);
  assert.equal((await store.getMappingByNativeId(scope, 'folder-parent'))?.colpId, 'folder-colp');
  assert.equal(await store.getLocalSyncExclusion(scope, 'folder-parent'), null);
  // Explicit re-inclusion releases the proven tombstones and keeps every native bookmark.
  await releaseReincludedPrivateMappings(store, scope, { previousPrivateRoots: (await store.getScope(scope))!.privateRoots!,
    privateNativeIds: [], discovered: new Map(discovered.map(row => [row.nativeId, row.ancestorNativeIds])) });
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: [], status: 'ready' });
  await queue.recover();
  const events = await store.listBookmarkEvents(scope);
  assert.ok(events.some(row => row.nativeId === 'folder-parent' && row.kind === 'create'));
  assert.ok(events.some(row => row.nativeId === 'child' && row.kind === 'create'));
  assert.equal((await store.getMountBinding(scope, 'bar'))!.status, 'active');
  assert.equal(api.node('folder-parent').id, 'folder-parent'); assert.equal(api.node('child').id, 'child');
});

test('including a folder excluded on first run releases its local-only placeholder identity', async () => {
  const { store } = await fixture(new IDBFactory());
  await store.deleteMapping(scope, 'folder-parent');
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: ['folder-parent'], status: 'ready' });
  assert.equal((await store.getMappingByNativeId(scope, 'folder-parent'))!.projection.revision, 'local-root');
  await releaseReincludedPrivateMappings(store, scope, { previousPrivateRoots: (await store.getScope(scope))!.privateRoots!,
    privateNativeIds: [], discovered: new Map(discovered.map(row => [row.nativeId, row.ancestorNativeIds])) });
  assert.equal(await store.getMappingByNativeId(scope, 'folder-parent'), null);
});

async function nestedDeletePreview() {
  const { store } = await fixture(new IDBFactory());
  await store.setFirstRun(scope, 'completed');
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: [], status: 'ready' });
  const parent = (await store.getMappingByNativeId(scope, 'folder-parent'))!;
  const { scopeKey: _scopeKey, ...parentInput } = parent;
  await store.putMapping(scope, { ...parentInput, nodeKind: 'folder' });
  const { preview } = await previewRangeChange(store, scope, { roots, selectedNativeIds: ['root-selected'], privateNativeIds: ['folder-parent'] });
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: ['folder-parent'], status: 'ready' });
  return { store, command: frozenRemoteDeleteCommand(preview, 'folder-parent')! };
}

test('nested trash refuses a changed command token and a folder that was included again', async () => {
  const { store, command } = await nestedDeletePreview();
  assert.deepEqual(await executeRemoteDelete(store, scope, { ...command, confirmationToken: 'wrong' }), { ok: false, error: 'preview_stale' });
  await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['root-selected'], privateNativeIds: [], status: 'ready' });
  assert.deepEqual(await executeRemoteDelete(store, scope, command), { ok: false, error: 'preview_stale' });
  assert.equal((await store.listQueue(scope)).length, 0);
});

test('root trash refuses a changed mount boundary before authoring any child deletes', async () => {
  const { store } = await fixture(new IDBFactory());
  const root = (await store.getMappingByNativeId(scope, 'root-selected'))!;
  await store.putMountBinding(scope, { mountId: 'bar', nativeRootId: 'root-selected', remoteMountNodeId: root.colpId,
    rootRole: 'bookmarks-bar', status: 'active', boundaryVersion: '1', materialized: false });
  await store.setFirstRun(scope, 'completed');
  const { preview } = await previewRangeChange(store, scope, { roots, selectedNativeIds: [] });
  const command = frozenRemoteDeleteCommand(preview, 'root-selected')!;
  const mount = (await store.getMountBinding(scope, 'bar'))!;
  await store.putMountBinding(scope, { ...mount, boundaryVersion: 'changed' });
  assert.deepEqual(await executeRemoteDelete(store, scope, command), { ok: false, error: 'preview_stale' });
  assert.equal((await store.listQueue(scope)).length, 0);
});
