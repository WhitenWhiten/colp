import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBIndex } from 'fake-indexeddb';
import { afterEach, test, vi } from 'vitest';
import { PULL_INDEX_PAGE } from '../src/sync-state/pull-workset.js';
import { INDEXES } from '../src/sync-state/schema.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const other: SyncScope = { ...scope, collectionId: 'other-collection' };
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });

async function setup() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  for (const target of [scope, other]) await store.registerScope({ ...target, lifecycle: 'active',
    lease: { leaseId: 'lease', expiresAt: Date.now() + 100_000 },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
  return store;
}

function page(pageId: string, previousCursor: string, nextCursor: string, eventIds: readonly string[]) {
  return { pageId, previousCursor, nextCursor, collectionRevision: `revision-${pageId}`, pageDigest: `sha256:${pageId}`,
    effectPages: [], events: eventIds.map(eventId => ({ eventId, cursor: nextCursor, operationId: `op-${eventId}`,
      effectId: `effect-${eventId}`, effectDigest: `sha256:${eventId}`, operationDigest: `sha256:op-${eventId}`,
      kind: 'node_content_updated', payload: { value: eventId }, initialState: 'authority_committed' as const })) };
}

/** Counts actual IDB result deliveries, with the original implementation always called. */
function observeStateIndex(name: string) {
  const counts = { batches: 0, deliveredRows: 0, cursorRows: 0, maxBatch: 0 };
  const getAll = IDBIndex.prototype.getAll, openCursor = IDBIndex.prototype.openCursor;
  vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, query, limit) {
    const request = getAll.call(this, query, limit);
    if (this.name === name) {
      assert.equal(limit, PULL_INDEX_PAGE, 'each state read has an explicit row bound');
      counts.batches++;
      request.addEventListener('success', () => {
        counts.deliveredRows += request.result.length;
        counts.maxBatch = Math.max(counts.maxBatch, request.result.length);
      });
    }
    return request;
  });
  vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (this: IDBIndex, ...args) {
    const request = openCursor.apply(this, args);
    if (this.name === name) request.addEventListener('success', () => { if (request.result) counts.cursorRows++; });
    return request;
  });
  return counts;
}

for (const count of [0, 1, 199, 200, 201, 958, 1_001]) {
  test(`${count} committed events retain exact ordinal order through bounded state-index reads`, async () => {
    const store = await setup();
    // Ordinals deliberately oppose the unique index order. The other scope has
    // identical page/event identities, so an unbounded range would duplicate them.
    const ids = Array.from({ length: count }, (_, i) => `event-${String(count - i).padStart(4, '0')}`);
    for (const target of [scope, other]) await store.stagePullPage(target, page('z-first', 'cursor-0', 'cursor-1', ids));
    const reads = observeStateIndex(INDEXES.pullEventByState);
    const events = await store.listPullEvents(scope, ['authority_committed']);
    assert.deepEqual(events.map(row => row.eventId), ids);
    assert.equal(reads.cursorRows, 0, 'history reads must not deliver one cursor callback per event');
    assert.equal(reads.batches, Math.floor(count / PULL_INDEX_PAGE) + 1);
    assert.equal(reads.deliveredRows, count);
    assert.ok(reads.maxBatch <= PULL_INDEX_PAGE);
    vi.restoreAllMocks();
    store.close();
    assert.deepEqual((await store.listPullEvents(scope, ['authority_committed'])).map(row => row.eventId), ids,
      'all committed history survives reopening; pagination does not prune or truncate it');
    if (events[0]) {
      (events[0].payload as { value: string }).value = 'caller-mutation';
      assert.deepEqual((await store.getPullEvent(scope, ids[0]!))?.payload, { value: ids[0] });
    }
  });
}

test('a changed state and a new page are read freshly in cursor-chain order after reopening', async () => {
  const store = await setup();
  const ids = Array.from({ length: 201 }, (_, i) => `event-${201 - i}`);
  await store.stagePullPage(scope, page('z-first', 'cursor-0', 'cursor-1', ids));
  assert.equal((await store.listPullEvents(scope, ['authority_committed'])).length, 201);
  await store.completePullPage(scope, 'z-first'); store.close();
  assert.deepEqual(await store.listPullEvents(scope, ['authority_committed']), []);
  await store.stagePullPage(scope, page('a-later', 'cursor-1', 'cursor-2', ['a-new-event']));
  assert.deepEqual((await store.listPullEvents(scope)).map(row => row.eventId), [...ids, 'a-new-event']);
  assert.equal((await store.getCursor(scope))?.cursor, 'cursor-1');
});

for (const count of [200, 201]) {
  test(`${count} completed pages retain the full scope-filtered result at a page boundary`, async () => {
    const store = await setup(); const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `page-${String(count - i).padStart(4, '0')}`; ids.push(id);
      await store.stagePullPage(scope, page(id, `cursor-${i}`, `cursor-${i + 1}`, []));
      await store.completePullPage(scope, id);
    }
    await store.stagePullPage(other, page(ids[0]!, 'cursor-0', 'cursor-1', []));
    await store.completePullPage(other, ids[0]!);
    const reads = observeStateIndex(INDEXES.pullPageByState);
    assert.deepEqual((await store.listPullPages(scope, ['page_complete'])).map(row => row.pageId), [...ids].sort());
    assert.equal(reads.cursorRows, 0);
    assert.equal(reads.batches, Math.floor(count / PULL_INDEX_PAGE) + 1);
    assert.equal(reads.deliveredRows, count);
    assert.ok(reads.maxBatch <= PULL_INDEX_PAGE);
    vi.restoreAllMocks();
    store.close();
    assert.equal((await store.listPullPages(scope, ['page_complete'])).length, count);
    assert.equal((await store.getCursor(scope))?.cursor, `cursor-${count}`);
  });
}
