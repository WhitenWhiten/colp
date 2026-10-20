import 'fake-indexeddb/auto';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { expect, test, vi } from 'vitest';
import { currentPullMapping } from '../src/pull-mapping-view.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };

test('each current mapping lookup reads its unpublished shadow and durable fallback in one fresh transaction', async () => {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', selectedRoots: [],
    lease: { leaseId: 'lease', expiresAt: Date.now() + 300_000 },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' } });
  const ids = Array.from({ length: 96 }, (_, index) => `node-${index}`);
  await store.stagePullPage(scope, { pageId: 'page-1', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
    collectionRevision: 'revision-1', pageDigest: 'sha256:page-1', effectPages: [],
    events: ids.map(id => ({ eventId: id, cursor: 'cursor-1', operationId: `op-${id}`, effectId: `effect-${id}`,
      kind: 'node_content_updated', effectDigest: `sha256:${id}`, operationDigest: `sha256:op-${id}`, payload: {} })) });
  for (const id of ids) {
    await store.preparePullIntent(scope, id, { intentId: `intent:${id}`, correlationId: `correlation:${id}`,
      operationId: `op-${id}`, eventId: id, effectId: `effect-${id}`, expiresAt: Date.now() + 300_000,
      expected: { kind: 'change', nativeId: `native-${id}` }, state: 'intent_prepared' });
    const mapping: MappingInput = { nativeId: `native-${id}`, colpId: id, rootNativeId: 'bar', nodeKind: 'bookmark',
      projection: { revision: 'new-revision', digest: `sha256:${id}`,
        content: { title: id, url: `https://mapping-budget.test/${id}` } } };
    await store.commitPullEvent(scope, id, { mappings: [mapping] });
  }
  let reads = 0, wholeEventCopies = 0;
  const transaction = IDBDatabase.prototype.transaction, copy = globalThis.structuredClone;
  const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
    if ((args[1] ?? 'readonly') === 'readonly') reads++;
    return transaction.apply(this, args);
  });
  const copySpy = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    if (Array.isArray(value) && value.length === ids.length && value.every(row => row?.eventId)) wholeEventCopies++;
    return copy(value, options);
  });
  try {
    for (const id of ids) expect(await currentPullMapping(store, scope, id))
      .toMatchObject({ nativeId: `native-${id}`, colpId: id, projection: { revision: 'new-revision' } });
    expect(reads).toBe(ids.length);
    expect(wholeEventCopies).toBe(0);
    txSpy.mockRestore(); copySpy.mockRestore();
    expect(await store.listMappings(scope)).toEqual([]);
    expect((await store.getCursor(scope))?.cursor ?? 'cursor-0').toBe('cursor-0');
    expect((await store.listPullEvents(scope)).every(row => row.state === 'authority_committed')).toBe(true);
    expect(await store.listQueue(scope)).toEqual([]);
  } finally { txSpy.mockRestore(); copySpy.mockRestore(); store.close(); }
});
