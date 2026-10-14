import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { localClassificationTags } from '../src/classification-local-tags.js';
import { runLocalClassification } from '../src/sw/classification-local.js';
import { previewLocalClassification } from '../src/classification-local-preview.js';
vi.mock('../src/sw/runtime.js', () => ({ syncState: {} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { throw new Error('signed_out'); } }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set(), isSubscriptionExcluded: async () => false }));
vi.mock('../src/classification-local-session.js', () => ({ localClassificationCredential: async () => ({ generation: 'key' }) }));
vi.mock('../src/classification-local-preview.js', () => ({ previewLocalClassification: vi.fn(async () => ({ folder: null, tags: { candidates: [] } })) }));
afterEach(() => vi.unstubAllGlobals());

test('guests use local tags and overlapping cloud vocabulary is counted once', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { bookmarks: { getTree: async () => [{ id: '0', title: 'Root', children: [{ id: '1', title: 'Bar', children: [{ id: 'f', title: 'Topic' }] }] }] } });
  const store = createBookmarkAnnotationStore();
  try {
    await store.save({ id: 'b' }, { tags: ['Local'], note: null });
    expect(await localClassificationTags([{ tag: 'Local', count: 1 }, { tag: 'Cloud', count: 2 }])).toEqual([{ tag: 'Local', count: 1 }, { tag: 'Cloud', count: 2 }]);
    expect((await runLocalClassification({ document: { source: 'extension', bookmark: { title: 'Page', url: 'https://example.test/', description: null }, requested: { folder: true, tags: true } },
      commandId: 'cmd', generation: 1, signal: new AbortController().signal })).ok).toBe(true);
    expect(previewLocalClassification).toHaveBeenCalledWith(expect.objectContaining({ taxonomy: expect.objectContaining({ tagUsage: [{ tag: 'Local', count: 1 }] }),
      document: expect.objectContaining({ requested: { folder: true, tags: true } }) }));
  } finally { store.close(); }
});

test('a rule’s placement asks for tags only, and sends nothing without a tag vocabulary', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  // No folders at all: a tags-only request does not need any.
  vi.stubGlobal('chrome', { bookmarks: { getTree: async () => [{ id: '0', title: 'Root', children: [] }] } });
  const document = { source: 'extension' as const, bookmark: { title: 'Paper', url: 'https://arxiv.org/abs/1', description: null }, requested: { folder: false, tags: true as const } };
  const run = () => runLocalClassification({ document, commandId: 'cmd', generation: 1, signal: new AbortController().signal });
  vi.mocked(previewLocalClassification).mockClear();
  expect(await run()).toEqual({ ok: false, error: 'local_no_tags' });
  expect(previewLocalClassification).not.toHaveBeenCalled();
  const store = createBookmarkAnnotationStore();
  try {
    await store.save({ id: 'b' }, { tags: ['Papers'], note: null });
    expect((await run()).ok).toBe(true);
    expect(previewLocalClassification).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ requested: { folder: false, tags: true } }) }));
  } finally { store.close(); }
});
