import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { createSyncStateStore, type MappingInput } from '../src/sync-state-store.js';
import { repairWronglyAckedUnmountedRestore } from '../src/unmounted-restore-repair.js';
import { fakeApi, indexedDB, installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

describe('T-05 wrongly Acked unmounted restore repair (R-07)', () => {
  test('R-07: snapshot repair keeps original Node identity, user edits, and old receipts', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-r07', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
      checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-acked' },
      selectedRoots: ['root-colp'], rootStatus: 'ready',
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, {
      nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root', nodeKind: 'folder',
      mountId: 'mount-bar', rootRole: 'bookmarks-bar',
      projection: { revision: 'r-root', childrenRevision: 'c-root', digest: 'sha256:root',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    });
    await store.putMapping(scope, {
      nativeId: 'unmounted:orphan-keep', colpId: 'orphan-keep', rootNativeId: 'unmounted:rec-missing',
      nodeKind: 'bookmark', parentNativeId: 'unmounted:rec-missing', parentColpId: 'rec-missing',
      projection: { revision: 'r-orphan', digest: 'sha256:orphan',
        content: { title: 'Keep me', url: 'https://example.test/keep' } },
    });
    await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-user-edit', batchId: 'batch-user-edit', idempotencyKey: 'key-user-edit',
      digest: 'sha256:user-edit', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: null, operationRevision: 'local-op-user-edit', status: 'pending',
      retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'create_node', opId: 'op-user-edit', payload: { parentId: 'root-colp' } },
    }, { allowUnstamped: true });
    await store.putMapping(scope, {
      nativeId: 'native-user', colpId: 'pending-op-user-edit', rootNativeId: 'native-root',
      nodeKind: 'bookmark', parentNativeId: 'native-root', parentColpId: 'root-colp',
      projection: { revision: 'local-op-user-edit', digest: 'sha256:user',
        content: { title: 'User edit', url: 'https://example.test/user' } },
    });
    await store.allocateSequenceAndEnqueue(scope, {
      opId: 'op-old-receipt', batchId: 'batch-old', idempotencyKey: 'key-old',
      digest: 'sha256:old-receipt', endpointIdentity: 'syncPush', mediaType: 'application/json',
      baseRevision: 'r1', operationRevision: 'local-old', status: 'pending',
      retry: { attempt: 0, notBefore: 0 },
      payload: { type: 'update_node_content', opId: 'op-old-receipt', targetId: 'other-node' },
    }, { allowUnstamped: true });
    await store.completeQueueWithReceipt(scope, 2, {
      opId: 'op-old-receipt', operationDigest: 'sha256:old-receipt', kind: 'terminal',
      receiptId: 'receipt-old', resultDigest: 'sha256:old-result',
      result: { results: [{ opId: 'op-old-receipt', sequence: 2, status: 'applied', targetId: 'other-node',
        revision: 'r-old', cursor: 'cursor-old', warnings: [] }] },
    });
    const before = await store.exportScope(scope);
    const repair = await repairWronglyAckedUnmountedRestore(store, scope);
    assert.equal(repair.needsSnapshot, true);
    assert.ok(repair.candidates >= 1);
    assert.equal((await store.exportScope(scope)).scope?.lifecycle, 'recovery_required');
    assert.deepEqual((await store.exportScope(scope)).receipts, before.receipts);

    const api = fakeApi();
    api.seed({ id: 'native-root', title: 'Bar' });
    api.seed({ id: 'native-user', parentId: 'native-root', title: 'User edit', url: 'https://example.test/user' });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-colp', colpId: 'root-colp', rootNativeId: 'recovery:root', nodeKind: 'folder',
      rootRole: 'bookmarks-bar',
      projection: { revision: 'r-root', childrenRevision: 'c-root', digest: 'sha256:root',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    }, {
      nativeId: 'recovery:rec-missing', colpId: 'rec-missing', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-colp',
      projection: { revision: 'r-rec', childrenRevision: 'c-rec', digest: 'sha256:rec',
        content: { title: 'Recovered', folderRole: 'recovered' } },
    }, {
      nativeId: 'recovery:orphan-keep', colpId: 'orphan-keep', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'rec-missing',
      projection: { revision: 'r-orphan-new', digest: 'sha256:orphan-new',
        content: { title: 'Keep me', url: 'https://example.test/keep' } },
    }];
    const projected = await recoverVerifiedOrFreeze({ scope, store, staged, api, freezeUnprovenIdentity: false });
    const rec = projected.find((row) => row.colpId === 'rec-missing');
    const orphan = projected.find((row) => row.colpId === 'orphan-keep');
    assert.ok(rec?.nativeId && !rec.nativeId.startsWith('unmounted:') && !rec.nativeId.startsWith('recovery:'));
    assert.ok(orphan?.nativeId && !orphan.nativeId.startsWith('unmounted:'));
    assert.equal(orphan?.colpId, 'orphan-keep');
    assert.equal(orphan?.parentNativeId, rec?.nativeId);
    assert.equal((await api.get(orphan!.nativeId))[0]?.title, 'Keep me');
    assert.equal((await store.getMappingByColpId(scope, 'pending-op-user-edit'))?.nativeId, 'native-user');
    assert.equal((await store.getMappingByColpId(scope, 'pending-op-user-edit'))?.projection.content?.title, 'User edit');
    assert.deepEqual((await store.exportScope(scope)).receipts, before.receipts);
    assert.equal((await store.exportScope(scope)).receipts[0]?.receiptId, 'receipt-old');
  });

  test('R-07: legal unmounted peer is not forced into the browser', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-r07b', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
      checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-acked' },
      selectedRoots: ['root-colp'], rootStatus: 'ready',
    });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, {
      nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root', nodeKind: 'folder',
      projection: { revision: 'r-root', digest: 'sha256:root', content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    });
    await store.putMapping(scope, {
      nativeId: 'unmounted:other-mount', colpId: 'other-mount', rootNativeId: 'unmounted:other-mount',
      nodeKind: 'folder', parentColpId: 'root-colp',
      projection: { revision: 'r-other', digest: 'sha256:other',
        content: { title: 'Other', folderRole: 'other-bookmarks' } },
    });
    await store.putMapping(scope, {
      nativeId: 'unmounted:other-child', colpId: 'other-child', rootNativeId: 'unmounted:other-mount',
      nodeKind: 'bookmark', parentNativeId: 'unmounted:other-mount', parentColpId: 'other-mount',
      projection: { revision: 'r-child', digest: 'sha256:child',
        content: { title: 'Other child', url: 'https://example.test/other' } },
    });
    const repair = await repairWronglyAckedUnmountedRestore(store, scope);
    assert.equal(repair.needsSnapshot, false);
    assert.equal(repair.candidates, 0);
    assert.equal((await store.getMappingByColpId(scope, 'other-child'))?.nativeId, 'unmounted:other-child');
  });
});
