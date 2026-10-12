import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { currentPullMapping } from '../src/pull-mapping-view.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('currentPullMapping page-local shadow', () => {
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
  });
});
