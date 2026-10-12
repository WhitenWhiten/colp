import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createSyncStateStore, type JsonObject } from '../src/sync-state-store.js';
import { bookmark, deterministicIds, fixture, folder, memoryApi, scope } from './bookmark-event-queue-harness.js';

async function seedTerminalCreate(store: ReturnType<typeof createSyncStateStore>, nativeId: string,
  colpId: string, parentColp: string, title: string, url: string) {
  const opId = `b3.audit.create.${nativeId}`;
  const payload: JsonObject = { type: 'create_node', opId, replicaId: scope.replicaId, sequence: 1,
    collectionId: scope.collectionId, baseRevision: null, occurredAt: '2026-07-27T00:00:00.000Z',
    dependencies: [], payload: { parentId: parentColp, node: { kind: 'bookmark', title, url } } };
  const queued = await store.allocateSequenceAndEnqueue(scope, {
    opId, batchId: opId, idempotencyKey: opId, digest: `sha256:${opId}`, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: `local-${opId}`, status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload,
  }, { allowUnstamped: true });
  await store.completeQueueWithReceipt(scope, queued.sequence, {
    opId, operationDigest: queued.digest, kind: 'terminal', receiptId: `receipt-${nativeId}`,
    resultDigest: `sha256:result-${nativeId}`, result: { results: [{ opId, sequence: queued.sequence,
      status: 'applied', targetId: colpId, revision: 'server-uploaded-r1' }] },
  });
  return queued;
}

function liveTypes(store: ReturnType<typeof createSyncStateStore>) {
  return store.listQueue(scope).then((rows) => rows.filter((row) => row.status !== 'terminal')
    .map((row) => row.payload.type));
}

describe('P3-30 bookmark event recover after first-run', () => {
  let indexedDB: IDBFactory;
  beforeEach(() => { indexedDB = new IDBFactory(); });

  test('recover() does not invent create_node when uploaded-unmapped has a terminal create receipt', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [],
      rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, {
      nativeId: '1', colpId: 'server-mount-bar', rootNativeId: '1', mountId: 'mount-bar', nodeKind: 'folder',
      projection: { revision: 'r-bar', digest: 'sha256:bar', content: { title: 'Bar' } },
    });
    await store.putMapping(scope, {
      nativeId: 'mapped-child', colpId: 'colp-mapped', rootNativeId: '1', mountId: 'mount-bar',
      parentNativeId: '1', nodeKind: 'bookmark',
      projection: { revision: 'r-mapped', digest: 'sha256:mapped',
        content: { title: 'Mapped', url: 'https://example.test/mapped' } },
    });
    await seedTerminalCreate(store, 'uploaded-unmapped', 'server-uploaded', 'server-mount-bar',
      'Already uploaded', 'https://example.test/uploaded');
    const api = memoryApi();
    api.put(folder('1', '0', 0, 'Bar'));
    api.put(bookmark('mapped-child', '1', 0, 'Mapped', 'https://example.test/mapped'));
    api.put(bookmark('uploaded-unmapped', '1', 1, 'Already uploaded', 'https://example.test/uploaded'));
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    await queue.recover();
    assert.deepEqual(await liveTypes(store), []);
    assert.equal((await store.getMappingByNativeId(scope, 'uploaded-unmapped'))?.colpId, 'server-uploaded');
    assert.doesNotMatch(JSON.stringify(await store.listMappings(scope)), /pending-/);
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node'
      && row.status !== 'terminal').length, 0);
  });

  test('AUDIT-02 recover() after completed first-run captures a true missed local create once', async () => {
    const { store, queue, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'completed');
    await store.putMountBinding(scope, { mountId: 'audit-mount', nativeRootId: 'root-selected',
      remoteMountNodeId: (await store.getMappingByNativeId(scope, 'root-selected'))!.colpId,
      rootRole: 'bookmarks-bar', boundaryVersion: '1', materialized: false, status: 'active' });
    api.put(bookmark('missed-new', 'folder-parent', 0, 'New after onboarding', 'https://example.test/new'));
    await queue.recover();
    assert.equal((await store.listQueue(scope)).some((row) => row.payload.type === 'create_node'), true);
    const first = (await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length;
    await queue.recover();
    assert.equal((await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node').length, first);
  });

  test('recover() after first-run still stages change for a verified mapping', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [],
      rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, {
      nativeId: '1', colpId: 'server-mount-bar', rootNativeId: '1', mountId: 'mount-bar', nodeKind: 'folder',
      projection: { revision: 'r-bar', childrenRevision: 'children-r-bar', digest: 'sha256:bar',
        content: { title: 'Bar' } },
    });
    await store.putMapping(scope, {
      nativeId: 'mapped-child', colpId: 'colp-mapped', rootNativeId: '1', mountId: 'mount-bar',
      parentNativeId: '1', nodeKind: 'bookmark',
      projection: { revision: 'r-mapped', digest: 'sha256:mapped',
        content: { title: 'Mapped', url: 'https://example.test/mapped' } },
    });
    await seedTerminalCreate(store, 'uploaded-unmapped', 'server-uploaded', 'server-mount-bar',
      'Already uploaded', 'https://example.test/uploaded');
    const api = memoryApi();
    api.put(folder('1', '0', 0, 'Bar'));
    api.put(bookmark('mapped-child', '1', 0, 'Mapped renamed', 'https://example.test/mapped'));
    api.put(bookmark('uploaded-unmapped', '1', 1, 'Already uploaded', 'https://example.test/uploaded'));
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    await queue.recover();
    assert.deepEqual(await liveTypes(store), ['update_node_content']);
    assert.equal((await store.getMappingByNativeId(scope, 'uploaded-unmapped'))?.colpId, 'server-uploaded');
    assert.doesNotMatch(JSON.stringify(await store.listMappings(scope)), /pending-/);
  });

  test('recover() after first-run still stages move for a verified mapping', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
      checkpoint: { serverRevision: 'collection-revision-3', cursor: 'cursor-3' }, selectedRoots: [],
      rootStatus: 'ready', firstRun: 'completed' });
    await store.putMountBinding(scope, {
      mountId: 'mount-bar', nativeRootId: '1', remoteMountNodeId: 'server-mount-bar', boundaryVersion: '1',
      materialized: false, status: 'active', rootRole: 'bookmarks-bar',
    });
    await store.putMapping(scope, {
      nativeId: '1', colpId: 'server-mount-bar', rootNativeId: '1', mountId: 'mount-bar', nodeKind: 'folder',
      projection: { revision: 'r-bar', childrenRevision: 'children-r-bar', digest: 'sha256:bar',
        content: { title: 'Bar' } },
    });
    await store.putMapping(scope, {
      nativeId: 'folder-2', colpId: 'colp-folder-2', rootNativeId: '1', mountId: 'mount-bar',
      parentNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'r-folder', childrenRevision: 'children-r-folder', digest: 'sha256:folder',
        content: { title: 'Folder 2' } },
    });
    await store.putMapping(scope, {
      nativeId: 'mapped-child', colpId: 'colp-mapped', rootNativeId: '1', mountId: 'mount-bar',
      parentNativeId: '1', nodeKind: 'bookmark',
      projection: { revision: 'r-mapped', digest: 'sha256:mapped',
        content: { title: 'Mapped', url: 'https://example.test/mapped' } },
    });
    await seedTerminalCreate(store, 'uploaded-unmapped', 'server-uploaded', 'server-mount-bar',
      'Already uploaded', 'https://example.test/uploaded');
    const api = memoryApi();
    api.put(folder('1', '0', 0, 'Bar'));
    api.put(folder('folder-2', '1', 0, 'Folder 2'));
    api.put(bookmark('mapped-child', 'folder-2', 0, 'Mapped', 'https://example.test/mapped'));
    api.put(bookmark('uploaded-unmapped', '1', 1, 'Already uploaded', 'https://example.test/uploaded'));
    const queue = createBookmarkEventQueue({ scope, store, api, now: () => '2026-07-27T00:00:00Z',
      uuid: deterministicIds(), autoFlush: false });
    await queue.recover();
    assert.deepEqual(await liveTypes(store), ['move_node']);
    assert.equal((await store.getMappingByNativeId(scope, 'uploaded-unmapped'))?.colpId, 'server-uploaded');
    assert.doesNotMatch(JSON.stringify(await store.listMappings(scope)), /pending-/);
  });

  test('recover() during first-run running does not invent create_node for an unmapped native', async () => {
    const { queue, store, api } = await fixture(indexedDB);
    await store.setFirstRun(scope, 'running');
    api.put(bookmark('frozen-save', 'root-selected', 1, 'Saved during bootstrap', 'https://example.test/frozen'));
    await queue.recover();
    assert.deepEqual(await store.listQueue(scope), []);
    assert.equal((await store.getMappingByNativeId(scope, 'frozen-save')), null);
  });

  test('recovers accepted staged events after close/reopen and atomic crash points never consume without queueing', async () => {
    const first = await fixture(indexedDB, { mappedNode: true, autoFlush: false });
    first.api.put(bookmark('mapped', 'root-selected', 0, 'Recovered', 'https://example.test/before'));
    await first.queue.changed('mapped', { title: 'Recovered' });
    first.store.close();
    const reopenedStore = createSyncStateStore({ indexedDB });
    const reopened = createBookmarkEventQueue({ scope, store: reopenedStore, api: first.api,
      now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(100) });
    await reopened.recover();
    assert.deepEqual((await reopenedStore.listQueue(scope)).map((record) => record.payload.type),
      ['update_node_content']);

    for (const fault of ['after_sequence', 'after_queue', 'after_event'] as const) {
      const isolated = await fixture(new IDBFactory(), { mappedNode: true, autoFlush: false, fault });
      isolated.api.put(bookmark('mapped', 'root-selected', 0, `Crash ${fault}`, 'https://example.test/before'));
      await isolated.queue.changed('mapped', { title: `Crash ${fault}` });
      await assert.rejects(() => isolated.queue.flush(), /fault_injected/);
      isolated.store.close();
      const durable = createSyncStateStore({ indexedDB: isolated.indexedDB });
      const resumed = createBookmarkEventQueue({ scope, store: durable, api: isolated.api,
        now: () => '2026-07-27T00:00:00Z', uuid: deterministicIds(100) });
      await resumed.recover();
      assert.deepEqual((await durable.listQueue(scope)).map((record) => record.sequence), [1]);
    }
  });
});
