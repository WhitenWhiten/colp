import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore, IDBIndex } from 'fake-indexeddb';
import { beforeEach, describe, test, vi } from 'vitest';
import { FAVICON_SIDECAR_DATABASE, FAVICON_SIDECAR_TTL_MS, FAVICON_SIDECAR_VERSION,
  createFaviconSidecarStore } from '../src/favicon-sidecar-store.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('BF-06 favicon sidecar IndexedDB', () => {
  test('uses a dedicated database and does not bump Phase 3 version 8', () => {
    assert.equal(FAVICON_SIDECAR_DATABASE, 'known-favicon-sidecar');
    assert.equal(FAVICON_SIDECAR_VERSION, 2);
    assert.equal(FAVICON_SIDECAR_TTL_MS, 15 * 60 * 1_000);
  });

  test('persists nativeId contentType bytes and commandId and reopens them', async () => {
    const store = createFaviconSidecarStore({ indexedDB });
    await store.put({
      nativeId: 'bookmark-1', contentType: 'image/png', bytes: PNG, commandId: 'c0ffee00-0000-4000-8000-000000000001',
      collectionId: 'collection-1', createdAt: 1_000, attempts: 0, notBefore: 0,
    });
    store.close();
    const reopened = createFaviconSidecarStore({ indexedDB });
    const row = await reopened.get('bookmark-1');
    assert.equal(row?.nativeId, 'bookmark-1');
    assert.equal(row?.contentType, 'image/png');
    assert.equal(row?.commandId, 'c0ffee00-0000-4000-8000-000000000001');
    assert.deepEqual(new Uint8Array(row!.bytes), PNG);
  });

  test('discards expired rows without returning them as ready', async () => {
    const createdAt = 10_000;
    const store = createFaviconSidecarStore({ indexedDB, now: () => createdAt + FAVICON_SIDECAR_TTL_MS + 1 });
    await store.put({
      nativeId: 'bookmark-old', contentType: 'image/png', bytes: PNG, commandId: 'c0ffee00-0000-4000-8000-000000000002',
      collectionId: 'collection-1', createdAt, attempts: 0, notBefore: 0,
    });
    assert.deepEqual(await store.listReady('collection-1'), []);
    assert.equal(await store.get('bookmark-old'), null);
  });

  test('cleanup streams rows and batches expired deletions without getAll', async () => {
    const store = createFaviconSidecarStore({ indexedDB, now: () => FAVICON_SIDECAR_TTL_MS + 100 });
    for (const [nativeId, collectionId, createdAt] of [
      ['old-1', 'active', 1], ['old-2', 'active', 1], ['old-other', 'other', 1], ['fresh', 'active', 100],
    ] as const) await store.put({ nativeId, collectionId, createdAt,
      contentType: 'image/png', bytes: PNG, commandId: nativeId });
    const wholeStore = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => { throw new Error('getAll'); });
    const wholeIndex = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(() => { throw new Error('getAll'); });
    try {
      assert.equal(await store.prune('active'), 1);
      assert.deepEqual((await store.listReady('active')).map(row => row.nativeId), ['fresh']);
      assert.equal(await store.get('old-1'), null);
      assert.equal(await store.get('old-2'), null);
    } finally { wholeStore.mockRestore(); wholeIndex.mockRestore(); store.close(); }
  });

  test('prune removes only expired rows of no-longer-active collections', async () => {
    const createdAt = 10_000;
    const store = createFaviconSidecarStore({ indexedDB, now: () => createdAt + FAVICON_SIDECAR_TTL_MS + 1 });
    await store.put({
      nativeId: 'active-fresh', contentType: 'image/png', bytes: PNG, commandId: 'c0ffee00-0000-4000-8000-000000000100',
      collectionId: 'collection-active', createdAt: createdAt + FAVICON_SIDECAR_TTL_MS, attempts: 0, notBefore: 0,
    });
    await store.put({
      nativeId: 'active-expired', contentType: 'image/png', bytes: PNG, commandId: 'c0ffee00-0000-4000-8000-000000000101',
      collectionId: 'collection-active', createdAt, attempts: 0, notBefore: 0,
    });
    await store.put({
      nativeId: 'other-fresh', contentType: 'image/png', bytes: PNG, commandId: 'c0ffee00-0000-4000-8000-000000000102',
      collectionId: 'collection-old', createdAt: createdAt + FAVICON_SIDECAR_TTL_MS, attempts: 0, notBefore: 0,
    });
    await store.put({
      nativeId: 'other-expired', contentType: 'image/png', bytes: PNG, commandId: 'c0ffee00-0000-4000-8000-000000000103',
      collectionId: 'collection-old', createdAt, attempts: 0, notBefore: 0,
    });
    const pruned = await store.prune('collection-active');
    assert.equal(pruned, 1);
    assert.ok(await store.get('active-fresh'), 'active rows are never pruned');
    assert.ok(await store.get('active-expired'), 'even an expired ACTIVE row is the drain\'s own TTL decision');
    assert.ok(await store.get('other-fresh'), 'fresh rows of other collections are kept');
    assert.equal(await store.get('other-expired'), null);
  });
});
