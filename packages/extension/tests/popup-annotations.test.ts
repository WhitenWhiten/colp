// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import {
  captureAnnotation, hasAnnotation, loadAnnotation, loadTagCounts, sameAnnotation, saveAnnotation, setAnnotationStore, closeAnnotationStore,
  type AnnotationStore,
} from '../src/popup-annotations.js';

const bookmark = { id: '7', url: 'https://example.org/a', dateAdded: 5 };
function fake(overrides: Partial<Record<keyof AnnotationStore, unknown>> = {}) {
  const store = { get: vi.fn(async () => null), save: vi.fn(async () => null), tagCounts: vi.fn(async () => []), close: vi.fn(), ...overrides };
  setAnnotationStore(store as unknown as AnnotationStore);
  return store;
}
afterEach(() => { setAnnotationStore(undefined); });

test('a bookmark without a record reads as empty', async () => {
  fake();
  expect(await loadAnnotation(bookmark)).toEqual({ tags: [], note: '' });
});

test('a stored record comes back with its tags and a note that is never null', async () => {
  fake({ get: vi.fn(async () => ({ nativeId: '7', url: bookmark.url, tags: ['a', 'b'], note: null, updatedAt: 1, version: 1 })) });
  expect(await loadAnnotation(bookmark)).toEqual({ tags: ['a', 'b'], note: '' });
});

test('a failing store never blocks the popup: reads are empty and writes report false', async () => {
  fake({ get: vi.fn(async () => { throw new Error('idb'); }), save: vi.fn(async () => { throw new Error('idb'); }),
    tagCounts: vi.fn(async () => { throw new Error('idb'); }) });
  expect(await loadAnnotation(bookmark)).toEqual({ tags: [], note: '' });
  expect(await saveAnnotation(bookmark, { tags: ['a'], note: '' })).toBe(false);
  expect(await loadTagCounts()).toEqual([]);
});

test('save hands the bookmark and the annotation to the store', async () => {
  const store = fake();
  expect(await saveAnnotation(bookmark, { tags: ['a'], note: 'n' })).toBe(true);
  expect(store.save).toHaveBeenCalledWith(bookmark, { tags: ['a'], note: 'n' }, { preserveTags: true });
});

test('tag counts come from the store', async () => {
  fake({ tagCounts: vi.fn(async () => [{ tag: 'x', count: 2 }]) });
  expect(await loadTagCounts()).toEqual([{ tag: 'x', count: 2 }]);
});

test('hasAnnotation ignores blanks; comparisons ignore order but preserve cloud tag identities', () => {
  expect(hasAnnotation({ tags: [' '], note: '  ' })).toBe(false);
  expect(hasAnnotation({ tags: ['a'], note: '' })).toBe(true);
  expect(hasAnnotation({ tags: [], note: 'x' })).toBe(true);
  expect(sameAnnotation({ tags: ['B', 'a'], note: 'hi  ' }, { tags: ['a', 'B'], note: 'hi' })).toBe(true);
  expect(sameAnnotation({ tags: ['B', 'a'], note: 'hi' }, { tags: ['a', 'b'], note: 'hi' })).toBe(false);
  expect(sameAnnotation({ tags: ['a'], note: '' }, { tags: ['a', 'b'], note: '' })).toBe(false);
});

test('capture start carries nothing for an empty annotation and preserves structured tag labels', () => {
  expect(captureAnnotation({ tags: [], note: '  ' })).toBeUndefined();
  expect(captureAnnotation({ tags: ['#a, b'], note: 'hello  ' })).toEqual({ tags: ['#a, b'], note: 'hello' });
});

test('closing releases only a store the module opened itself', () => {
  const store = fake();
  closeAnnotationStore();
  expect(store.close).not.toHaveBeenCalled();
});
