import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, test } from 'vitest';
import { validateOperation } from '../src/bookmark-event-codec.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { isProtocolOpaqueId } from '../src/protocol-id.js';
import {
  executeRemoteDelete, frozenRemoteDeleteCommand, mintRemoteDeleteConfirmation,
} from '../src/scope-commands.js';
import { previewRangeChange } from '../src/scope-range.js';
import { previewHasTitlesOrUrls } from '../src/sync-state/mount-repository.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = {
  environment: 'production', serverId: 'server-frr04-freeze', serverOrigin: 'https://known.example',
  accountId: 'account-frr04-freeze', browserProfileId: 'profile-frr04-freeze',
  collectionId: 'collection-frr04-freeze', replicaId: 'replica-frr04-freeze', generation: 1,
};

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

test('FRR-04.3: preview freezes affectedCount=N and growth cannot enlarge the token', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', parentNativeId: 'bar', nodeKind: 'bookmark', revision: 'r-bm',
  });
  const { preview, diff } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: [] });
  assert.ok(diff.removedNativeIds.includes('bar') || diff.shiftNativeIds.includes('bar'));
  const frozen = frozenRemoteDeleteCommand(preview, 'bar');
  assert.ok(frozen);
  assert.equal(frozen.affectedCount, 1);
  assert.equal(preview.remoteDeleteEvidence?.[0]?.affectedCount, 1);
  assert.equal(preview.remoteDeleteEvidence?.[0]?.mountId, 'mount-bar');
  assert.equal(preview.remoteDeleteEvidence?.[0]?.remoteMountNodeId, 'remote-bar');
  assert.equal(previewHasTitlesOrUrls(preview), false);
  assert.doesNotMatch(JSON.stringify(preview), /"title"|"url"/u);
  const stored = await store.getScopePreview(scope, preview.previewId);
  assert.equal(stored?.remoteDeleteEvidence?.[0]?.affectedCount, 1);

  await putRemoteMapping(store, {
    nativeId: 'unmounted:colp-new', colpId: 'colp-new', parentColpId: 'remote-bar', nodeKind: 'bookmark',
    revision: 'r-new',
  });
  const grown = await executeRemoteDelete(store, scope, frozen);
  assert.equal(grown.ok, false);
  if (!grown.ok) assert.equal(grown.error, 'preview_stale');
  assert.equal((await store.listQueue(scope)).length, 0);
  assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');

  const recast = mintRemoteDeleteConfirmation({
    mountId: frozen.mountId, affectedCount: 2, boundaryVersion: '1',
  });
  const enlarged = await executeRemoteDelete(store, scope, {
    ...frozen, affectedCount: 2, confirmationToken: recast,
  });
  assert.equal(enlarged.ok, false);
  if (!enlarged.ok) assert.ok(enlarged.error === 'confirmation_mismatch' || enlarged.error === 'preview_stale');
  const afterRecast = await store.listQueue(scope);
  assert.equal(afterRecast.length, 0, 'an enlarged recast must not enqueue any operation');
  // F117: the old `notEqual(queue[0]?.payload.type, 'delete_subtree')` compared
  // `undefined` whenever the queue was empty, so it could never fail. Assert the
  // exact queued type set instead: any enqueued operation regresses this.
  assert.deepEqual(afterRecast.map((row) => row.payload.type), [],
    'an enlarged recast must enqueue neither delete_node nor delete_subtree');
});

test('FRR-04.3: an enlarged recast is refused without appending a second delete row', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', parentNativeId: 'bar', nodeKind: 'bookmark', revision: 'r-bm',
  });
  const { preview } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: [] });
  const command = frozenRemoteDeleteCommand(preview, 'bar');
  assert.ok(command);
  const accepted = await executeRemoteDelete(store, scope, command);
  assert.equal(accepted.ok, true);
  const queued = await store.listQueue(scope);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.payload.type, 'delete_subtree');
  const recast = mintRemoteDeleteConfirmation({
    mountId: command.mountId, affectedCount: 2, boundaryVersion: '1',
  });
  const enlarged = await executeRemoteDelete(store, scope, {
    ...command, affectedCount: 2, confirmationToken: recast,
  });
  assert.equal(enlarged.ok, false);
  const afterRecast = await store.listQueue(scope);
  assert.equal(afterRecast.length, 1, 'the refused recast must not append a second delete row');
  assert.deepEqual(afterRecast.map((row) => row.payload.type), ['delete_subtree']);
  assert.equal(afterRecast[0]!.opId, queued[0]!.opId);
});

test('FRR-04.3: same frozen token retry reuses opId; nonempty folder uses delete_subtree', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', parentNativeId: 'bar', nodeKind: 'bookmark', revision: 'r-bm',
  });
  const { preview } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: [] });
  const command = frozenRemoteDeleteCommand(preview, 'bar');
  assert.ok(command);
  assert.equal(command.affectedCount, 1);
  const first = await executeRemoteDelete(store, scope, command);
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
  const second = await executeRemoteDelete(store, scope, command);
  assert.equal(second.ok, true);
  assert.equal((await store.listQueue(scope)).length, 1);
  assert.equal((await store.listQueue(scope))[0]!.opId, queued.opId);
});

test('FRR-04.3: shrinking or rebound remote identity fails closed', async () => {
  const store = await boundStore();
  await putRemoteMapping(store, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', parentNativeId: 'bar', nodeKind: 'bookmark', revision: 'r-bm',
  });
  await putRemoteMapping(store, {
    nativeId: 'unmounted:colp-two', colpId: 'colp-two', parentColpId: 'remote-bar', nodeKind: 'bookmark',
    revision: 'r-two',
  });
  const { preview } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: [] });
  const command = frozenRemoteDeleteCommand(preview, 'bar');
  assert.ok(command);
  assert.equal(command.affectedCount, 2);

  await store.deleteMapping(scope, 'unmounted:colp-two');
  const shrunk = await executeRemoteDelete(store, scope, command);
  assert.equal(shrunk.ok, false);
  if (!shrunk.ok) assert.equal(shrunk.error, 'preview_stale');
  assert.equal((await store.listQueue(scope)).length, 0);

  await putRemoteMapping(store, {
    nativeId: 'unmounted:colp-two', colpId: 'colp-two', parentColpId: 'remote-bar', nodeKind: 'bookmark',
    revision: 'r-two',
  });
  const rebound = await store.getMountBinding(scope, 'mount-bar');
  await store.putMountBinding(scope, {
    mountId: rebound!.mountId, nativeRootId: rebound!.nativeRootId, remoteMountNodeId: 'remote-other',
    boundaryVersion: rebound!.boundaryVersion, materialized: rebound!.materialized, status: rebound!.status,
    rootRole: rebound!.rootRole,
  });
  const identity = await executeRemoteDelete(store, scope, command);
  assert.equal(identity.ok, false);
  if (!identity.ok) assert.equal(identity.error, 'preview_stale');
  assert.equal((await store.listQueue(scope)).length, 0);
  assert.equal((await store.listQueue(scope)).some((row) => row.payload.targetId === 'remote-other'), false);
});

test('range confirm mints from frozen preview evidence and does not recount to recast', async () => {
  const range = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/sw/range.ts'), 'utf8');
  assert.match(range, /frozenRemoteDeleteCommand/);
  assert.doesNotMatch(range, /countMountAffected|mintRemoteDeleteConfirmation|removalCounts/);
});

async function boundStore() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 99_999 },
    checkpoint: { serverRevision: 'r1', cursor: 'c0' }, selectedRoots: [], firstRun: 'completed',
  });
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', boundaryVersion: '1',
    materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  await store.putMapping(scope, {
    nativeId: 'bar', colpId: 'remote-bar', rootNativeId: 'bar', mountId: 'mount-bar', nodeKind: 'folder',
    projection: { revision: 'r-bar', digest: 'sha256:bar' },
  });
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

function tree(): readonly NormalizedBookmarkRoot[] {
  return [
    {
      nativeId: 'bar', title: 'Bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [
        { nativeId: 'bm-1', title: 'One', kind: 'bookmark', managed: false, url: 'https://example.com/one', children: [] },
      ],
    },
    { nativeId: 'other', title: 'Other', kind: 'folder', managed: false, rootKind: 'other', children: [] },
  ];
}
