import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { annotationForCaptureStart } from '../src/bookmark-annotation-store.js';
import { validCaptureRequest } from '../src/capture/messages.js';
import { persistCaptureAnnotation } from '../src/sw/capture-annotation.js';
import { task } from './fixtures/capture.js';

const start = { kind: 'known.capture.start', commandId: '11111111-1111-4111-8111-111111111111', trigger: 'manual-popup',
  url: 'https://example.test/a', title: 'A', saveAnother: false, allowUnverifiedCloud: false, userGesture: true };
const node = { id: 'saved', title: 'A', url: 'https://example.test/a', parentId: 'folder', dateAdded: 1 };
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined) }, bookmarks: { get: vi.fn(async () => [node]) } });
});
afterEach(() => vi.unstubAllGlobals());

test('the save form may ask to pin, and only with true', () => {
  expect(validCaptureRequest({ ...start, annotation: { tags: [], note: null, pinned: true } })).toBe(true);
  expect(validCaptureRequest({ ...start, annotation: { tags: [], note: null, pinned: false } })).toBe(false);
  expect(annotationForCaptureStart({ tags: [], note: null, pinned: true })).toEqual({ tags: [], note: null, pinned: true });
  expect(annotationForCaptureStart({ tags: [], note: null })).toBeUndefined();
});

test('a saved bookmark is pinned by the worker, and an unavailable folder still completes the save', async () => {
  const saved = { ...task, disposition: 'new' as const, save: 'local-saved' as const, nativeId: 'saved', annotation: { tags: [], note: null, pinned: true as const } };
  const pin = vi.fn(async () => ({ ok: true as const, blockers: [] }));
  expect(await persistCaptureAnnotation(saved, pin)).toBe(true);
  expect(pin).toHaveBeenCalledWith(node);
  expect(await persistCaptureAnnotation(saved, async () => ({ ok: false, error: 'not_available', blockers: ['insert_bottom'] }))).toBe(true);
  expect(await persistCaptureAnnotation(saved, async () => ({ ok: false, error: 'pin_failed' }))).toBe(false);
  const plain = { ...saved, annotation: { tags: ['a'], note: null } };
  expect(await persistCaptureAnnotation(plain, pin)).toBe(true);
  expect(pin).toHaveBeenCalledTimes(1);
});
