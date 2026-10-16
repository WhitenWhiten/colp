import { executeRemoteDelete } from './remote-delete-preview-harness.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';
import { validateOperation } from '../src/bookmark-event-codec.js';
import { countMountAffected, mintRemoteDeleteConfirmation } from '../src/scope-commands.js';
import { removalCounts } from '../src/scope-range.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { isProtocolOpaqueId } from '../src/protocol-id.js';

const scope: SyncScope = {
  environment: 'production', serverId: 'server-frr04', serverOrigin: 'https://known.example',
  accountId: 'account-frr04', browserProfileId: 'profile-frr04', collectionId: 'collection-frr04',
  replicaId: 'replica-frr04', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('FRR-04-A: remote-delete stamps a valid Wire Operation and uses delete_subtree for a nonempty folder', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', parentNativeId: 'bar', nodeKind: 'bookmark', revision: 'r-bm',
  });
  const count = await countMountAffected(store, scope, 'mount-bar');
  assert.equal(count, 1);
  const token = mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: count, boundaryVersion: '1' });
  const first = await executeRemoteDelete(store, scope, {
    mountId: 'mount-bar', affectedCount: count, confirmationToken: token,
  });
  assert.equal(first.ok, true);
  const queued = (await store.listQueue(scope))[0]!;
  assert.equal(validateOperation(queued.payload), true);
  assert.equal(queued.payload.type, 'delete_subtree');
  assert.equal(queued.payload.replicaId, scope.replicaId);
  assert.equal(queued.payload.collectionId, scope.collectionId);
  assert.equal(queued.payload.sequence, queued.sequence);
  assert.equal(queued.payload.opId, queued.opId);
  assert.equal(isProtocolOpaqueId(queued.opId), true);
  assert.equal(queued.opId.includes(':'), false);
  const second = await executeRemoteDelete(store, scope, {
    mountId: 'mount-bar', affectedCount: count, confirmationToken: token,
  });
  assert.equal(second.ok, true);
  assert.equal((await store.listQueue(scope)).length, 1);
  assert.equal((await store.listQueue(scope))[0]!.opId, queued.opId);
});

test('bound mount with no remote mapping cannot prove an empty remote folder', async () => {
  const store = await boundStore({ includeMountMapping: false });
  await assert.rejects(() => countMountAffected(store, scope, 'mount-bar'), /remote_subtree_unknown/);
  const rejected = await executeRemoteDelete(store, scope, {
    mountId: 'mount-bar', affectedCount: 0,
    confirmationToken: mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: 0, boundaryVersion: '1' }),
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, 'remote_subtree_unknown');
  assert.equal((await store.listQueue(scope)).length, 0);
  assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
});

test('1 remote child without a local Chrome mapping enqueues delete_subtree', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'unmounted:colp-one', colpId: 'colp-one', parentColpId: 'remote-bar', nodeKind: 'bookmark',
    revision: 'r-one',
  });
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 1);
  assert.equal((await executeTyped(store, 1)).payload.type, 'delete_subtree');
});

test('many remote children without local Chrome mappings enqueue delete_subtree', async () => {
  const store = await boundStore();
  for (const id of ['a', 'b', 'c']) {
    await putRemoteMapping(store, {
      nativeId: `unmounted:colp-${id}`, colpId: `colp-${id}`, parentColpId: 'remote-bar', nodeKind: 'bookmark',
      revision: `r-${id}`,
    });
  }
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 3);
  assert.equal((await executeTyped(store, 3)).payload.type, 'delete_subtree');
});

test('local mapping count 0 + complete snapshot with children uses the snapshot count', async () => {
  const store = await boundStore();
  await stageCompleteSnapshot(store, [
    snapshotNode('folder-root', null, 'Folder'),
    snapshotNode('remote-bar', 'folder-root', 'Folder'),
    snapshotNode('child-1', 'remote-bar', 'Bookmark'),
    snapshotNode('child-2', 'remote-bar', 'Folder'),
    snapshotNode('child-2a', 'child-2', 'Bookmark'),
  ]);
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 3);
  assert.equal((await removalCounts(store, scope, ['bar'])).get('bar'), 3);
  assert.equal((await executeTyped(store, 3)).payload.type, 'delete_subtree');
});

test('complete snapshot with only the mount node is an empty remote folder and still uses delete_subtree', async () => {
  // F002: the target is the mount root, which is a folder by construction, and a
  // complete snapshot only proves it was empty at snapshot time. A count-derived
  // `delete_node` would be permanently refused by the server once a remote child
  // appears after the snapshot, so the shape must follow the target kind.
  const store = await boundStore({ includeMountMapping: false });
  await stageCompleteSnapshot(store, [
    snapshotNode('folder-root', null, 'Folder'),
    snapshotNode('remote-bar', 'folder-root', 'Folder'),
  ]);
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 0);
  const queued = await executeTyped(store, 0);
  assert.equal(queued.payload.type, 'delete_subtree');
  assert.equal(queued.payload.targetId, 'remote-bar');
  // F117 parity: the plugin and the protocol agree for the same folder target.
  assert.equal(queued.payload.type, translateSyncBrowserDelete({ nodeId: 'remote-bar', nodeKind: 'folder' }).type);
});

test('UI/token using a local undercount against remote 5 is confirmation_mismatch', async () => {
  const store = await boundStore();
  await stageCompleteSnapshot(store, [
    snapshotNode('folder-root', null, 'Folder'),
    snapshotNode('remote-bar', 'folder-root', 'Folder'),
    ...['1', '2', '3', '4', '5'].map((id) => snapshotNode(`child-${id}`, 'remote-bar', 'Bookmark')),
  ]);
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 5);
  const localUndercount = 0;
  const token = mintRemoteDeleteConfirmation({
    mountId: 'mount-bar', affectedCount: localUndercount, boundaryVersion: '1',
  });
  const rejected = await executeRemoteDelete(store, scope, {
    mountId: 'mount-bar', affectedCount: localUndercount, confirmationToken: token,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, 'confirmation_mismatch');
  assert.equal((await store.listQueue(scope)).length, 0);
  assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
});

test('placement observations in the mount subtree count as remote members', async () => {
  const store = await boundStore();
  await store.putRemoteObservation(scope, {
    colpId: 'obs-child', remoteRevision: 'r-obs', cursor: 'c-obs', kind: 'placement',
    payload: { parentId: 'remote-bar' }, sourceDigest: 'sha256:obs', observedAt: 1,
  });
  await store.putRemoteObservation(scope, {
    colpId: 'obs-nested', remoteRevision: 'r-obs-2', cursor: 'c-obs-2', kind: 'placement',
    payload: { parentId: 'obs-child' }, sourceDigest: 'sha256:obs-2', observedAt: 2,
  });
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 2);
  assert.equal((await executeTyped(store, 2)).payload.type, 'delete_subtree');
});

test('pending local creates are not remote members; bound mount with no remote facts fails closed', async () => {
  const pendingOnly = await boundStore({ includeMountMapping: false });
  await pendingOnly.putMapping(scope, {
    nativeId: 'bm-new', colpId: 'pending-op-1', rootNativeId: 'bar', mountId: 'mount-bar', parentNativeId: 'bar',
    nodeKind: 'bookmark', projection: { revision: 'local-op-1', digest: 'sha256:pending' },
  });
  await assert.rejects(() => countMountAffected(pendingOnly, scope, 'mount-bar'), /remote_subtree_unknown/);
  const rejected = await executeRemoteDelete(pendingOnly, scope, {
    mountId: 'mount-bar', affectedCount: 0,
    confirmationToken: mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: 0, boundaryVersion: '1' }),
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, 'remote_subtree_unknown');
  assert.equal((await pendingOnly.listQueue(scope)).length, 0);
  assert.equal((await pendingOnly.getMountBinding(scope, 'mount-bar'))?.status, 'active');
});

test('unbound mount is mount_not_bound and does not enqueue', async () => {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [],
  });
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: null, boundaryVersion: '1',
    materialized: false, status: 'active', customSourceKey: 'folder:ordinary',
  });
  const rejected = await executeRemoteDelete(store, scope, {
    mountId: 'mount-bar', affectedCount: 0,
    confirmationToken: mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: 0, boundaryVersion: '1' }),
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error, 'mount_not_bound');
  assert.equal((await store.listQueue(scope)).length, 0);
});

async function boundStore(options: { includeMountMapping?: boolean } = {}) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [],
  });
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', boundaryVersion: '1',
    materialized: false, status: 'active', customSourceKey: 'folder:ordinary',
  });
  if (options.includeMountMapping !== false) {
    await store.putMapping(scope, {
      nativeId: 'bar', colpId: 'remote-bar', rootNativeId: 'bar', mountId: 'mount-bar', nodeKind: 'folder',
      projection: { revision: 'r-bar', digest: 'sha256:bar' },
    });
  }
  return store;
}

async function putRemoteMapping(store: ReturnType<typeof createSyncStateStore>, input: {
  readonly nativeId: string; readonly colpId: string; readonly nodeKind: MappingInput['nodeKind'];
  readonly revision: string; readonly parentNativeId?: string; readonly parentColpId?: string;
}) {
  await store.putMapping(scope, {
    nativeId: input.nativeId, colpId: input.colpId, rootNativeId: 'bar', mountId: 'mount-bar',
    nodeKind: input.nodeKind, projection: { revision: input.revision, digest: `sha256:${input.colpId}` },
    ...(input.parentNativeId ? { parentNativeId: input.parentNativeId } : {}),
    ...(input.parentColpId ? { parentColpId: input.parentColpId } : {}),
  });
}

async function executeTyped(store: ReturnType<typeof createSyncStateStore>, affectedCount: number) {
  const token = mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount, boundaryVersion: '1' });
  const result = await executeRemoteDelete(store, scope, {
    mountId: 'mount-bar', affectedCount, confirmationToken: token,
  });
  assert.equal(result.ok, true);
  const queued = (await store.listQueue(scope))[0]!;
  assert.equal(validateOperation(queued.payload), true);
  return queued;
}

function snapshotNode(colpId: string, parentId: string | null, kind: 'Folder' | 'Bookmark') {
  return { colpId, parentId, position: colpId, kind, payloadDigest: `sha256:${colpId}` };
}

async function stageCompleteSnapshot(
  store: ReturnType<typeof createSyncStateStore>,
  nodes: ReturnType<typeof snapshotNode>[],
) {
  await store.stageRecoveryPage(scope, {
    snapshotId: 'snap-rd', revision: 'r-snap', syncCursor: 'spc2.rd', identityDigest: 'identity-rd',
    rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:rd', previousPageDigest: null, nextCursor: null,
    complete: true, nodes,
  });
}
