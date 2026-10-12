import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { bookmarkHtml } from '../src/local-backup/codec.js';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { localImportItems } from '../src/local-import/contracts.js';
import { createLocalImportStore } from '../src/local-import/store.js';
import { createLocalImporter } from '../src/local-import/coordinator.js';
import { restoreItemAnnotations } from '../src/local-import/annotations.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
afterEach(() => vi.unstubAllGlobals());

test('folder descriptions survive HTML round trips without absorbing child titles or bookmark notes', () => {
  const html = bookmarkHtml([{ sourceId: 'f', parentIndex: null, title: 'Folder', description: 'Read <papers> & "notes"\nSecond line' },
    { sourceId: 'b', parentIndex: 0, title: 'Child title', url: 'https://example.test/', note: 'Bookmark note' }]);
  expect(html).toContain('<DD>Read &lt;papers&gt; &amp; &quot;notes&quot;');
  const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode(html));
  expect(conversion.tree[0]).toMatchObject({ description: 'Read <papers> & "notes"\nSecond line', children: [{ title: 'Child title', note: 'Bookmark note' }] });
  expect(localImportItems(conversion, 'cmd', 'Imported')[1]?.description).toBe('Read <papers> & "notes"\nSecond line');
});
test('an HTML import with only folder descriptions completes its durable metadata phase', async () => {
  const factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  const nodes = new Map<string, { id: string; title: string; url?: string }>();
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => [nodes.get(id)].filter(Boolean) } });
  const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode('<DL><DT><H3>Topic</H3><DD>Topic description<DL><p></DL></DL>'));
  const store = createLocalImportStore(factory), descriptions = createFolderDescriptionStore();
  try {
    await store.preview(conversion); await store.start({ commandId: 'cmd', digest: conversion.digest, targetNativeId: 'bar', folderTitle: 'Imported' });
    expect((await store.plan('cmd'))?.annotated).toBe(true);
    const importer = createLocalImporter({ store, hasPermission: async () => true, assertFolder: async () => undefined, get: async () => undefined,
      create: async item => { const node = { ...item, id: `new-${nodes.size}` }; nodes.set(node.id, node); return node; },
      restoreMetadata: (_plan, items) => restoreItemAnnotations(items) });
    expect((await importer.run('cmd')).state).toBe('completed');
    expect(await descriptions.get({ id: 'new-1' })).toMatchObject({ description: 'Topic description' });
  } finally { descriptions.close(); await store.close(); }
});
