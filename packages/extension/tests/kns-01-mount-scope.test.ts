/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { scanBoundary } from '../src/bookmark-boundary.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import {
  canProvisionDefaultSyncRoot, colpSessionTransportSlice, retireScopeIfQueueDrained,
} from '../src/session-binding.js';
import { PREVIEW_TTL_MS, mountsFromPlan, previewHasTitlesOrUrls } from '../src/sync-state/mount-repository.js';
import { createSyncStateStore, type QueueOperation, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('KNS-01 mount mapping and preview stores', () => {
  test('bindMountMapping writes mount fields and refuses a second native binding', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    assert.equal(await store.bindMountMapping(scope, {
      nativeId: 'bar', colpId: 'mount-colp', mountId: 'mount-bar', rootRole: 'bookmarks-bar', revision: 'r1',
    }), true);
    const mapping = await store.getMappingByNativeId(scope, 'bar');
    assert.equal(mapping?.colpId, 'mount-colp');
    assert.equal(mapping?.mountId, 'mount-bar');
    assert.equal(mapping?.rootRole, 'bookmarks-bar');
    assert.equal(mapping?.projection.digest, 'sha256:mount-binding');
    assert.equal(await store.bindMountMapping(scope, {
      nativeId: 'bar', colpId: 'other', mountId: 'mount-bar', revision: 'r1',
    }), false);
    assert.equal(await store.bindMountMapping(scope, {
      nativeId: 'other', colpId: 'x', mountId: 'm', revision: 'local-1',
    }), false);
  });

  test('two special-root mounts persist independently; custom mounts omit rootRole', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const planned = mountsFromPlan('', [
      { nativeRootId: '1', writable: true, materialized: false, rootRole: 'bookmarks-bar' },
      { nativeRootId: '2', writable: true, materialized: false, rootRole: 'other-bookmarks' },
      { nativeRootId: '9', writable: true, materialized: false, customSourceKey: 'folder:9' },
    ], '1', 'active');
    await store.replaceMountBindings(scope, planned);
    const mounts = await store.listMountBindings(scope);
    assert.equal(mounts.length, 3);
    assert.equal(mounts.filter((mount) => mount.rootRole).length, 2);
    assert.ok(mounts.some((mount) => mount.customSourceKey === 'folder:9' && mount.rootRole === undefined));
    const customOnly = mountsFromPlan('', [
      { nativeRootId: '9', writable: true, materialized: false, customSourceKey: 'folder:9' },
      { nativeRootId: '10', writable: true, materialized: false, customSourceKey: 'folder:10' },
    ], '2', 'active');
    await store.replaceMountBindings(scope, customOnly);
    assert.equal((await store.listMountBindings(scope)).length, 2);
  });

  test('scope_previews persist counts and digest without titles or URLs', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    const roots: readonly NormalizedBookmarkRoot[] = [
      { nativeId: 'bar', title: 'Bookmarks bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar',
        children: [{ nativeId: 'b1', title: 'Secret', kind: 'bookmark', managed: false, url: 'https://secret.example/',
          children: [] }] },
      { nativeId: 'other', title: 'Other bookmarks', kind: 'folder', managed: false, rootKind: 'other', children: [] },
    ];
    const scan = scanBoundary({ roots, selectedNativeIds: ['bar'] });
    const preview = await store.putScopePreview(scope, {
      previewId: 'preview-1', boundaryVersion: '1', treeDigest: scan.treeDigest, bookmarkCount: scan.bookmarkCount,
      folderCount: scan.folderCount, skippedCount: scan.skippedCount, expiresAt: Date.now() + PREVIEW_TTL_MS,
      warnings: scan.warnings, boundary: { selectedNativeIds: scan.selectedNativeIds,
        excludedNativeIds: scan.excludedNativeIds, mounts: scan.mounts },
    });
    assert.equal(previewHasTitlesOrUrls(preview), false);
    assert.doesNotMatch(JSON.stringify(preview), /"title"|"url"/u);
    assert.equal(previewHasTitlesOrUrls({ title: 'Bookmarks bar', url: 'https://secret.example/' }), true);
  });

  test('hasActiveMounts is false when empty or all detached; pending stays open', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    assert.equal(await store.hasActiveMounts(scope), false);
    await store.putMountBinding(scope, {
      mountId: 'mount-pending', nativeRootId: 'bar', remoteMountNodeId: null, boundaryVersion: '1',
      materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
    });
    assert.equal(await store.hasActiveMounts(scope), true);
    await store.detachMount(scope, 'mount-pending');
    assert.equal(await store.hasActiveMounts(scope), false);
  });

  test('detach keeps mappings and remote ids; rejoin reactivates; remote delete is separate', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    await store.putMapping(scope, {
      nativeId: 'bar', colpId: 'colp-bar', rootNativeId: 'bar', mountId: 'mount-bar',
      projection: { revision: 'r1', digest: 'sha256:bar' },
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    assert.equal(await store.hasActiveMounts(scope), true);
    const detached = await store.detachMount(scope, 'mount-bar');
    assert.equal(detached.status, 'detached');
    assert.equal(detached.remoteMountNodeId, 'remote-bar');
    assert.equal((await store.getMappingByNativeId(scope, 'bar'))?.colpId, 'colp-bar');
    assert.equal(await store.hasActiveMounts(scope), false);
    const rejoined = await store.rejoinMount(scope, 'mount-bar');
    assert.equal(rejoined.status, 'active');
    const planned = await store.planRemoteDelete(scope, {
      mountId: 'mount-bar', confirmationToken: 'tok', affectedCount: 4,
    });
    assert.equal(planned.pendingRemoteDelete?.confirmation, 'tok');
    assert.equal('confirmationToken' in (planned.pendingRemoteDelete ?? {}), false);
    assert.equal(planned.pendingRemoteDelete?.affectedCount, 4);
    assert.equal((await store.getMappingByNativeId(scope, 'bar'))?.colpId, 'colp-bar');
    assert.equal(planned.remoteMountNodeId, 'remote-bar');
  });

  test('currentBootstrapMode reads the live run and otherwise merge', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    assert.equal(await store.currentBootstrapMode(scope), 'merge');
    await store.putBootstrapRun(scope, {
      runId: 'run-1', phase: 'scanning', bootstrapMode: 'upload', confirmationId: 'c1', updatedAt: 10,
    });
    assert.equal(await store.currentBootstrapMode(scope), 'upload');
  });
});

describe('KNS-01 session binding and remount helper', () => {
  test('transport spy: new scopes send whole-profile; legacy replicas keep mounted-folder', () => {
    const spy: Array<ReturnType<typeof colpSessionTransportSlice>> = [];
    const send = (body: ReturnType<typeof colpSessionTransportSlice>) => { spy.push(body); };
    send(colpSessionTransportSlice({
      browserProfileId: 'profile-a', generation: '1',
      scope: { ...scope, scopeKey: 'k', lifecycle: 'active', lease: { leaseId: 'l', expiresAt: 1 },
        checkpoint: null, selectedRoots: [], mountMode: 'whole-profile', firstRun: 'none', boundaryVersion: '0' },
      bootstrapMode: null,
    }));
    send(colpSessionTransportSlice({
      browserProfileId: 'profile-a', generation: '1',
      scope: { ...scope, scopeKey: 'k', lifecycle: 'active', lease: { leaseId: 'l', expiresAt: 1 },
        checkpoint: { serverRevision: 'r', cursor: 'c' }, selectedRoots: ['colp-root'],
        mountMode: 'whole-profile', firstRun: 'none', boundaryVersion: '0', legacyCanonicalRoot: 'colp-root' },
      legacyNativeId: 'native-bar', bootstrapMode: 'download',
    }));
    assert.equal(spy[0]?.binding.mountMode, 'whole-profile');
    assert.equal(spy[0]?.binding.mountNativeId, null);
    assert.equal(spy[0]?.bootstrapMode, 'merge');
    assert.equal(spy[1]?.binding.mountMode, 'mounted-folder');
    assert.equal(spy[1]?.binding.mountNativeId, 'native-bar');
    assert.notEqual(spy[1]?.binding.mountMode, 'whole-profile');
  });

  test('retireScopeIfQueueDrained refuses live queue unless abandoned and does not open a Session', async () => {
    const store = createSyncStateStore({ indexedDB });
    await active(store);
    await store.allocateSequenceAndEnqueue(scope, operation('op-live'), { allowUnstamped: true });
    await assert.rejects(() => retireScopeIfQueueDrained(store, scope), /queue_not_drained/);
    assert.ok(await store.getScope(scope));
    await retireScopeIfQueueDrained(store, scope, { abandonQueue: true });
    assert.equal(await store.getScope(scope), null);
  });

  test('provisionDefaultSyncRoot is gated until first-run completed and explicit create', () => {
    assert.equal(canProvisionDefaultSyncRoot('none', false), false);
    assert.equal(canProvisionDefaultSyncRoot('none', true), false);
    assert.equal(canProvisionDefaultSyncRoot('completed', false), false);
    assert.equal(canProvisionDefaultSyncRoot('completed', true), true);
  });
});

async function active(store: ReturnType<typeof createSyncStateStore>) {
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [],
  });
}

function operation(opId: string): Omit<QueueOperation, 'sequence' | 'scopeKey'> {
  return {
    opId, batchId: `batch-${opId}`, idempotencyKey: `idem-${opId}`, digest: `sha256:${opId}`,
    endpointIdentity: 'syncPush', mediaType: 'application/json', baseRevision: 'revision-0',
    operationRevision: 'revision-local-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload: { type: 'update_node', targetId: 'node-1' },
  };
}
