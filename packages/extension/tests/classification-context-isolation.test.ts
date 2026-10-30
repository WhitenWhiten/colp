import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { readClassificationContext } from '../src/classification-local-context.js';
const f = vi.hoisted(() => ({ tags: vi.fn(async () => { throw Error('annotation_store_unavailable'); }),
  descriptions: vi.fn(async () => { throw Error('description_store_unavailable'); }), preview: vi.fn(async () => ({ folder: null })) }));
vi.mock('../src/classification-local-session.js', () => ({ localClassificationCredential: async () => ({ generation: 'key' }) }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { throw Error('not_connected'); } }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: {} }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => [], isSubscriptionExcluded: async () => false }));
vi.mock('../src/sw/classification-destination.js', () => ({ classificationDestinationPolicy: { snapshot: async () => ({ digest: 'digest', excluded: [] }) } }));
vi.mock('../src/folder-description-native.js', () => ({ readNativeFolderDescriptions: f.descriptions }));
vi.mock('../src/classification-local-taxonomy.js', () => ({ nativeClassificationFolders: () => [{ id: 'folder', title: 'Folder', parentId: null }] }));
vi.mock('../src/classification-local-tags.js', () => ({ localClassificationTags: f.tags }));
vi.mock('../src/classification-local-preview.js', () => ({ previewLocalClassification: f.preview }));
import { runLocalClassification } from '../src/sw/classification-local.js';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
const run = (folder: boolean, tags: boolean) => {
  vi.stubGlobal('chrome', { storage: { session: new MemoryStorageArea() }, bookmarks: { getTree: async () => [] } });
  return runLocalClassification({ document: { source: 'extension', bookmark: { title: 'Article', url: 'https://example.org', description: null },
    requested: { folder, tags } as { folder: true; tags: boolean } }, commandId: 'command', generation: 0, signal: new AbortController().signal });
};
test('folder-only suggestions never open the tag database and survive description failures', async () => {
  expect((await run(true, false)).ok).toBe(true);
  expect(f.tags).not.toHaveBeenCalled(); expect(f.preview).toHaveBeenCalledOnce();
  expect(await readClassificationContext()).toMatchObject({ warnings: ['folder_descriptions_unavailable'] });
});
test('missing optional vocabulary degrades to folder suggestions and records the cause', async () => {
  expect((await run(true, true)).ok).toBe(true);
  expect(f.preview).toHaveBeenCalledWith(expect.objectContaining({ document: expect.objectContaining({ requested: { folder: true, tags: false } }) }));
  expect(await readClassificationContext()).toMatchObject({ warnings: ['folder_descriptions_unavailable', 'tag_vocabulary_unavailable'] });
});
test('tags-only requests explain unavailable storage without dispatching a provider call', async () => {
  expect(await run(false, true)).toEqual({ ok: false, error: 'local_tag_context_unavailable' });
  expect(f.preview).not.toHaveBeenCalled();
});
