import 'fake-indexeddb/auto';
import { IDBFactory, IDBIndex } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { currentPullMapping } from '../src/pull-mapping-view.js';
import { createSyncStateStore, type MappingInput, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { createPullMappingReadRepository } from '../src/sync-state/pull-mapping-read-repository.js';
import { createSyncStoreRuntime } from '../src/sync-state/runtime.js';
import { INDEXES, STORES } from '../src/sync-state/schema.js';

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const other: SyncScope = { ...scope, collectionId: 'other-collection' };
type Store = ReturnType<typeof createSyncStateStore>;
const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });

async function setup() {
  const indexedDB = new IDBFactory(); const store = createSyncStateStore({ indexedDB }); stores.push(store);
  for (const input of [scope, other]) await store.registerScope({ ...input, lifecycle: 'active', selectedRoots: [],
    lease: { leaseId: 'lease', expiresAt: Date.now() + 300_000 },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' } });
  return { store, indexedDB };
}
function mapping(nativeId: string, colpId: string, revision = 'revision-before'): MappingInput {
  return { nativeId, colpId, rootNativeId: 'native-root', nodeKind: 'bookmark', parentNativeId: 'native-root',
    parentColpId: 'remote-root', mountId: 'mount',
    quarantine: { code: 'local-only', snapshotId: 'snapshot', payloadDigest: 'sha256:quarantine' },
    projection: { revision, digest: `sha256:${revision}`, content: { title: revision, url: 'https://mapping.test/' } } };
}
function page(pageId: string, previousCursor: string, nextCursor: string, ids: readonly string[], stagedIds: readonly string[] = []) {
  return { pageId, previousCursor, nextCursor, collectionRevision: `revision-${pageId}`, pageDigest: `sha256:${pageId}`,
    effectPages: [], events: ids.map(eventId => ({ eventId, cursor: nextCursor, operationId: `op-${eventId}`,
      effectId: `effect-${eventId}`, effectDigest: `sha256:${eventId}`, operationDigest: `sha256:op-${eventId}`,
      kind: 'node_content_updated', payload: {},
      initialState: stagedIds.includes(eventId) ? 'staged' as const : 'authority_committed' as const })) };
}
async function commit(store: Store, input: SyncScope, id: string, update: Parameters<Store['commitPullEvent']>[2]) {
  await store.preparePullIntent(input, id, { intentId: `intent:${id}`, correlationId: `correlation:${id}`,
    operationId: `op-${id}`, eventId: id, effectId: `effect-${id}`, expiresAt: Date.now() + 300_000,
    expected: { kind: 'change', nativeId: 'native-target' }, state: 'intent_prepared' });
  await store.commitPullEvent(input, id, update);
}
async function secondConnection(indexedDB: IDBFactory) {
  const second = createSyncStateStore({ indexedDB }); stores.push(second); await second.open(); return second;
}
/** Submit an actual second-connection write after IDB delivers the first batch. */
function afterFirstBatch(work: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  const getAll = IDBIndex.prototype.getAll;
  vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
    const request = getAll.apply(this, args);
    if (this.name === INDEXES.pullEventByState) request.addEventListener('success', () => {
      if (pending) return;
      pending = work(); void pending.catch(() => undefined);
    }, { once: true });
    return request;
  });
  return async () => { expect(pending).toBeDefined(); await pending; };
}

test('405 shadows keep ordinal precedence, deletion, unbinding and same-event replacement across read batches', async () => {
  const { store } = await setup();
  await store.putMapping(scope, mapping('native-target', 'target'));
  await store.putMapping(scope, mapping('native-deleted', 'deleted'));
  await store.putMapping(scope, mapping('native-unbound', 'unbound'));
  // Event ids deliberately oppose ordinal order, crossing two 200-row boundaries.
  const ids = Array.from({ length: 405 }, (_, i) => `event-${String(405 - i).padStart(4, '0')}`);
  const changed = [ids[0]!, ids[199]!, ids[200]!, ids[403]!, ids[404]!];
  await store.stagePullPage(scope, page('z-first', 'cursor-0', 'cursor-1', ids, changed));
  await commit(store, scope, ids[0]!, { mappings: [mapping('native-target', 'target', 'revision-old-shadow'),
    mapping('native-deleted', 'deleted', 'revision-pending-delete'),
    mapping('native-unbound', 'unbound', 'revision-pending-unbind')] });
  await commit(store, scope, ids[199]!, { deleteNativeIds: ['native-target', 'native-deleted'] });
  await commit(store, scope, ids[200]!, { mappings: [mapping('native-target', 'target', 'revision-recreated')],
    deleteNativeIds: ['native-target'] });
  await commit(store, scope, ids[403]!, { rangeExit: { observation: { colpId: 'unbound', remoteRevision: 'revision-exit',
    cursor: 'cursor-1', kind: 'placement', payload: {}, sourceDigest: 'sha256:exit', observedAt: 1 },
  unbindNativeIds: ['native-unbound'] } });
  await commit(store, scope, ids[404]!, { mappings: [mapping('native-target', 'target', 'revision-latest')],
    deleteNativeIds: ['native-target'] });
  await store.stagePullPage(other, page('z-first', 'cursor-0', 'cursor-1', [ids[404]!], [ids[404]!]));
  await commit(store, other, ids[404]!, { mappings: [mapping('other-native', 'target', 'other-scope')] });
  const committed = (await store.getPullEvent(scope, ids[404]!))!;
  const expected = (committed.pendingMappings as MappingInput[])[0];
  const result = await currentPullMapping(store, scope, 'target');
  expect(result).toEqual(expected);
  expect(result?.projection.revision).toBe('revision-latest');
  expect(await currentPullMapping(store, scope, 'deleted')).toBeNull();
  expect(await currentPullMapping(store, scope, 'unbound')).toBeNull();
  expect(await currentPullMapping(store, scope, 'absent')).toBeNull();
  expect((await currentPullMapping(store, other, 'target'))?.nativeId).toBe('other-native');
  (result!.projection.content as { title: string }).title = 'caller mutation';
  store.close();
  expect(await currentPullMapping(store, scope, 'target')).toEqual(expected);
  await store.completePullPage(scope, 'z-first');
  expect(await currentPullMapping(store, scope, 'target')).toEqual(await store.getMappingByColpId(scope, 'target'));
  expect((await currentPullMapping(store, scope, 'target'))?.projection.revision).toBe('revision-latest');
  expect(await currentPullMapping(store, scope, 'deleted')).toBeNull();
  expect(await currentPullMapping(store, scope, 'unbound')).toBeNull();
  expect((await store.getCursor(scope))?.cursor).toBe('cursor-1');
});

test('page publication from a second connection cannot truncate a 401-event read between batches', async () => {
  const { store, indexedDB } = await setup(); const second = await secondConnection(indexedDB);
  const ids = Array.from({ length: 401 }, (_, i) => `event-${String(i).padStart(4, '0')}`);
  await store.stagePullPage(scope, page('page', 'cursor-0', 'cursor-1', ids));
  const published = afterFirstBatch(() => second.completePullPage(scope, 'page'));
  const events = await store.listPullEvents(scope, ['authority_committed']);
  expect(events.map(event => event.eventId)).toEqual(ids);
  expect(events.every(event => event.state === 'authority_committed')).toBe(true);
  await published(); vi.restoreAllMocks();
  expect(await store.listPullEvents(scope, ['authority_committed'])).toEqual([]);
  expect((await store.getCursor(scope))?.cursor).toBe('cursor-1');
  store.close(); expect((await store.listPullEvents(scope, ['page_complete'])).length).toBe(401);
});

test('durable fallback shares the shadow snapshot and sees another connection commit on the next lookup', async () => {
  const { store, indexedDB } = await setup(); const second = await secondConnection(indexedDB);
  await store.putMapping(scope, mapping('native-local', 'local'));
  const before = await store.getMappingByColpId(scope, 'local');
  const ids = Array.from({ length: 401 }, (_, i) => `event-${i}`);
  await store.stagePullPage(scope, page('page', 'cursor-0', 'cursor-1', ids));
  const changed = afterFirstBatch(() => second.putMapping(scope, mapping('native-local', 'local', 'revision-after')));
  expect(await currentPullMapping(store, scope, 'local')).toEqual(before);
  await changed(); vi.restoreAllMocks();
  const after = await currentPullMapping(store, scope, 'local');
  expect(after).toEqual(await second.getMappingByColpId(scope, 'local'));
  expect(after?.projection.revision).toBe('revision-after');
  (after!.projection.content as { title: string }).title = 'caller mutation';
  expect((await currentPullMapping(store, scope, 'local'))?.projection.content?.title).toBe('revision-after');
});

test('405 events across reverse-named pages retain cursor-chain order with completed and pending states', async () => {
  const { store } = await setup(); const ids: string[] = [];
  for (const [n, pageId] of ['z-first', 'm-second', 'a-third'].entries()) {
    const own = Array.from({ length: 135 }, (_, i) => `${pageId}-event-${135 - i}`); ids.push(...own);
    await store.stagePullPage(scope, page(pageId, `cursor-${n}`, `cursor-${n + 1}`, own));
    if (n < 2) await store.completePullPage(scope, pageId);
  }
  expect((await store.listPullEvents(scope)).map(event => event.eventId)).toEqual(ids);
  expect((await store.listPullEvents(scope, [])).map(event => event.eventId)).toEqual(ids);
  expect((await store.listPullEvents(scope, ['authority_committed'])).map(event => event.eventId)).toEqual(ids.slice(270));
});

test('a selected shadow keeps its exact fields and does not validate an unused corrupt durable fallback', async () => {
  const { store } = await setup(); await store.putMapping(scope, mapping('native-target', 'target'));
  const durable = await store.getMappingByColpId(scope, 'target');
  const db = await store.open(); const tx = db.transaction(STORES.mappings, 'readwrite'); const done = transactionDone(tx);
  tx.objectStore(STORES.mappings).put({ ...durable, storageOnly: 'invalid extra field' }); await done;
  await expect(currentPullMapping(store, scope, 'target')).rejects.toThrow();
  await store.stagePullPage(scope, page('page', 'cursor-0', 'cursor-1', ['event'], ['event']));
  await commit(store, scope, 'event', { mappings: [mapping('native-target', 'target', 'revision-shadow')] });
  const shadow = ((await store.getPullEvent(scope, 'event'))!.pendingMappings as MappingInput[])[0];
  expect(await currentPullMapping(store, scope, 'target')).toEqual(shadow);
  expect(await currentPullMapping(store, scope, 'absent')).toBeNull();
});

test('diagnostic-only and retired scopes retain read access without writable authority', async () => {
  const { store, indexedDB } = await setup(); await store.putMapping(scope, mapping('native-target', 'target'));
  const expected = await store.getMappingByColpId(scope, 'target');
  const runtime = createSyncStoreRuntime({ indexedDB });
  try {
    await runtime.open(); runtime.setDiagnosticReadOnly();
    expect(() => runtime.assertWritable()).toThrow();
    expect(await createPullMappingReadRepository(runtime).getCurrentPullMapping(scope, 'target')).toEqual(expected);
  } finally { runtime.close(); }
  await store.retireScope(scope, { retiredAt: 1, reason: 'profile-replaced' });
  expect(await currentPullMapping(store, scope, 'target')).toBeNull();
  await expect(currentPullMapping(store, scope, '')).rejects.toThrow();
  await expect(currentPullMapping(store, { ...scope, generation: -1 }, 'target')).rejects.toThrow();
});

test('an interrupted indexed read rejects instead of returning cached or partial authority', async () => {
  const { store } = await setup(); await store.putMapping(scope, mapping('native-target', 'target'));
  const getAll = IDBIndex.prototype.getAll;
  vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
    const request = getAll.apply(this, args);
    if ([INDEXES.pullEventByState, INDEXES.pullPageByState].includes(this.name)) {
      request.addEventListener('success', () => this.objectStore.transaction.abort(), { once: true });
    }
    return request;
  });
  await expect(currentPullMapping(store, scope, 'target')).rejects.toThrow();
  await expect(store.listPullEvents(scope, ['authority_committed'])).rejects.toThrow();
  await expect(store.listPullPages(scope, ['staged'])).rejects.toThrow();
  vi.restoreAllMocks();
  expect(await currentPullMapping(store, scope, 'target')).toEqual(await store.getMappingByColpId(scope, 'target'));
  expect((await store.getScope(scope))?.lifecycle).toBe('active');
  expect(await store.listQueue(scope)).toEqual([]);
});

test('reading an unpublished mapping cannot bypass the native identity collision guard at publication', async () => {
  const { store } = await setup();
  await store.putMapping(scope, mapping('native-target', 'existing-owner'));
  const original = await store.getMappingByColpId(scope, 'existing-owner');
  await store.stagePullPage(scope, page('page', 'cursor-0', 'cursor-1', ['event'], ['event']));
  await commit(store, scope, 'event', { mappings: [mapping('native-target', 'incoming-owner', 'revision-shadow')] });
  expect((await currentPullMapping(store, scope, 'incoming-owner'))?.projection.revision).toBe('revision-shadow');
  expect(await store.getMappingByColpId(scope, 'incoming-owner')).toBeNull();
  expect(await store.getMappingByColpId(scope, 'existing-owner')).toEqual(original);
  expect((await store.getScope(scope))?.lifecycle).toBe('active');
  await expect(store.completePullPage(scope, 'page')).rejects.toThrow('recovery_required');
  expect(await store.getMappingByColpId(scope, 'existing-owner')).toEqual(original);
  expect(await store.getMappingByColpId(scope, 'incoming-owner')).toBeNull();
  expect((await store.getScope(scope))?.lifecycle).toBe('recovery_required');
  expect((await store.getScope(scope))?.checkpoint?.cursor).toBe('cursor-0');
  expect(await store.getCursor(scope)).toBeFalsy();
  expect(await store.listAckIntents(scope)).toEqual([]);
});
