import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { resolveIngressBoundary } from '../src/bookmark-event-ingress.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { findBlockingUnsettledAttempt } from '../src/sync-state/queue-live-work.js';
import { DATABASE_NAME, INDEXES, STORES, upgrade } from '../src/sync-state/schema.js';
import { requestValue, transactionDone } from '../src/sync-state/idb.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });

test('capture resolves only selected/private roots and relevant siblings, without materializing the library', async () => {
  const { store, api } = await fixture(new IDBFactory()); stores.push(store);
  const boundedStore = { ...store, listMappings: async () => { throw new Error('whole_library_read'); } };
  const queue = createBookmarkEventQueue({ scope, store: boundedStore, api, autoFlush: false });
  const boundary = await resolveIngressBoundary(boundedStore, scope);
  assert.deepEqual([...boundary.selectedNative], ['root-selected']);
  assert.ok(boundary.privateNative.has('root-private'));
  const node = bookmark('new', 'folder-parent', 0, 'New', 'https://example.test/new'); api.put(node);
  assert.equal((await queue.created(node.id, node)).outcome, 'staged');
  await queue.flush(); assert.equal((await store.listQueue(scope)).length, 1);
});

test('full mapping exports use one scoped read and remain isolated from caller mutation', async () => {
  const { store } = await fixture(new IDBFactory()); stores.push(store);
  const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
  const rows = await store.listMappings(scope);
  assert.ok(rows.length > 1);
  assert.equal(cursor.mock.contexts.filter(source => (source as IDBObjectStore).name === STORES.mappings).length, 0);
  Reflect.set(rows[0]!.projection.content!, 'title', 'mutated');
  assert.notEqual((await store.getMappingByNativeId(scope, rows[0]!.nativeId))?.projection.content?.title, 'mutated');
});

test('per-operation issue admission does not scan mappings when no issue names a node', async () => {
  const { store } = await fixture(new IDBFactory()); stores.push(store);
  await store.putBootstrapRun(scope, { runId: 'syncing', confirmationId: 'confirm', phase: 'syncing',
    bootstrapMode: 'merge', updatedAt: 1 });
  const bounded = { ...store, listMappings: async () => { throw new Error('whole_library_issue_read'); } };
  assert.equal((await readOpenSyncIssues(bounded, scope)).total, 0);
  await store.recordLocalIssue(scope, { code: 'deletion_identity_unproven', nativeId: 'folder-parent', now: 100 });
  const issues = await readOpenSyncIssues(bounded, scope);
  assert.equal(issues.operationalTotal, 1); assert.ok(issues.roots.has('folder-colp'));
});

test('a deletion workset includes native and canonical descendants without reading unrelated mappings', async () => {
  const { store } = await fixture(new IDBFactory()); stores.push(store);
  const key = scopeKey(scope); const db = await store.open();
  const tx = db.transaction(STORES.mappings, 'readwrite'); const done = transactionDone(tx);
  for (let n = 0; n < 1000; n++) tx.objectStore(STORES.mappings).put({ scopeKey: key,
    nativeId: `other-${n}`, colpId: `colp-other-${n}`, rootNativeId: 'unrelated', parentNativeId: 'unrelated',
    projection: { revision: 'r1', digest: 'd1' } });
  await done;
  await store.putMapping(scope, { nativeId: 'native-child', colpId: 'native-colp', rootNativeId: 'root-selected',
    parentNativeId: 'folder-parent', projection: { revision: 'r1', digest: 'd1' } });
  await store.putMapping(scope, { nativeId: 'moved-child', colpId: 'moved-colp', rootNativeId: 'root-selected',
    parentNativeId: 'elsewhere', parentColpId: 'folder-colp', projection: { revision: 'local-move', digest: 'd1' } });
  const original = IDBIndex.prototype.getAll; let read = 0;
  vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => { if (this.objectStore.name === STORES.mappings) read += request.result.length; });
    return request;
  });
  const rows = await store.listMappingSubtree(scope, 'folder-parent');
  assert.deepEqual(rows.map(row => row.nativeId).sort(), ['folder-parent', 'moved-child', 'native-child']);
  assert.equal(read, 2);
});

test('admission reads attempts and claims, independent of thousands of never-sent operations', async () => {
  const { store } = await fixture(new IDBFactory()); stores.push(store);
  const key = scopeKey(scope); const db = await store.open();
  const seed = db.transaction(STORES.queue, 'readwrite'); const seeded = transactionDone(seed);
  for (let n = 1; n <= 2000; n++) seed.objectStore(STORES.queue).put({ scopeKey: key, sequence: n,
    opId: `never-sent-${n}`, status: 'pending', payload: { targetId: `target-${n}` } });
  seed.objectStore(STORES.queue).put({ scopeKey: key, sequence: 2001, opId: 'attempt', status: 'pending',
    attempt: { sessionId: 'session' }, payload: { targetId: 'attempt-target' } });
  seed.objectStore(STORES.queue).put({ scopeKey: key, sequence: 2002, opId: 'claim', status: 'claimed',
    payload: { targetId: 'claim-target' } });
  await seeded;
  let rows = 0; const original = IDBIndex.prototype.openCursor;
  vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, ...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => { if (this.objectStore.name === STORES.queue && request.result) rows++; });
    return request;
  });
  for (const [targetId, expected] of [['unrelated', null], ['attempt-target', 'attempt'], ['claim-target', 'claim']] as const) {
    const tx = db.transaction(STORES.queue, 'readonly'); const done = transactionDone(tx);
    const found = await findBlockingUnsettledAttempt(tx.objectStore(STORES.queue), key, { targetId }); await done;
    assert.equal(found?.opId ?? null, expected);
  }
  assert.ok(rows <= 6, `read ${rows} queue rows`);
});

test('v22 upgrade populates sibling and attempt indexes without changing durable records', async () => {
  const factory = new IDBFactory(); const opened = factory.open(DATABASE_NAME, 22);
  opened.onupgradeneeded = () => {
    const tx = opened.transaction!; upgrade(opened.result, tx, 0, 256 * 1024);
    tx.objectStore(STORES.queue).deleteIndex(INDEXES.queueByAttempt);
    tx.objectStore(STORES.mappings).deleteIndex(INDEXES.mappingByNativeParent);
    tx.objectStore(STORES.mappings).deleteIndex(INDEXES.mappingByColpParent);
    tx.objectStore(STORES.metadata).put({ key: 'schema', version: 22, authorityDigest: 'u22-delete-member-journal-v1' });
  };
  const old = await requestValue(opened); const key = scopeKey(scope);
  const mapping = { scopeKey: key, nativeId: 'child', colpId: 'colp-child', rootNativeId: 'root', parentNativeId: 'root', parentColpId: 'colp-root',
    projection: { revision: 'r1', digest: 'd1' } };
  const queued = { scopeKey: key, sequence: 1, opId: 'old-attempt', status: 'unknown',
    attempt: { sessionId: 'old-session', body: 'exact immutable request' }, payload: { targetId: 'child' } };
  const seed = old.transaction([STORES.mappings, STORES.queue], 'readwrite'); const seeded = transactionDone(seed);
  seed.objectStore(STORES.mappings).put(mapping); seed.objectStore(STORES.queue).put(queued); await seeded; old.close();
  const store = createSyncStateStore({ indexedDB: factory }); stores.push(store); const db = await store.open();
  const tx = db.transaction([STORES.mappings, STORES.queue], 'readonly'); const done = transactionDone(tx);
  assert.deepEqual(await requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByNativeParent).get([key, 'root', 'child'])), mapping);
  assert.deepEqual(await requestValue(tx.objectStore(STORES.mappings).index(INDEXES.mappingByColpParent).get([key, 'colp-root', 'child'])), mapping);
  assert.deepEqual(await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByAttempt).get([key, 'unknown', 'old-session', 1])), queued);
  await done;
});
