// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { metadataCounts, releaseMetadataBindings, confirmMetadataTransfer } from '../src/metadata-transfer.js';
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set(['sub']) }));
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('transfer previews live personal metadata and releases only explicitly selected ownership', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const bookmark = { id: 'b', url: 'https://example.test/', dateAdded: 1 }, folder = { id: 'f', dateAdded: 1 };
  vi.stubGlobal('chrome', { bookmarks: { getTree: async () => [{ id: '0', children: [
    { id: '1', children: [{ ...folder, children: [bookmark] }, { id: 'sub', children: [{ id: 's', url: 'https://sub.test/' }] }] },
    { id: 'workspace', title: 'Workspaces', children: [{ id: 'hidden', url: 'https://workspace.test/' }] },
  ] }] } });
  const annotations = createBookmarkAnnotationStore(), descriptions = createFolderDescriptionStore();
  try {
    await annotations.observeTags(bookmark, { scopeKey: 'old', resourceId: 'node', revision: 'r1', value: ['tag'] });
    await annotations.save(bookmark, { tags: ['tag'], note: 'Note' });
    await annotations.save({ id: 's' }, { tags: ['private'], note: 'Subscription' });
    await annotations.save({ id: 'hidden', url: 'https://workspace.test/' }, { tags: ['workspace'], note: 'Hidden' });
    await descriptions.observeRemote([{ folder, binding: { scopeKey: 'old', colpId: 'folder', revision: 'r1', description: 'Description' } }]);
    expect(await metadataCounts()).toEqual({ tags: 1, notes: 1, descriptions: 1 });
    const choice = confirmMetadataTransfer();
    await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
    expect(document.body.textContent).toContain('1 tag assignments, 1 notes, 1 folder descriptions');
    document.querySelectorAll<HTMLButtonElement>('dialog button')[2]!.click(); expect(await choice).toBe(true);
    expect((await annotations.get(bookmark))?.tagsSync?.remote).toBeDefined();
    await releaseMetadataBindings();
    expect(await annotations.get({ id: 'hidden', url: 'https://workspace.test/' })).toMatchObject({ tags: ['workspace'], note: 'Hidden' });
    expect(await annotations.get(bookmark)).toMatchObject({ tags: ['tag'], note: 'Note', tagsSync: { state: 'dirty' } });
    expect((await annotations.get(bookmark))?.tagsSync?.remote).toBeUndefined();
    expect((await descriptions.get(folder))?.remote).toBeUndefined();
    expect((await annotations.get({ id: 's' }))?.note).toBe('Subscription');
  } finally { annotations.close(); descriptions.close(); }
});
