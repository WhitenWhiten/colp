import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { currentPullMapping } from '../src/pull-mapping-view.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('currentPullMapping page-local shadow', () => {
  test('repeated shadow reads transfer bounded batches and return detached records', async () => {
    const store = createSyncStateStore({ indexedDB });
    try {
      await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
        checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
      const db = await store.open(); const key = (await store.getScope(scope))!.scopeKey;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['pull_events', 'pull_pages'], 'readwrite');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        tx.objectStore('pull_pages').put({ scopeKey: key, pageId: 'page', previousCursor: 'cursor-0', nextCursor: 'cursor-1' });
        for (let n = 0; n < 450; n++) tx.objectStore('pull_events').put({ scopeKey: key,
          eventId: `event-${String(n).padStart(3, '0')}`, ordinal: n, state: 'authority_committed', pageId: 'page',
          pendingMappings: [{ nativeId: `native-${n}`, colpId: `colp-${n}`, rootNativeId: 'root',
            projection: { revision: 'r1', digest: 'd1', content: { title: 'Original' } } }] });
        tx.objectStore('pull_events').put({ scopeKey: key, eventId: 'latest', pageId: 'page', ordinal: 450,
          state: 'staged', cursor: 'cursor-1', operationId: 'latest-op', effectId: 'latest-fx',
          effectDigest: 'latest-digest', operationDigest: 'latest-op-digest', kind: 'node_content_updated', payload: {} });
      });
      const advance = vi.spyOn(IDBCursor.prototype, 'continue');
      let payloadReads = 0;
      const get = IDBObjectStore.prototype.get; const bulk = IDBIndex.prototype.getAll;
      vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'pull_events') payloadReads++;
        return get.apply(this, args);
      });
      vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
        const request = bulk.apply(this, args);
        request.addEventListener('success', () => { if (this.objectStore.name === 'pull_events') payloadReads += request.result.length; });
        return request;
      });
      const mapping = await currentPullMapping(store, scope, 'colp-449'); assert.ok(mapping);
      const initialReads = payloadReads;
      Reflect.set(mapping.projection.content!, 'title', 'Caller mutation');
      assert.equal((await currentPullMapping(store, scope, 'colp-449'))?.projection.content?.title, 'Original');
      assert.equal(payloadReads, initialReads, 'unchanged committed payloads must not be transferred again');
      assert.equal(advance.mock.calls.length, 0, 'shadow lookup must not issue one IPC per unrelated event');
      advance.mockRestore();
      await store.preparePullIntent(scope, 'latest', { intentId: 'latest-intent', correlationId: 'latest-correlation',
        operationId: 'latest-op', eventId: 'latest', effectId: 'latest-fx',
        expected: { kind: 'change', nativeId: 'native-449' }, expiresAt: Date.now() + 300000, state: 'intent_prepared' });
      await store.commitPullEvent(scope, 'latest', { mappings: [{ nativeId: mapping.nativeId, colpId: mapping.colpId,
        rootNativeId: mapping.rootNativeId,
        projection: { revision: 'r2', digest: 'd2', content: { title: 'Latest' } } }] });
      const beforeNew = payloadReads;
      assert.equal((await currentPullMapping(store, scope, 'colp-449'))?.projection.content?.title, 'Latest');
      assert.equal(payloadReads - beforeNew, 1, 'only the newly committed shadow is transferred');
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('pull_events', 'readwrite'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        const request = tx.objectStore('pull_events').get([key, 'event-449']);
        request.onsuccess = () => tx.objectStore('pull_events').put({ ...request.result, state: 'page_complete' });
      });
      assert.equal((await currentPullMapping(store, scope, 'colp-449'))?.projection.content?.title, 'Latest');
    } finally { store.close(); }
  });
  test('pending shadows mask durable rows and pending deletes unbind them', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: 10_000 },
      checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
    const putDurable = (nativeId: string, colpId: string, title: string) => store.putMapping(scope, {
      nativeId, colpId, rootNativeId: 'native-root', nodeKind: 'bookmark',
      projection: { revision: `rev-${colpId}`, digest: `sha256:${colpId}`,
        content: { title, url: `https://example.test/${colpId}` } } });
    await putDurable('native-durable', 'colp-durable', 'Durable');
    await putDurable('native-deleted', 'colp-deleted', 'Deleted');
    await putDurable('native-unbound', 'colp-unbound', 'Unbound');

    const event = (eventId: string, initialState?: 'staged' | 'authority_committed') => ({
      eventId, cursor: 'cursor-1', operationId: `op-${eventId}`, effectId: `fx-${eventId}`,
      effectDigest: `sha256:${eventId}-fx`, operationDigest: `sha256:${eventId}-op`,
      kind: 'node_content_updated', payload: {}, ...(initialState ? { initialState } : {}) });
    await store.stagePullPage(scope, { pageId: 'page-1', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
      collectionRevision: 'revision-1', pageDigest: 'sha256:page-1',
      events: [event('e-plain', 'authority_committed'), event('e-shadow'), event('e-del'), event('e-exit')],
      effectPages: [] });
    const intent = (eventId: string) => ({ intentId: `intent:${eventId}`, correlationId: `corr-${eventId}`,
      operationId: `op-${eventId}`, eventId, effectId: `fx-${eventId}`,
      expected: { kind: 'change', nativeId: `pending:${eventId}` }, expiresAt: Date.now() + 300_000,
      state: 'intent_prepared' as const });
    const prepared = async (eventId: string) => {
      await store.preparePullIntent(scope, eventId, intent(eventId));
    };
    await prepared('e-shadow');
    await store.commitPullEvent(scope, 'e-shadow', { mappings: [{ nativeId: 'native-shadow', colpId: 'colp-durable',
      rootNativeId: 'native-root', nodeKind: 'bookmark',
      projection: { revision: 'rev-shadow', digest: 'sha256:shadow',
        content: { title: 'Shadow', url: 'https://example.test/shadow' } } }] });
    await prepared('e-del');
    await store.commitPullEvent(scope, 'e-del', { deleteNativeIds: ['native-deleted'] });
    await prepared('e-exit');
    await store.commitPullEvent(scope, 'e-exit', { rangeExit: {
      observation: { colpId: 'colp-unbound', remoteRevision: 'rev-exit', cursor: 'cursor-1', kind: 'placement',
        payload: {}, sourceDigest: 'sha256:exit-obs', observedAt: 1 },
      unbindNativeIds: ['native-unbound'] } });

    assert.equal((await currentPullMapping(store, scope, 'colp-durable'))?.nativeId, 'native-shadow');
    assert.equal(await currentPullMapping(store, scope, 'colp-deleted'), null);
    assert.equal(await currentPullMapping(store, scope, 'colp-unbound'), null);
    assert.equal((await currentPullMapping(store, scope, 'colp-live')) ?? null, null);
    await putDurable('native-live', 'colp-live', 'Live');
    assert.equal((await currentPullMapping(store, scope, 'colp-live'))?.nativeId, 'native-live');
    const fallback = { listPullEvents: store.listPullEvents, getMappingByColpId: store.getMappingByColpId };
    assert.equal((await currentPullMapping(fallback, scope, 'colp-durable'))?.nativeId, 'native-shadow');
    assert.equal(await currentPullMapping(fallback, scope, 'colp-deleted'), null);
    assert.equal(await currentPullMapping(fallback, scope, 'colp-unbound'), null);
    assert.equal(await currentPullMapping(fallback, scope, 'colp-missing'), null);
    assert.equal((await currentPullMapping(fallback, scope, 'colp-live'))?.nativeId, 'native-live');
    store.close();
  });
});
