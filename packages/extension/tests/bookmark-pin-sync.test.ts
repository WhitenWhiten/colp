import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { BOOKMARK_PIN_EXTENSION } from '../src/bookmark-pin-order.js';
import { importBookmarkPinSnapshot, reconcileBookmarkPins } from '../src/bookmark-pin-sync.js';
import type { CompleteRemoteSnapshot } from '../src/bootstrap/remote-snapshot.js';
import { fixture, scope } from './bookmark-event-queue-harness.js';
import type { JsonObject } from '../src/sync-state-store.js';

const bookmark = { id: 'mapped', title: 'Page', parentId: 'root-selected', dateAdded: 7, url: 'https://example.test/' };
const other = { 'https://other.example/ns': { kept: true } };
let factory: IDBFactory, f: Awaited<ReturnType<typeof fixture>>, annotations: ReturnType<typeof createBookmarkAnnotationStore>;
const input = () => ({ scope, sync: f.store, annotations, tree: [bookmark], queue: f.queue,
  allowed: () => true, assertCurrent: async () => undefined });
async function project(extensions: JsonObject, revision = 'server-revision-7') {
  const { scopeKey: _key, ...mapping } = (await f.store.getMappingByNativeId(scope, bookmark.id))!;
  await f.store.putMapping(scope, { ...mapping, nodeKind: 'bookmark', projection: { ...mapping.projection, revision,
    content: { title: bookmark.title, url: bookmark.url, tags: [], ...(Object.keys(extensions).length ? { extensions } : {}) } } });
}
beforeEach(async () => {
  factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  f = await fixture(factory, { mappedNode: true }); annotations = createBookmarkAnnotationStore({ indexedDB: factory });
  f.api.put(bookmark);
  await project(other);
});
afterEach(() => { annotations.close(); f.store.close(); vi.unstubAllGlobals(); });

test('a local pin uploads as the whole extension map with only the pin namespace changed', async () => {
  await annotations.setPinned(bookmark, true);
  expect(await reconcileBookmarkPins(input())).toMatchObject({ staged: 1 });
  await f.queue.flush();
  expect((await f.store.listQueue(scope))[0]?.payload).toMatchObject({ type: 'update_node_content', targetId: 'mapped-colp',
    baseRevision: 'server-revision-7',
    payload: { base: { extensions: other }, value: { extensions: { ...other, [BOOKMARK_PIN_EXTENSION]: { pinned: true } } } } });
  expect((await annotations.get(bookmark))?.pinSync?.state).toBe('dirty');
});

test('a remote pin is adopted, reported for placement, and an unpin goes back up', async () => {
  await project({ ...other, [BOOKMARK_PIN_EXTENSION]: { pinned: true } });
  expect(await reconcileBookmarkPins(input())).toEqual({ staged: 0, changedParents: ['root-selected'] });
  expect(await annotations.get(bookmark)).toMatchObject({ pinned: true, pinSync: { state: 'synced' } });
  expect(await reconcileBookmarkPins(input())).toEqual({ staged: 0, changedParents: [] });
  await annotations.setPinned(bookmark, false);
  expect(await reconcileBookmarkPins(input())).toMatchObject({ staged: 1 });
  await f.queue.flush();
  expect((await f.store.listQueue(scope))[0]?.payload).toMatchObject({
    payload: { base: { extensions: { ...other, [BOOKMARK_PIN_EXTENSION]: { pinned: true } } }, value: { extensions: other } } });
});

test('unpinned bookmarks this browser never pinned create no rows, and private ones author nothing', async () => {
  expect(await reconcileBookmarkPins(input())).toEqual({ staged: 0, changedParents: [] });
  expect(await annotations.get(bookmark)).toBeNull();
  await annotations.setPinned(bookmark, true);
  expect(await reconcileBookmarkPins({ ...input(), allowed: () => false })).toEqual({ staged: 0, changedParents: [] });
});

test('first sync adopts a remote pin and reports its folder for placement', async () => {
  const snapshot = (extensions: JsonObject) => ({ remoteFacts: [{ nodeId: 'mapped-colp', kind: 'bookmark', title: bookmark.title,
    url: bookmark.url, revision: 'server-revision-7', extensions }] }) as unknown as CompleteRemoteSnapshot;
  expect(await importBookmarkPinSnapshot(input(), snapshot({ ...other, [BOOKMARK_PIN_EXTENSION]: { pinned: true } })))
    .toEqual({ changedParents: ['root-selected'] });
  expect((await annotations.get(bookmark))?.pinned).toBe(true);
  // Importing the same state again moves nothing.
  expect(await importBookmarkPinSnapshot(input(), snapshot({ ...other, [BOOKMARK_PIN_EXTENSION]: { pinned: true } })))
    .toEqual({ changedParents: [] });
});
