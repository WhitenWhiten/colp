import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test } from 'vitest';
import { createSyncStateStore, type CommitBookmarkEventInput } from '../src/sync-state-store.js';
import { AUTHORITY_DIGEST, DATABASE_NAME, DATABASE_VERSION, INDEXES, STORES, structuralProblems, upgrade } from '../src/sync-state/schema.js';
import { KNS09_SCHEMA_VERSION } from '../src/kns-09-release.js';
import { committed, event, outgoing, personalScope, personalStore, requestResult, seedEvents } from './bookmark-subscriptions-upload-fixture.js';

const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const preservedStores = [STORES.bookmarkEvents, STORES.queue, STORES.mappings, STORES.receipts];
async function contents(db: IDBDatabase) {
  return Promise.all(preservedStores.map(name => requestResult(db.transaction(name).objectStore(name).getAll())));
}
async function v18Fixture(factory: IDBFactory) {
  const request = factory.open(DATABASE_NAME, 18);
  request.onupgradeneeded = () => {
    // v19 is additive: retain the v18 store layout, remove its sole new index,
    // and stamp v18 metadata before populating the historical records.
    upgrade(request.result, request.transaction!, 18, 256 * 1024);
    request.transaction!.objectStore(STORES.bookmarkEvents).deleteIndex(INDEXES.eventByOperationOrdinal);
    request.transaction!.objectStore(STORES.metadata).put({ key: 'schema', version: 18, authorityDigest: 'clf-v18-confirmation-intents-v1' });
  };
  const db = await requestResult(request);
  await seedEvents(db, [event(1), event(2, { status: 'pending', opId: null })]);
  const tx = db.transaction([STORES.queue, STORES.mappings, STORES.receipts], 'readwrite');
  const done = committed(tx);
  const queued = outgoing('op-1');
  tx.objectStore(STORES.queue).add(queued);
  tx.objectStore(STORES.mappings).add({ scopeKey: queued.scopeKey, nativeId: 'native-1', colpId: 'node-1', parentNativeId: 'bar', revision: 'r1' });
  tx.objectStore(STORES.receipts).add({ scopeKey: queued.scopeKey, receiptId: 'receipt-1', sequence: 1, opId: queued.opId });
  await done;
  const before = await contents(db);
  db.close();
  return before;
}

test('v18 upgrade indexes historical operation aliases without rewriting durable rows', async () => {
  const indexedDB = new IDBFactory();
  const before = await v18Fixture(indexedDB);
  const store = createSyncStateStore({ indexedDB }); stores.push(store);
  const db = await store.open();
  expect(db.version).toBe(DATABASE_VERSION);
  expect(DATABASE_VERSION).toBe(KNS09_SCHEMA_VERSION);
  expect(structuralProblems(db)).toEqual([]);
  expect(await contents(db)).toEqual(before);
  expect(await store.listBookmarkEventsByOperation(personalScope, 'op-1')).toEqual([event(1)]);
  expect(await store.getBookmarkEvent(personalScope, 'event-2')).toMatchObject({ status: 'pending', opId: null });
  expect(await requestResult(db.transaction(STORES.metadata).objectStore(STORES.metadata).get('schema'))).toEqual({ key: 'schema', version: DATABASE_VERSION, authorityDigest: AUTHORITY_DIGEST });
  store.close();
  await expect(requestResult(indexedDB.open(DATABASE_NAME, 18))).rejects.toMatchObject({ name: 'VersionError' });
});

test('aborted v18 upgrade leaves prior data readable and the new index absent', async () => {
  const indexedDB = new IDBFactory();
  const before = await v18Fixture(indexedDB);
  const failed = createSyncStateStore({ indexedDB, injectUpgradeFailure: true }); stores.push(failed);
  await expect(failed.open()).rejects.toThrow('upgrade_failed');
  const old = await requestResult(indexedDB.open(DATABASE_NAME, 18));
  try {
    expect(await contents(old)).toEqual(before);
    expect(old.transaction(STORES.bookmarkEvents).objectStore(STORES.bookmarkEvents).indexNames.contains(INDEXES.eventByOperationOrdinal)).toBe(false);
  } finally { old.close(); }
});

test('an event enters the operation index atomically with its queue commit', async () => {
  const store = await personalStore(); stores.push(store);
  const staged = await store.stageBookmarkEvent(personalScope, { eventId: 'fresh', dedupeKey: 'fresh', nativeId: 'native', kind: 'change', occurredAt: '2026-09-25T00:00:00Z', details: {} });
  const commit: CommitBookmarkEventInput = {
    operation: { type: 'update_node_content', targetId: 'node', payload: { title: 'New' } },
    baseRevision: 'r1', operationRevision: 'local-new',
    validateOperation: () => true, digestOperation: () => 'sha256:new', allocateOperationId: () => 'new-operation',
  };
  await expect(store.commitBookmarkEvent(personalScope, 'fresh', commit, { fault: 'after_event' })).rejects.toThrow('fault_injected');
  expect(await store.listBookmarkEventsByOperation(personalScope, 'new-operation')).toEqual([]);
  expect(await store.getBookmarkEvent(personalScope, 'fresh')).toEqual(staged.event);
  expect(await store.listQueue(personalScope)).toEqual([]);
  const queued = await store.commitBookmarkEvent(personalScope, 'fresh', commit);
  expect(await store.listBookmarkEventsByOperation(personalScope, queued.opId)).toEqual([{ ...staged.event, status: 'processed', opId: queued.opId }]);
  expect(await store.listQueue(personalScope)).toEqual([queued]);
});

test('operation index pagination follows ordinals and validates page budgets', async () => {
  const store = await personalStore(); stores.push(store);
  await seedEvents(await store.open(), [event(2, { opId: 'shared' }), event(7), event(11, { opId: 'shared' }), event(99, { opId: 'shared' })]);
  expect((await store.listBookmarkEventsByOperation(personalScope, 'shared', 0, 2)).map(n => n.ordinal)).toEqual([2, 11]);
  expect((await store.listBookmarkEventsByOperation(personalScope, 'shared', 11, 2)).map(n => n.ordinal)).toEqual([99]);
  expect(await store.listBookmarkEventsByOperation(personalScope, 'shared', 99, 2)).toEqual([]);
  await expect(store.listBookmarkEventsByOperation(personalScope, 'shared', 0, 1001)).rejects.toThrow('limit_exceeded');
});
