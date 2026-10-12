import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { previewBatch, type BatchChromeNode } from '../src/bookmark-batch-plan.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { createMemoryBookmarks, parkRemoteDeleteNative } from './bookmark-batch-memory.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-batch', serverOrigin: 'https://known.example',
  accountId: 'account-batch', browserProfileId: 'profile-batch', collectionId: 'collection-batch',
  replicaId: 'replica-batch', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('bookmark batch preview negatives', () => {
  test('rejects an empty batch', async () => {
    const { store, api } = await setup();
    await assert.rejects(() => previewBatch({ store, scope, api, kind: 'delete', nativeIds: [] }), /empty_batch/);
  });

  test('blocks protected roots, managed nodes, and missing ids', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bar', 'managed', 'missing'] });
    assert.equal(preview.items.every((item) => item.blocked), true);
    assert.equal(preview.items.find((item) => item.nativeId === 'bar')?.blocked, 'protected_root');
    assert.equal(preview.items.find((item) => item.nativeId === 'managed')?.blocked, 'managed');
    assert.equal(preview.items.find((item) => item.nativeId === 'missing')?.blocked, 'missing');
  });

  test('flags a cross-boundary move and requires a second confirm', async () => {
    const { store, api } = await setup();
    const preview = await previewBatch({
      store, scope, api, kind: 'move', nativeIds: ['bm-1'], targetParentId: 'other',
    });
    assert.equal(preview.crossBoundary, true);
    assert.equal(preview.requiresSecondConfirm, true);
    assert.equal(preview.items[0]?.blocked, undefined);
  });

  test('delete always requires a second confirm and rename requires titles', async () => {
    const { store, api } = await setup();
    const deleted = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    assert.equal(deleted.requiresSecondConfirm, true);
    const untitled = await previewBatch({ store, scope, api, kind: 'rename', nativeIds: ['bm-1'] });
    assert.equal(untitled.items[0]?.blocked, 'rename_title_required');
  });

  test('parked remote-delete natives are blocked at preview', async () => {
    const { store, api } = await setup();
    await parkRemoteDeleteNative(store, scope, 'bm-1');
    const preview = await previewBatch({ store, scope, api, kind: 'delete', nativeIds: ['bm-1'] });
    assert.equal(preview.items[0]?.blocked, 'remote_delete_pending');
  });

  test('rename basis ignores the edited title but still includes live mapping revision', async () => {
    const { store, api } = await setup();
    const initial = await previewBatch({ store, scope, api, kind: 'rename', nativeIds: ['bm-1'], titles: { 'bm-1': 'One' } });
    const edited = await previewBatch({ store, scope, api, kind: 'rename', nativeIds: ['bm-1'], titles: { 'bm-1': 'Edited' } });
    assert.notEqual(initial.digest, edited.digest); assert.equal(initial.basisDigest, edited.basisDigest);
    const mapping = (await store.getMappingByNativeId(scope, 'bm-1'))!;
    await store.putMapping(scope, { nativeId: mapping.nativeId, colpId: mapping.colpId, rootNativeId: mapping.rootNativeId,
      nodeKind: 'bookmark', parentNativeId: 'bar', projection: { revision: 'rev-2', digest: 'sha256:two' } });
    const changed = await previewBatch({ store, scope, api, kind: 'rename', nativeIds: ['bm-1'], titles: { 'bm-1': 'Edited' } });
    assert.notEqual(initial.basisDigest, changed.basisDigest); store.close();
  });
});

async function setup(tree?: BatchChromeNode) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-batch', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: ['bar'], privateRoots: ['other'],
    boundaryVersion: '1',
  });
  await store.putMapping(scope, {
    nativeId: 'bar', colpId: 'folder-bar', rootNativeId: 'bar', nodeKind: 'folder',
    projection: { revision: 'rev-bar', digest: 'sha256:bar' },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-1', colpId: 'node-1', rootNativeId: 'bar', nodeKind: 'bookmark', parentNativeId: 'bar',
    projection: { revision: 'rev-1', digest: 'sha256:one' },
  });
  return { store, api: createMemoryBookmarks(tree) };
}
