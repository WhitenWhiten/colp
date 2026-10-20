import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test, vi } from 'vitest';
import type { SnapshotNode } from '@know-n/colp/types';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { repairWronglyAckedUnmountedRestore } from '../src/unmounted-restore-repair.js';
import { indexedDB, installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { ack, emptyPullPage, json, nonemptyMountSnapshot, scope as engineScope, setup } from './durable-sync-engine-harness.js';

installKns05IndexedDb();

describe('T-05 wrongly Acked unmounted restore repair (R-07)', () => {
  test('R-07: snapshot repair keeps original Node identity, user edits, and old receipts', async () => {
    const fixture = await setup({ snapshotRequired: true, emptyCollection: true, seedMount: false, useRealPullApplier: true });
    const store = fixture.store, scope = engineScope;
    fixture.clock.now = Date.now();
    await store.registerScope({
      ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', generation: '1', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
      checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-acked' },
      selectedRoots: ['root-colp'], rootStatus: 'ready', firstRun: 'completed',
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

    fixture.chromeNodes.clear();
    fixture.chromeNodes.set('native-root', { id: 'native-root', title: 'Bar' });
    fixture.chromeNodes.set('native-user', { id: 'native-user', parentId: 'native-root', title: 'User edit', url: 'https://example.test/user' });
    const nativeBefore = [...fixture.chromeNodes.values()];
    const snapshot = repairedSnapshot();
    fixture.snapshotResponses.push(json(200, snapshot));
    let releaseAck!: (response: Response) => void;
    fixture.ackResponses.push(new Promise<Response>(resolve => { releaseAck = resolve; }));
    fixture.forcedSessions.push(
      { sessionId: 'session-repair', state: 'active', snapshotRequired: true, cursor: 'cursor-acked' },
      { sessionId: 'session-repaired', state: 'active', snapshotRequired: false, cursor: 'cursor-recovered' },
    );
    fixture.clock.now = Date.now() + 1_000;
    store.close();
    const recovering = fixture.reopen().wake('startup');
    try {
      await vi.waitFor(() => assert.equal(fixture.ackRequests.length, 1));
      assert.equal((await store.listAckIntents(scope)).at(-1)?.state, 'pending');
      assert.deepEqual([...fixture.chromeNodes.values()], nativeBefore,
        'the real pending Ack boundary grants no native restoration');
    } finally {
      releaseAck(json(200, ack(snapshot.syncCursor)));
      await recovering;
    }
    assert.equal((await store.getScope(scope))?.lifecycle, 'active', JSON.stringify({
      engine: await store.getEngineState(scope), order: fixture.order, snapshots: fixture.snapshotRequests,
      recovery: await store.getRecoveryHeader(scope),
    }));
    assert.equal((await store.listAckIntents(scope)).at(-1)?.state, 'complete');
    assert.equal(fixture.snapshotRequests.length, 1);
    assert.equal(JSON.parse(fixture.ackRequests[0]!.body).cursor, snapshot.syncCursor);
    assert.equal(fixture.ackRequests[0]!.headerSession, 'session-repair');
    assert.equal(await store.getRecoveryHeader(scope), null);
    assert.deepEqual([...fixture.chromeNodes.values()], nativeBefore,
      'native restoration waits for the active-session follow-up');
    assert.deepEqual((await store.exportScope(scope)).receipts, before.receipts);
    assert.deepEqual((await store.listQueue(scope)).find(row => row.opId === 'op-user-edit'),
      before.queue.find(row => row.opId === 'op-user-edit'));

    // Only the engine's acknowledged, active-session follow-up may resume the
    // canonical virtual children. No test code changes the lifecycle to active.
    fixture.clock.now += 1_001;
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-repair'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ack('cursor-after-repair')));
    store.close();
    await fixture.reopen().wake('startup');
    const projected = await store.listMappings(scope);
    const rec = projected.find((row) => row.colpId === 'rec-missing');
    const orphan = projected.find((row) => row.colpId === 'orphan-keep');
    assert.ok(rec?.nativeId && !rec.nativeId.startsWith('unmounted:') && !rec.nativeId.startsWith('recovery:'));
    assert.ok(orphan?.nativeId && !/^(?:unmounted:|recovery:)/u.test(orphan.nativeId));
    assert.equal(orphan?.colpId, 'orphan-keep');
    assert.equal(orphan?.parentNativeId, rec?.nativeId);
    assert.equal(fixture.chromeNodes.get(orphan!.nativeId)?.title, 'Keep me');
    assert.equal((await store.getMappingByColpId(scope, 'pending-op-user-edit'))?.nativeId, 'native-user');
    assert.equal((await store.getMappingByColpId(scope, 'pending-op-user-edit'))?.projection.content?.title, 'User edit');
    assert.deepEqual((await store.exportScope(scope)).receipts, before.receipts);
    assert.equal((await store.exportScope(scope)).receipts[0]?.receiptId, 'receipt-old');
    assert.deepEqual((await store.listQueue(scope)).find(row => row.opId === 'op-user-edit'),
      before.queue.find(row => row.opId === 'op-user-edit'));
    assert.equal([...fixture.chromeNodes.values()].filter(node => node.url === 'https://example.test/keep').length, 1);
    assert.equal(fixture.chromeNodes.get('native-user')?.title, 'User edit');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, false);
    const nativeAfter = [...fixture.chromeNodes.values()];
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-after-reopen'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    fixture.ackResponses.push(json(200, ack('cursor-after-reopen')));
    fixture.clock.now += 1_001;
    store.close();
    await fixture.reopen().wake('startup');
    assert.equal((await store.getMappingByColpId(scope, 'rec-missing'))?.nativeId, rec.nativeId);
    assert.equal((await store.getMappingByColpId(scope, 'orphan-keep'))?.nativeId, orphan.nativeId);
    assert.deepEqual([...fixture.chromeNodes.values()], nativeAfter);
    assert.equal(fixture.snapshotRequests.length, 1, 'reopening the repaired scope does not need another Snapshot');
    assert.deepEqual((await store.exportScope(scope)).receipts, before.receipts);
    assert.deepEqual((await store.listQueue(scope)).find(row => row.opId === 'op-user-edit'),
      before.queue.find(row => row.opId === 'op-user-edit'));
    store.close();
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

function repairedSnapshot() {
  const base = nonemptyMountSnapshot(false);
  const stamp = { collectionId: engineScope.collectionId, createdAt: '2026-07-28T00:00:00Z',
    updatedAt: '2026-07-28T00:00:00Z', extensions: {} };
  const nodes: SnapshotNode[] = [{
    ...stamp, id: 'root-server', parentId: null, position: null, kind: 'root',
    title: 'root-server', folderRole: 'root', revision: 'revision-root-server',
  }, {
    ...stamp, id: 'root-colp', parentId: 'root-server', position: 'p1', kind: 'folder',
    title: 'Bar', folderRole: 'bookmarks-bar', revision: 'r-root',
  }, {
    ...stamp, id: 'rec-missing', parentId: 'root-colp', position: 'p2', kind: 'folder',
    title: 'Recovered', folderRole: 'recovered', revision: 'r-rec',
  }, {
    ...stamp, id: 'orphan-keep', parentId: 'rec-missing', position: 'p3', kind: 'bookmark',
    title: 'Keep me', url: 'https://example.test/keep', revision: 'r-orphan-new',
  }];
  return { ...base, nodes, recoveryCapability: 'src1.repair-capability', parentRevisions: [
    { parentId: 'root-server', childrenRevision: 'children-root' },
    { parentId: 'root-colp', childrenRevision: 'c-root' },
    { parentId: 'rec-missing', childrenRevision: 'c-rec' },
  ] };
}
