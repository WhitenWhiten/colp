import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ANNOTATION_LIMITS, annotationForCaptureStart, createBookmarkAnnotationStore, normalizeAnnotationNote,
  normalizeAnnotationTags } from '../src/bookmark-annotation-store.js';
import { createCaptureStore } from '../src/capture/store.js';
import { createCaptureCoordinator, type CapturePorts } from '../src/capture/coordinator.js';
import { validCaptureRequest } from '../src/capture/messages.js';
import { persistCaptureAnnotation } from '../src/sw/capture-annotation.js';
import { collectAnnotationGarbage, dropRemovedAnnotations, removedNativeIds } from '../src/sw/bookmark-annotations.js';
import { location, task } from './fixtures/capture.js';

let factory: IDBFactory;
let clock = 1_000;
const stores: ReturnType<typeof createBookmarkAnnotationStore>[] = [];
const open = () => { const store = createBookmarkAnnotationStore({ indexedDB: factory, now: () => ++clock }); stores.push(store); return store; };
const bookmark = { id: '10', dateAdded: 100, url: 'https://example.org/a' };
beforeEach(() => { clock = 1000; factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory); });
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllGlobals(); });
test('explicit restoration rebinds only the proven old bookmark and preserves its metadata', async () => {
  const store = open(), restored = { ...bookmark, id: 'restored', dateAdded: 200 };
  await store.save(bookmark, { tags: ['mine'], note: 'keep this note' }); await store.setPinned(bookmark, true);
  await store.rebindExact({ ...bookmark, dateAdded: 999 }, restored);
  expect(await store.get(restored)).toBeNull();
  await store.rebindExact(bookmark, restored);
  expect(await store.get(restored)).toMatchObject({ tags: ['mine'], note: 'keep this note', pinned: true, nativeId: 'restored', dateAdded: 200 });
});

test('tags are trimmed, de-hashed, split on commas, deduplicated by case and capped', () => {
  expect(normalizeAnnotationTags(['  #Reading  list ', 'reading LIST', '', '  ', '#', 'a,b', 'A', 'x\ty'])).toEqual(['Reading list', 'a', 'b', 'x y']);
  expect(normalizeAnnotationTags(Array.from({ length: 100 }, (_, i) => `tag-${i}`))).toHaveLength(ANNOTATION_LIMITS.tags);
  expect(normalizeAnnotationTags(['é'.repeat(100)])[0]).toHaveLength(ANNOTATION_LIMITS.tagLength);
  expect(normalizeAnnotationTags(['😀'.repeat(60)])[0]).toHaveLength(ANNOTATION_LIMITS.tagLength);
  expect(normalizeAnnotationTags(['😀'.repeat(60)])[0]).not.toContain('�');
});

test('notes are plain text with no trailing whitespace and never exceed the UTF-8 limit', () => {
  expect(normalizeAnnotationNote('  first\r\nsecond  \n\n')).toBe('  first\nsecond');
  expect(normalizeAnnotationNote(' \n\t')).toBeNull();
  expect(normalizeAnnotationNote(null)).toBeNull();
  const long = normalizeAnnotationNote('好'.repeat(10_000))!;
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(ANNOTATION_LIMITS.noteBytes);
  expect(long).toBe('好'.repeat(5461));
  expect(long).not.toContain('�');
});

test('annotations work with no account, persist across reopening and bump the version only on change', async () => {
  vi.stubGlobal('chrome', {});
  const first = open();
  const saved = await first.save(bookmark, { tags: ['b', 'a'], note: 'Read later  ' });
  expect(saved).toMatchObject({ nativeId: '10', dateAdded: 100, url: bookmark.url, tags: ['b', 'a'], note: 'Read later', version: 1, updatedAt: 1001 });
  first.close();
  const reopened = open();
  expect(await reopened.get(bookmark)).toEqual(saved);
  expect(await reopened.save(bookmark, { tags: ['b', 'a'], note: 'Read later' })).toEqual(saved);
  expect((await reopened.save(bookmark, { tags: ['b'], note: 'Read later' }))?.version).toBe(2);
  expect(await reopened.save({ id: '10' }, { tags: ['b'], note: 'Changed' })).toMatchObject({ dateAdded: 100, url: bookmark.url, version: 3 });
});

test('a reused native id with another creation date does not inherit or leak the old row', async () => {
  const store = open();
  await store.save(bookmark, { tags: ['old'], note: null });
  expect(await store.get({ ...bookmark, dateAdded: 200 })).toBeNull();
  expect((await store.getMany([{ ...bookmark, dateAdded: 200 }])).size).toBe(0);
  expect(await store.get({ id: '10' })).toMatchObject({ tags: ['old'] });
  expect(await store.save({ ...bookmark, dateAdded: 200 }, { tags: ['new'], note: null })).toMatchObject({ dateAdded: 200, tags: ['new'] });
  expect(await store.get(bookmark)).toBeNull();
});

test('clearing retains a dirty deletion intent, and invalid input is rejected', async () => {
  const store = open();
  await store.save(bookmark, { tags: ['x'], note: 'y' });
  expect(await store.save(bookmark, { tags: [' # ', ','], note: '  \n' })).toMatchObject({ tags: [], note: null,
    tagsSync: { state: 'dirty' }, noteSync: { state: 'dirty' } });
  expect(await store.get(bookmark)).toMatchObject({ tags: [], note: null });
  expect(await store.save({ id: 'never-saved' }, { tags: [], note: null })).toBeNull();
  await expect(store.save(bookmark, { tags: 'x' as never, note: null })).rejects.toThrow('bookmark_annotation_invalid');
  await expect(store.save(bookmark, { tags: [1 as never], note: null })).rejects.toThrow('bookmark_annotation_invalid');
  await expect(store.save(bookmark, { tags: [], note: 5 as never })).rejects.toThrow('bookmark_annotation_invalid');
  await expect(store.save(bookmark, { tags: [], note: 'x'.repeat(300_000) })).rejects.toThrow('bookmark_annotation_invalid');
  expect(await store.list()).toHaveLength(1);
});

test('tag counts, search and bulk reads cover every row', async () => {
  const store = open();
  await store.save({ id: '1', dateAdded: 1 }, { tags: ['Zeta', 'alpha'], note: 'Recipe for Pasta' });
  await store.save({ id: '2', dateAdded: 2 }, { tags: ['zeta', 'beta'], note: null });
  await store.save({ id: '3', dateAdded: 3 }, { tags: ['Zeta'], note: 'pasta again' });
  expect(await store.tagCounts()).toEqual([{ tag: 'Zeta', count: 3 }, { tag: 'alpha', count: 1 }, { tag: 'beta', count: 1 }]);
  expect([...await store.search('PASTA')].sort()).toEqual(['1', '3']);
  expect([...await store.search(' bet ')]).toEqual(['2']);
  expect(await store.search('   ')).toEqual([]);
  expect(await store.search('missing')).toEqual([]);
  expect([...(await store.getMany([{ id: '1', dateAdded: 1 }, { id: '3', dateAdded: 9 }, { id: '4' }])).keys()]).toEqual(['1']);
  await store.remove('2');
  expect((await store.list()).map(row => row.nativeId).sort()).toEqual(['1', '3']);
});

test('a save request carries a bounded annotation field that the helper normalizes', () => {
  const base = { kind: 'known.capture.start', commandId: '12345678-1234-4123-8123-123456789abc', trigger: 'manual-popup', userGesture: true,
    url: 'https://example.org/', title: 'Page', saveAnother: false, allowUnverifiedCloud: true };
  expect(validCaptureRequest(base)).toBe(true);
  expect(validCaptureRequest({ ...base, annotation: { tags: ['a'], note: null } })).toBe(true);
  expect(validCaptureRequest({ ...base, annotation: { tags: [], note: 'x'.repeat(20_000) } })).toBe(true);
  for (const annotation of [{ tags: ['a'] }, { tags: 'a', note: null }, { tags: [1], note: null }, { tags: ['a'], note: 7 },
    { tags: ['a'], note: null, extra: true }, { tags: Array(129).fill('a'), note: null }, { tags: ['a'.repeat(201)], note: null },
    { tags: [], note: 'x'.repeat(20_001) }, [], null]) {
    expect(validCaptureRequest({ ...base, annotation })).toBe(false);
  }
  expect(annotationForCaptureStart({ tags: [' #A ', 'a'], note: ' Hi \n' })).toEqual({ tags: ['A'], note: ' Hi' });
  expect(annotationForCaptureStart({ tags: [], note: '  ' })).toBeUndefined();
  expect(annotationForCaptureStart(undefined)).toBeUndefined();
});

function captureHarness(node: { id: string; url?: string; dateAdded?: number } | undefined) {
  vi.stubGlobal('chrome', { bookmarks: { get: vi.fn(async () => node ? [node] : []) } });
  const store = createCaptureStore(new IDBFactory());
  const ports: CapturePorts = { store, now: () => 10, assertCurrent: async () => undefined,
    existence: async () => ({ kind: 'not-found', exact: [], similar: [],
      coverage: { local: 'complete', cloud: 'complete', collectionIds: ['c'], checkedAt: 1, stale: false } }),
    create: async (_task, reserved) => { await reserved('intent'); return { nativeId: '1', location, sync: 'pending' }; },
    receipt: async () => null, acknowledge: persistCaptureAnnotation };
  return { store, ports };
}
const annotated = { ...task, source: 'manual-popup' as const, annotation: { tags: ['saved'], note: 'From the popup' } };

test('the worker keeps the popup annotation once the task is local-saved, with the popup already gone', async () => {
  const { store, ports } = captureHarness({ id: '1', url: location.url, dateAdded: 77 });
  try {
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start(annotated);
    expect((await coordinator.resume(task.scope, task.captureId)).save).toBe('local-saved');
    expect(await open().get({ id: '1', dateAdded: 77 })).toMatchObject({ tags: ['saved'], note: 'From the popup', url: location.url });
  } finally { await store.close(); }
});

test('worker persistence keeps canonical labels and retained overflow/legacy members exactly', async () => {
  vi.stubGlobal('chrome', { bookmarks: { get: vi.fn(async () => [{ id: 'canonical', dateAdded: 77, url: location.url }]) } });
  const tags = ['#topic,section', '😀'.repeat(48), ...Array.from({ length: 80 }, (_, i) => `tag-${i}`)];
  await persistCaptureAnnotation({ ...task, disposition: 'new', save: 'local-saved', nativeId: 'canonical', annotation: { tags, note: null } });
  expect((await open().get({ id: 'canonical', dateAdded: 77 }))?.tags).toEqual(tags);
});

test('a restarted worker that recovers an unknown receipt still writes the annotation, once', async () => {
  const { store, ports } = captureHarness({ id: '1', url: location.url, dateAdded: 77 });
  try {
    ports.receipt = async () => ({ nativeId: '1', location, sync: 'pending' });
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start({ ...annotated, save: 'unknown', nativeIntentId: 'prior' });
    expect((await coordinator.resume(task.scope, task.captureId)).save).toBe('local-saved');
    const annotations = open();
    expect(await annotations.get({ id: '1' })).toMatchObject({ tags: ['saved'], version: 1 });
    await annotations.save({ id: '1', dateAdded: 77 }, { tags: ['edited'], note: null });
    await persistCaptureAnnotation({ ...annotated, save: 'local-saved', nativeId: '1' });
    expect(await annotations.get({ id: '1' })).toMatchObject({ tags: ['edited'], version: 2 });
  } finally { await store.close(); }
});

test('a save that resolved to an existing bookmark, or a failed one, writes nothing', async () => {
  const { store, ports } = captureHarness({ id: '1', url: location.url, dateAdded: 77 });
  try {
    ports.existence = async () => ({ kind: 'local', exact: [location], similar: [],
      coverage: { local: 'complete', cloud: 'complete', collectionIds: ['c'], checkedAt: 1, stale: false } });
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start(annotated);
    expect((await coordinator.resume(task.scope, task.captureId)).disposition).toBe('existing');
    await persistCaptureAnnotation({ ...annotated, disposition: 'existing', save: 'local-saved', nativeId: '1' });
    await persistCaptureAnnotation({ ...annotated, save: 'failed', nativeId: null });
    expect(await open().list()).toEqual([]);
  } finally { await store.close(); }
});

test('removing a bookmark or a whole folder drops the matching annotations, whatever the permission or sync state', async () => {
  const store = open();
  for (const id of ['1', '2', '3', '4']) await store.save({ id, dateAdded: 1 }, { tags: ['t'], note: null });
  const node = { id: 'folder', children: [{ id: '1' }, { id: 'inner', children: [{ id: '2' }] }] };
  expect(removedNativeIds('folder', node).sort()).toEqual(['1', '2', 'folder', 'inner']);
  await dropRemovedAnnotations({ nativeId: 'folder', removal: { node } }, open());
  expect((await open().list()).map(row => row.nativeId).sort()).toEqual(['3', '4']);
  await dropRemovedAnnotations({ nativeId: '3', removal: {} }, open());
  expect((await open().list()).map(row => row.nativeId)).toEqual(['4']);
});

test('garbage collection drops rows for missing, reused and folder ids, and does nothing without access or a tree', async () => {
  const store = open();
  await store.save({ id: 'live', dateAdded: 1 }, { tags: ['keep'], note: null });
  await store.save({ id: 'gone', dateAdded: 1 }, { tags: ['drop'], note: null });
  await store.save({ id: 'reused', dateAdded: 1 }, { tags: ['drop'], note: null });
  await store.save({ id: 'folder', dateAdded: 1 }, { tags: ['drop'], note: null });
  const tree = [{ id: '0', title: '', children: [{ id: 'bar', title: 'Bar', children: [
    { id: 'live', title: 'L', url: 'https://a.test/', dateAdded: 1 }, { id: 'reused', title: 'R', url: 'https://b.test/', dateAdded: 2 },
    { id: 'folder', title: 'F', children: [] }] }] }];
  const chromeApi = (granted: boolean, nodes: unknown) => ({ permissions: { contains: async () => granted }, bookmarks: { getTree: async () => nodes } });
  vi.stubGlobal('chrome', chromeApi(false, tree));
  expect(await collectAnnotationGarbage(open())).toBe(0);
  vi.stubGlobal('chrome', chromeApi(true, [{ id: '0', title: '' }]));
  expect(await collectAnnotationGarbage(open())).toBe(0);
  expect(await open().list()).toHaveLength(4);
  vi.stubGlobal('chrome', chromeApi(true, tree));
  expect(await collectAnnotationGarbage(open())).toBe(3);
  expect((await open().list()).map(row => row.nativeId)).toEqual(['live']);
});
