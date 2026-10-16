import { executeRemoteDelete } from './remote-delete-preview-harness.js';
/**
 * F002 (T-03 round 2): the remote-mount delete path (`executeRemoteDelete`)
 * selects the wire operation from the target node's own kind — never from the
 * frozen `affectedCount`, which is only preview/token/confirmation evidence.
 *
 * The acceptance probe for T-03 round 1 enqueued
 * `{"type":"delete_node","targetId":"remote-bar","targetKind":"folder"}` for a
 * mount root that a *complete* staged snapshot proved to be an empty folder.
 * The server permanently refuses a single delete of a non-empty folder
 * (`invalid_document`, 422), so any count-derived `delete_node` for a folder is
 * the original F002 hazard — the local mapping is already gone by the time the
 * refusal lands.
 *
 * Every case below drives the production entry `executeRemoteDelete(...)`; the
 * first one goes through the real range-confirm freeze (`previewRangeChange` →
 * `frozenRemoteDeleteCommand`) and reproduces the acceptance probe. Each case
 * pins the queued type to `translateSyncBrowserDelete` for the same kind.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';
import { validateOperation } from '../src/bookmark-event-codec.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import {
  countMountAffected, frozenRemoteDeleteCommand, mintRemoteDeleteConfirmation,
} from '../src/scope-commands.js';
import { previewRangeChange } from '../src/scope-range.js';
import { createSyncStateStore, type MappingInput, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'production', serverId: 'server-rd-kind', serverOrigin: 'https://known.example',
  accountId: 'account-rd-kind', browserProfileId: 'profile-rd-kind',
  collectionId: 'collection-rd-kind', replicaId: 'replica-rd-kind', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

/** The authoritative protocol translation for the same target node. */
function protocolType(nodeId: string, nodeKind: 'folder' | 'bookmark' | 'separator'): string {
  return translateSyncBrowserDelete({ nodeId, nodeKind }).type;
}

test('acceptance repro: a complete snapshot proving the mount folder is empty still emits delete_subtree', async () => {
  const store = await boundStore();
  await stageCompleteSnapshot(store, [
    snapshotNode('folder-root', null, 'Folder'),
    snapshotNode('remote-bar', 'folder-root', 'Folder'),
  ]);
  // The user leaves the scope through the real preview → frozen range-confirm token.
  const { preview, diff } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: [] });
  assert.ok(diff.removedNativeIds.includes('bar') || diff.shiftNativeIds.includes('bar'));
  const frozen = frozenRemoteDeleteCommand(preview, 'bar');
  assert.ok(frozen);
  assert.equal(frozen.affectedCount, 0, 'the complete snapshot proves there are no remote descendants');
  const result = await executeRemoteDelete(store, scope, frozen);
  assert.equal(result.ok, true);
  const rows = await store.listQueue(scope);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payload.targetId, 'remote-bar');
  assert.equal(rows[0]!.payload.type, 'delete_subtree');
  assert.equal(rows[0]!.payload.type, protocolType('remote-bar', 'folder'));
  assert.equal(validateOperation(rows[0]!.payload), true);
  const mount = await store.getMountBinding(scope, 'mount-bar');
  assert.equal(mount?.status, 'detached');
});

test('a mount folder proven only by the durable mapping (no complete snapshot) emits delete_subtree', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'unmounted:colp-one', colpId: 'colp-one', parentColpId: 'remote-bar', nodeKind: 'bookmark',
    revision: 'r-one',
  });
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 1);
  const queued = await executeTyped(store, 1);
  assert.equal(queued.payload.type, 'delete_subtree');
  assert.equal(queued.payload.type, protocolType('remote-bar', 'folder'));
});

test('an unproven root revision refuses subtree deletion even when affectedCount > 0', async () => {
  // The snapshot proves one remote descendant but carries no row for the mount
  // root itself, and no durable mapping proves the root either. The kind is
  // unknown, so the shape must take the direction the server always accepts for
  // a folder instead of the count-derived `delete_node`.
  const store = await boundStore({ includeMountMapping: false });
  await stageCompleteSnapshot(store, [
    snapshotNode('folder-root', null, 'Folder'),
    snapshotNode('child-1', 'remote-bar', 'Bookmark'),
  ]);
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 1);
  const result = await executeRemoteDelete(store, scope, { mountId: 'mount-bar', affectedCount: 1,
    confirmationToken: mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: 1, boundaryVersion: '1' }) });
  assert.equal(result.ok, false);
  assert.equal((await store.listQueue(scope)).length, 0);
});

test('control: the same affectedCount=0 with a bookmark-proven target emits delete_node', async () => {
  // Proves the selection follows kind evidence rather than "always subtree" or
  // the frozen count: `affectedCount === 0` yields `delete_subtree` for a folder
  // (first test) and `delete_node` for a proven non-folder here.
  const store = await boundStore({ includeMountMapping: false });
  await stageCompleteSnapshot(store, [
    snapshotNode('folder-root', null, 'Folder'),
    snapshotNode('remote-bar', 'folder-root', 'Bookmark'),
  ]);
  assert.equal(await countMountAffected(store, scope, 'mount-bar'), 0);
  const queued = await executeTyped(store, 0);
  assert.equal(queued.payload.type, 'delete_node');
  assert.equal(queued.payload.type, protocolType('remote-bar', 'bookmark'));
});

async function boundStore(options: { includeMountMapping?: boolean } = {}) {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], firstRun: 'completed',
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

async function executeTyped(store: ReturnType<typeof createSyncStateStore>, affectedCount: number): Promise<QueueOperation> {
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
    snapshotId: 'snap-rd-kind', revision: 'r-snap', syncCursor: 'spc2.rd', identityDigest: 'identity-rd',
    rootNodeId: 'folder-root', page: 0, pageDigest: 'sha256:rd', previousPageDigest: null, nextCursor: null,
    complete: true, nodes,
  });
}

function tree(): readonly NormalizedBookmarkRoot[] {
  return [{ nativeId: 'bar', title: 'Bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [] }];
}
