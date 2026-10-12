import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createCaptureStore } from '../src/capture/store.js';
import { createCaptureCoordinator, type CapturePorts } from '../src/capture/coordinator.js';
import { persistCaptureAnnotation } from '../src/sw/capture-annotation.js';
import { task, location } from './fixtures/capture.js';
afterEach(() => vi.unstubAllGlobals());

test('failed annotation persistence retries after restart without repeating native creation', async () => {
  const factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  const get = vi.fn().mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValue([{ id: '1', url: location.url, title: 'Page' }]);
  vi.stubGlobal('chrome', { bookmarks: { get } });
  const store = createCaptureStore(factory), annotations = createBookmarkAnnotationStore();
  const create = vi.fn<CapturePorts['create']>(async (_task, reserved) => { await reserved('intent'); return { nativeId: '1', location, sync: 'pending' }; });
  const ports: CapturePorts = { store, now: () => 10, assertCurrent: async () => undefined,
    existence: async () => ({ kind: 'not-found', exact: [], similar: [], coverage: { local: 'complete', cloud: 'complete', collectionIds: ['c'], checkedAt: 1, stale: false } }),
    create, receipt: async () => null, acknowledge: persistCaptureAnnotation };
  try {
    const coordinator = createCaptureCoordinator(ports);
    await coordinator.start({ ...task, automaticIntent: false, classification: 'none', annotation: { tags: ['Typed'], note: 'Typed note' } });
    expect((await coordinator.resume(task.scope, task.captureId)).annotationPersisted).not.toBe(true);
    expect((await createCaptureCoordinator(ports).resume(task.scope, task.captureId)).annotationPersisted).toBe(true);
    expect(create).toHaveBeenCalledTimes(1); expect(await annotations.get({ id: '1' })).toMatchObject({ tags: ['Typed'], note: 'Typed note' });
    await createCaptureCoordinator(ports).resume(task.scope, task.captureId); expect(get).toHaveBeenCalledTimes(2);
  } finally { annotations.close(); await store.close(); }
});

test('empty sync rows do not block original annotations; later user edits win over retries', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory()); const bookmark = { id: '1', url: location.url };
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [bookmark] } });
  const annotations = createBookmarkAnnotationStore();
  const saved = { ...task, save: 'local-saved' as const, nativeId: '1', annotation: { tags: ['Typed'], note: 'Typed note' } };
  try {
    await annotations.observeTags(bookmark, { scopeKey: 'scope', resourceId: 'node', revision: 'r1', value: [] });
    expect(await persistCaptureAnnotation(saved)).toBe(true);
    expect(await annotations.get(bookmark)).toMatchObject({ tags: ['Typed'], note: 'Typed note' });
    await annotations.save(bookmark, { tags: ['Later'], note: 'Later edit' }); await persistCaptureAnnotation(saved);
    expect(await annotations.get(bookmark)).toMatchObject({ tags: ['Later'], note: 'Later edit' });
  } finally { annotations.close(); }
});

test('a later edit restored by native undo still wins over a pending capture annotation', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const bookmark = { id: '1', title: 'Page', dateAdded: 77, url: location.url };
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [bookmark] } });
  const annotations = createBookmarkAnnotationStore();
  try {
    await annotations.save(bookmark, { tags: ['Later'], note: 'Later edit' });
    await annotations.remove(bookmark.id); await annotations.restoreRemoved(bookmark);
    await persistCaptureAnnotation({ ...task, save: 'local-saved', nativeId: '1', annotation: { tags: ['Typed'], note: 'Earlier capture' } });
    expect(await annotations.get(bookmark)).toMatchObject({ tags: ['Later'], note: 'Later edit' });
  } finally { annotations.close(); }
});
