import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { createSyncStateStore } from '../src/sync-state-store.js';
const state = vi.hoisted(() => ({ db: undefined as unknown as SubscriptionStore }));
vi.mock('../src/bookmark-subscriptions/store.js', async original => ({ ...await original<object>(), get subscriptionStore() { return state.db; } }));
import { assertSubscriptionUploadAllowed } from '../src/bookmark-subscriptions/personal-boundary.js';
import { INDEXES, STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { database, leaf, nativeFixture, owned, row } from './bookmark-subscriptions-fixture.js';
import { event, outgoing, personalScope, personalStore, seedEvents } from './bookmark-subscriptions-upload-fixture.js';

const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
  if (state.db) await state.db.close();
});
async function setup() {
  state.db = database();
  const fixture = nativeFixture();
  vi.stubGlobal('chrome', { bookmarks: fixture.api });
  const store = await personalStore(); stores.push(store);
  return { store, fixture };
}
async function exclude(id = 'excluded') {
  await state.db.put('exclusions', { id, nativeId: id, reason: 'preserved', accountId: 'previous-account', serverOrigin: 'https://old.example' });
}
function observeEventReads() {
  const counts = { pointReads: 0, indexReads: 0, rowsRead: 0 };
  const cursor = IDBIndex.prototype.openCursor;
  const get = IDBObjectStore.prototype.get;
  const getAll = IDBObjectStore.prototype.getAll;
  const objectCursor = IDBObjectStore.prototype.openCursor;
  vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, query, direction) {
    const request = cursor.call(this, query, direction);
    if (this.objectStore.name === STORES.bookmarkEvents) {
      expect(this.name).toBe(INDEXES.eventByOperationOrdinal);
      counts.indexReads++;
      request.addEventListener('success', () => { if (request.result) counts.rowsRead++; });
    }
    return request;
  });
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (this.name === STORES.bookmarkEvents) {
      counts.pointReads++;
      request.addEventListener('success', () => { if (request.result) counts.rowsRead++; });
    }
    return request;
  });
  vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === STORES.bookmarkEvents) throw new Error('whole_history_read');
    return getAll.apply(this, args);
  });
  vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === STORES.bookmarkEvents) throw new Error('whole_history_cursor');
    return objectCursor.apply(this, args);
  });
  return counts;
}

test.each([false, true])('upload evidence reads stay bounded as unrelated history grows; exclusions=%s', async exclusions => {
  const { store } = await setup();
  if (exclusions) await exclude();
  const evidence = [];
  for (const historySize of [500, 5000]) {
    await seedEvents(await store.open(), Array.from({ length: historySize }, (_, i) => event(i + 1)));
    const counts = observeEventReads();
    for (let i = 1; i <= 100; i++) await assertSubscriptionUploadAllowed(store, personalScope, outgoing('op-' + i));
    expect(counts).toEqual(exclusions ? { pointReads: 100, indexReads: 100, rowsRead: 100 } : { pointReads: 0, indexReads: 0, rowsRead: 0 });
    evidence.push({ historySize, outgoingOperations: 100, ...counts });
    vi.restoreAllMocks();
  }
  console.log(JSON.stringify({ case: 'bounded-upload-history-evidence', exclusions, evidence }));
});

test.each(['event-id', 'operation-id', 'later-page'] as const)('historical %s evidence blocks upload after its mapping is gone', async identity => {
  const { store } = await setup();
  await exclude();
  if (identity === 'event-id') {
    await seedEvents(await store.open(), [event(1, { eventId: 'outgoing', opId: 'different-operation', nativeId: 'excluded' })]);
  } else {
    const prefix = identity === 'later-page' ? Array.from({ length: 500 }, (_, i) => event(i + 1, { opId: 'outgoing' })) : [];
    await seedEvents(await store.open(), [...prefix, event(prefix.length + 1, { opId: 'outgoing', nativeId: 'excluded' })]);
  }
  expect(await store.listMappings(personalScope)).toEqual([]);
  const counts = observeEventReads();
  await expect(assertSubscriptionUploadAllowed(store, personalScope, outgoing())).rejects.toThrow('subscription_upload_excluded');
  expect(counts.indexReads).toBe(identity === 'event-id' ? 0 : identity === 'later-page' ? 2 : 1);
});

test.each(['ownership', 'root', 'unreceived-create', 'quarantine'] as const)('empty-ledger shortcut retains %s protection without any active subscription', async source => {
  const { store, fixture } = await setup();
  fixture.nodes.set('protected', { id: 'protected', parentId: 'bar', title: 'Protected' });
  if (source === 'ownership') await state.db.put('nodes', owned(row(), leaf(), 'protected'));
  if (source === 'root') await state.db.put('mappings', { ...row(), rootNativeId: 'protected', enabled: false, state: 'paused' });
  if (source === 'unreceived-create') await state.db.put('operations', { id: 'in-flight', mappingId: row().id, generation: 'g1', applyEpoch: 1, kind: 'create', phase: 'issued', parentNativeId: 'protected', createdAt: 0 });
  if (source === 'quarantine') await state.db.put('exclusions', { id: 'protected', nativeId: 'protected', reason: 'quarantine', accountId: 'old-account', serverOrigin: 'https://old.example' });
  await seedEvents(await store.open(), [event(1, { opId: 'outgoing', nativeId: 'protected' })]);
  await expect(assertSubscriptionUploadAllowed(store, personalScope, outgoing())).rejects.toThrow('subscription_upload_excluded');
});

test('operation lookup stays scoped and checks native ancestor exclusions', async () => {
  const { store, fixture } = await setup();
  await exclude();
  const otherScope = scopeKey({ ...personalScope, accountId: 'other-account' });
  await seedEvents(await store.open(), [event(1, { scopeKey: otherScope, opId: 'outgoing', nativeId: 'excluded' })]);
  await expect(assertSubscriptionUploadAllowed(store, personalScope, outgoing())).resolves.toBeUndefined();
  fixture.nodes.set('child', { id: 'child', parentId: 'excluded', title: 'Child' });
  await seedEvents(await store.open(), [event(1, { opId: 'outgoing', nativeId: 'child' })]);
  await expect(assertSubscriptionUploadAllowed(store, personalScope, outgoing())).rejects.toThrow('subscription_upload_excluded');
});

test('storage failure cannot be mistaken for an empty exclusion ledger', async () => {
  const { store } = await setup();
  vi.spyOn(state.db, 'count').mockRejectedValue(new Error('storage_unavailable'));
  await expect(assertSubscriptionUploadAllowed(store, personalScope, outgoing())).rejects.toThrow('storage_unavailable');
});
