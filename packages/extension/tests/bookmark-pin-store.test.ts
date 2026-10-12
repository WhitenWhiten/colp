import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { annotationPinField, createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';

let factory: IDBFactory;
let clock = 1_000;
const stores: ReturnType<typeof createBookmarkAnnotationStore>[] = [];
const open = () => { const store = createBookmarkAnnotationStore({ indexedDB: factory, now: () => ++clock }); stores.push(store); return store; };
const bookmark = { id: '10', dateAdded: 100, url: 'https://example.org/a' };
const binding = (value: boolean, revision = 'r1') => ({ scopeKey: 'scope', resourceId: 'node-10', revision, value,
  extensions: value ? '{"https://known.example/extensions/bookmark-pin-v1":{"pinned":true}}' : '{}' });
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory); vi.stubGlobal('chrome', {}); });
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); });

test('pinning records a dirty flag, unpinning keeps the intent, and repeats are no-ops', async () => {
  const store = open();
  expect(await store.setPinned(bookmark, false)).toBeNull();
  const pinned = await store.setPinned(bookmark, true);
  expect(pinned).toMatchObject({ pinned: true, tags: [], note: null, pinSync: { value: true, state: 'dirty' } });
  expect(await store.setPinned(bookmark, true)).toEqual(pinned);
  const unpinned = await store.setPinned(bookmark, false);
  expect(unpinned?.pinned).toBeUndefined();
  expect(unpinned?.pinSync).toMatchObject({ value: false, state: 'dirty' });
});

test('tag and note saves keep the pin', async () => {
  const store = open();
  await store.setPinned(bookmark, true);
  const saved = await store.save(bookmark, { tags: ['a'], note: 'n' });
  expect(saved).toMatchObject({ pinned: true, tags: ['a'], note: 'n', pinSync: { value: true } });
});

test('a remote pin is adopted where this browser never recorded one, and a local pin survives a remote baseline', async () => {
  const store = open();
  await store.save(bookmark, { tags: ['a'], note: null });
  await store.observePinsMany([{ bookmark, binding: binding(true) }]);
  const adopted = await store.get(bookmark);
  expect(adopted).toMatchObject({ pinned: true, pinSync: { state: 'synced', value: true } });
  expect(annotationPinField(adopted!)?.remote?.extensions).toContain('bookmark-pin-v1');

  const other = { id: '11', dateAdded: 101, url: 'https://example.org/b' };
  await store.setPinned(other, true);
  await store.observePinsMany([{ bookmark: other, binding: { ...binding(false), resourceId: 'node-11' } }]);
  expect(await store.get(other)).toMatchObject({ pinned: true, pinSync: { state: 'dirty', value: true } });
});

test('an attempt is recorded only for a dirty bound pin, and its echo settles it', async () => {
  const store = open();
  await store.observePinsMany([{ bookmark, binding: binding(false) }]);
  await store.setPinned(bookmark, true);
  const field = annotationPinField((await store.get(bookmark))!)!;
  const attempted = await store.markPinAttempt(bookmark, field, 'event-1');
  expect(attempted?.pinSync?.attempt).toMatchObject({ value: true, eventId: 'event-1', resourceId: 'node-10' });
  await store.observePinsMany([{ bookmark, binding: binding(true, 'r2') }]);
  expect(await store.get(bookmark)).toMatchObject({ pinned: true, pinSync: { state: 'synced', value: true } });
});

test('signing out to another authority keeps the pin as a local intent', async () => {
  const store = open();
  await store.observePinsMany([{ bookmark, binding: binding(true) }]);
  await store.releaseBindings([bookmark]);
  expect(await store.get(bookmark)).toMatchObject({ pinned: true, pinSync: { state: 'dirty', value: true } });
});
