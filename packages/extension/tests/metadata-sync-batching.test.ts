import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createBookmarkNoteClient } from '../src/bookmark-note-client.js';
import { reconcileBookmarkNotes } from '../src/bookmark-note-sync.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('unchanged tag observations use one transaction and issue no writes', async () => {
  const factory = new IDBFactory(), store = createBookmarkAnnotationStore({ indexedDB: factory });
  const observations = ['a', 'b'].map(id => ({ bookmark: { id }, binding: { scopeKey: 'scope', resourceId: id, revision: 'r1', value: ['tag'] } }));
  try {
    await store.observeTagsMany(observations);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put'), transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    await store.observeTagsMany(observations); expect(put).not.toHaveBeenCalled(); expect(transaction).toHaveBeenCalledTimes(1);
  } finally { store.close(); }
});
test('a collection snapshot updates more than 20 bookmarks together and unchanged scans skip clean reads', async () => {
  const factory = new IDBFactory(), f = await fixture(factory), annotations = createBookmarkAnnotationStore({ indexedDB: factory });
  const tree = Array.from({ length: 30 }, (_, index) => ({ id: `b-${index}`, title: 'Page', url: `https://example.test/${index}` }));
  try {
    for (const bookmark of tree) await f.store.putMapping(scope, { nativeId: bookmark.id, colpId: `n-${bookmark.id}`, rootNativeId: 'root-selected', nodeKind: 'bookmark',
      projection: { revision: 'r1', digest: 'digest', content: { title: bookmark.title, url: bookmark.url } } });
    const bindings = new Map(tree.map(bookmark => [`n-${bookmark.id}`, { scopeKey: scopeKey(scope), resourceId: `n-${bookmark.id}`, revision: 'note-r1', value: bookmark.id, annotationId: `note-${bookmark.id}`, supported: true }]));
    const read = vi.fn(), send = vi.fn(), readCollection = vi.fn().mockResolvedValueOnce(bindings).mockResolvedValueOnce(null);
    const input = { scope, sync: f.store, annotations, tree, allowed: () => true, assertCurrent: async () => undefined, readCollection, clientFor: () => ({ read, send }) };
    expect(await reconcileBookmarkNotes(input)).toBe(true); expect((await annotations.list()).filter(row => row.note)).toHaveLength(30);
    expect(await reconcileBookmarkNotes(input)).toBe(false); expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  } finally { annotations.close(); f.store.close(); }
});
test('collection clients fence page revisions and bind unchanged caches to the mapping set', async () => {
  const local = new MemoryStorageArea(); vi.stubGlobal('chrome', { storage: { local } });
  const responses: unknown[] = [{ revision: 'r1', annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } },
    { revision: 'r1', unchanged: true, annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } },
    { revision: 'r1', unchanged: true, annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }];
  const request = vi.fn(async () => responses.shift());
  const authority = { serverOrigin: 'https://known.test', accountId: 'a', collectionId: 'c' };
  const client = createBookmarkNoteClient({ ...authority, scopeKey: 'scope', assertCurrent: async () => undefined, transport: { authority, request } });
  const first = await client.readCollection(['n']);
  await local.set({ 'known.annotations.snapshot-revision.v1': { scopeKey: first!.snapshotScopeKey, revision: first!.snapshotRevision } });
  expect(await client.readCollection(['n'])).toBeNull();
  await expect(client.readCollection(['new-node'])).rejects.toThrow('annotation_response_invalid');
});
