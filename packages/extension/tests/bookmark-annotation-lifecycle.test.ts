import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { backupLocalDelete, restoreLocalDelete } from '../src/bookmark-local-delete.js';
import { createLocalDeleteStore } from '../src/bookmark-local-delete-store.js';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { readNativeBookmarkAnnotations } from '../src/bookmark-annotation-native.js';
import { backupNativeNodes, bookmarkHtml, decodeLocalBackup, parseLocalBackup, type LocalBackup } from '../src/local-backup/codec.js';
import { dropRemovedAnnotations } from '../src/sw/bookmark-annotations.js';
import { previewNetscapeBookmarkImport } from '../src/import-preview.js';
import { backupImportItems, localImportItems, type LocalImportItem } from '../src/local-import/contracts.js';
import { restoreItemAnnotations } from '../src/local-import/annotations.js';
import { createLocalImportStore } from '../src/local-import/store.js';
import { createLocalImporter } from '../src/local-import/coordinator.js';
import { createMemoryBookmarks } from './bookmark-batch-memory.js';
import type { BatchItemRecord } from '../src/sync-state/batch-repository.js';

let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory); });
afterEach(() => { vi.unstubAllGlobals(); });

const deleteItem = (id: string, parentId: string, index: number, nodeKind: 'folder' | 'bookmark'): BatchItemRecord => ({
  scopeKey: 'local', planId: 'plan', itemId: id, order: 0, nativeId: id, nodeKind, title: 'Item', parentNativeId: parentId, index,
  preDigest: '', operationId: 'delete', reversalId: crypto.randomUUID(), state: 'applied', casVersion: 1 });

test('Undo of a local delete restores the tags and note of every bookmark in a folder onto the new native ids', async () => {
  const annotations = createBookmarkAnnotationStore(), journal = createLocalDeleteStore(factory), api = createMemoryBookmarks();
  try {
    const kept = await api.create!({ parentId: 'folder-a', title: 'Kept', url: 'https://kept.test/' });
    const plain = await api.create!({ parentId: 'folder-a', title: 'Plain', url: 'https://plain.test/' });
    await annotations.save(kept, { tags: ['Reading', 'later'], note: 'Chapter 3 is the useful one' });
    const outside = await annotations.save(api.node('bm-1')!, { tags: ['stay'], note: null });
    const deleted = deleteItem('folder-a', 'bar', 2, 'folder');
    await backupLocalDelete(api, deleted, Date.now(), journal);
    const subtree = structuredClone(api.node('folder-a')!);
    await api.removeTree('folder-a');
    await dropRemovedAnnotations({ nativeId: 'folder-a', removal: { node: subtree } });
    expect(await annotations.get(kept)).toBeNull();
    await restoreLocalDelete(api, deleted, journal);
    const restored = api.node('bar')!.children![2]!.children!;
    expect(restored.map(node => node.title)).toEqual(['Kept', 'Plain']);
    expect(restored[0]!.id).not.toBe(kept.id);
    expect(await annotations.get(restored[0]!)).toMatchObject({ tags: ['Reading', 'later'], note: 'Chapter 3 is the useful one', url: 'https://kept.test/' });
    expect(await annotations.get(restored[1]!)).toBeNull();
    expect(await annotations.get(plain)).toBeNull();
    expect(await annotations.get(api.node('bm-1')!)).toEqual(outside);
    const mutations = api.mutations.length;
    await restoreLocalDelete(api, deleted, journal);
    expect(api.mutations.length).toBe(mutations);
    expect((await annotations.list()).map(row => row.tags[0]).sort()).toEqual(['Reading', 'stay']);
  } finally { annotations.close(); await journal.close(); }
});

test('Undo of a single deleted bookmark restores its annotation', async () => {
  const annotations = createBookmarkAnnotationStore(), journal = createLocalDeleteStore(factory), api = createMemoryBookmarks();
  try {
    await annotations.save(api.node('bm-2')!, { tags: ['solo'], note: 'Only one' });
    const deleted = deleteItem('bm-2', 'bar', 1, 'bookmark');
    await backupLocalDelete(api, deleted, Date.now(), journal); await api.remove('bm-2');
    await restoreLocalDelete(api, deleted, journal);
    const restored = api.node('bar')!.children!.find(node => node.url === 'https://b.test/two')!;
    expect(restored.id).not.toBe('bm-2');
    expect(await annotations.get(restored)).toMatchObject({ tags: ['solo'], note: 'Only one' });
  } finally { annotations.close(); await journal.close(); }
});

test('Undo of a deleted pinned bookmark brings back its pin with its tags', async () => {
  const annotations = createBookmarkAnnotationStore(), journal = createLocalDeleteStore(factory), api = createMemoryBookmarks();
  try {
    await annotations.save(api.node('bm-2')!, { tags: ['solo'], note: null });
    await annotations.setPinned(api.node('bm-2')!, true);
    const deleted = deleteItem('bm-2', 'bar', 1, 'bookmark');
    await backupLocalDelete(api, deleted, Date.now(), journal); await api.remove('bm-2');
    await restoreLocalDelete(api, deleted, journal);
    const restored = api.node('bar')!.children!.find(node => node.url === 'https://b.test/two')!;
    expect(await annotations.get(restored)).toMatchObject({ tags: ['solo'], pinned: true });
  } finally { annotations.close(); await journal.close(); }
});

test('a backup carries a pin for bookmarks only, and restoring writes it onto the new native id', async () => {
  const tree = [{ id: 'f', title: 'Folder', children: [{ id: 'b1', title: 'One', url: 'https://one.test/' }] }];
  const rows = new Map([['b1', { nativeId: 'b1', url: 'https://one.test/', tags: [], note: null, pinned: true as const, updatedAt: 1, version: 1 }]]);
  expect(backupNativeNodes(tree, new Map(), new Set(), rows)[1]).toEqual({ sourceId: 'b1', parentIndex: 0, title: 'One', url: 'https://one.test/', pinned: true });
  const source = fullBackup();
  const data = parseLocalBackup({ ...source, nodes: source.nodes.map(node => node.sourceId === 'b2' ? { ...node, pinned: true } : node) });
  expect(() => parseLocalBackup({ ...data, nodes: [{ ...data.nodes[0], pinned: true }, ...data.nodes.slice(1)] })).toThrow('backup_invalid');
  expect(() => parseLocalBackup({ ...data, nodes: [data.nodes[0], data.nodes[1], { ...data.nodes[2], pinned: false }] })).toThrow('backup_invalid');
  const created = new Map<string, { id: string; url?: string; dateAdded: number }>();
  vi.stubGlobal('chrome', { bookmarks: { get: vi.fn(async (id: string) => [created.get(id)].filter(Boolean)) } });
  const items = backupImportItems(data, 'cmd', 'Restored').map(item => ({ ...item, nativeId: `new-${item.index}` }));
  items.forEach(item => created.set(item.nativeId, { id: item.nativeId, ...(item.url ? { url: item.url } : {}), dateAdded: 50 + item.index }));
  expect(items[3]?.annotation).toEqual({ tags: [], note: null, pinned: true });
  await restoreItemAnnotations(items);
  const store = createBookmarkAnnotationStore();
  try { expect(await store.get({ id: 'new-3', dateAdded: 53 })).toMatchObject({ pinned: true }); } finally { store.close(); }
});

const fullBackup = (): LocalBackup => parseLocalBackup({ format: 'known-browser-backup', version: 1, exportedAt: 20,
  nodes: [{ sourceId: 'f', parentIndex: null, title: 'Folder', description: 'Tools' },
    { sourceId: 'b1', parentIndex: 0, title: 'One', url: 'https://one.test/', tags: ['a', 'b'], note: 'Line one\nLine two' },
    { sourceId: 'b2', parentIndex: 0, title: 'Two', url: 'https://two.test/' }],
  history: [], preferences: {}, language: 'en', defaultFolderSourceId: null, aiConfig: null });

test('the Know-N backup carries tags and notes, and older backups without them still restore', () => {
  const tree = [{ id: 'f', title: 'Folder', children: [{ id: 'b1', title: 'One', url: 'https://one.test/', dateAdded: 5 },
    { id: 'b2', title: 'Two', url: 'https://two.test/' }] }];
  const rows = new Map([['b1', { nativeId: 'b1', dateAdded: 5, url: 'https://one.test/', tags: ['a', 'b'], note: 'Line one\nLine two', updatedAt: 1, version: 1 }],
    ['f', { nativeId: 'f', url: null, tags: ['not-for-folders'], note: null, updatedAt: 1, version: 1 }]]);
  const nodes = backupNativeNodes(tree, new Map(), new Set(), rows);
  expect(nodes).toEqual([{ sourceId: 'f', parentIndex: null, title: 'Folder' },
    { sourceId: 'b1', parentIndex: 0, title: 'One', url: 'https://one.test/', tags: ['a', 'b'], note: 'Line one\nLine two' },
    { sourceId: 'b2', parentIndex: 0, title: 'Two', url: 'https://two.test/' }]);
  const data = fullBackup();
  expect(decodeLocalBackup(new TextEncoder().encode(JSON.stringify(data)))).toEqual(data);
  const old = JSON.parse(JSON.stringify({ ...data, nodes: data.nodes.map(({ tags: _t, note: _n, ...node }) => node) }));
  expect(parseLocalBackup(old).nodes.every(node => node.tags === undefined && node.note === undefined)).toBe(true);
  expect(backupImportItems(parseLocalBackup(old), 'cmd', 'Restored').some(item => item.annotation)).toBe(false);
  const bad = (node: object) => () => parseLocalBackup({ ...data, nodes: [...data.nodes.slice(0, 1), { ...data.nodes[1], ...node }, data.nodes[2]] });
  expect(bad({ tags: 'a' })).toThrow('backup_invalid');
  expect(bad({ tags: [1] })).toThrow('backup_invalid');
  expect(bad({ note: 5 })).toThrow('backup_invalid');
  expect(bad({ note: 'x'.repeat(16_385) })).toThrow('backup_invalid');
  expect(() => parseLocalBackup({ ...data, nodes: [{ ...data.nodes[0], tags: ['folder'] }] })).toThrow('backup_invalid');
});

test('JSON backup/import preserves authoritative tag members rather than splitting or folding them', async () => {
  const source = fullBackup();
  const tags = ['News', 'news', 'a,b', '😀'.repeat(32)];
  const backup = parseLocalBackup({ ...source, nodes: source.nodes.map(node => node.url ? { ...node, tags } : node) });
  expect(backup.nodes[1]?.tags).toEqual(tags);
  const store = createBookmarkAnnotationStore();
  try {
    await store.save({ id: 'preserved', url: 'https://one.test/' }, { tags: backup.nodes[1]!.tags!, note: null }, { preserveTags: true });
    expect((await store.get({ id: 'preserved' }))?.tags).toEqual(tags);
  } finally { store.close(); }
});

test('a legacy long tag and a temporary merge overflow survive JSON backup/import without truncation', async () => {
  const source = fullBackup(), tags = [...Array.from({ length: 80 }, (_, i) => `tag-${i}`), '😀'.repeat(48)];
  const backup = parseLocalBackup({ ...source, nodes: source.nodes.map(node => node.url ? { ...node, tags } : node) });
  expect(backup.nodes[1]?.tags).toEqual(tags);
  const store = createBookmarkAnnotationStore();
  try {
    await store.save({ id: 'legacy', url: 'https://one.test/' }, { tags: backup.nodes[1]!.tags!, note: null }, { preserveTags: true });
    expect((await store.get({ id: 'legacy' }))?.tags).toEqual(tags);
  } finally { store.close(); }
});

test('restoring a backup writes the annotations onto the new native ids, and a repeat changes nothing', async () => {
  const created = new Map<string, { id: string; url?: string; dateAdded: number }>();
  vi.stubGlobal('chrome', { bookmarks: { get: vi.fn(async (id: string) => [created.get(id)].filter(Boolean)) },
    storage: { local: { set: async () => undefined, remove: async () => undefined } } });
  const data = fullBackup(), items: LocalImportItem[] = backupImportItems(data, 'cmd', 'Restored')
    .map(item => ({ ...item, nativeId: `new-${item.index}` }));
  items.forEach(item => created.set(item.nativeId!, { id: item.nativeId!, ...(item.url ? { url: item.url } : {}), dateAdded: 50 + item.index }));
  expect(items.map(item => item.annotation)).toEqual([undefined, undefined, { tags: ['a', 'b'], note: 'Line one\nLine two' }, undefined]);
  await restoreItemAnnotations(items); await restoreItemAnnotations(items);
  const store = createBookmarkAnnotationStore();
  try {
    expect(await store.list()).toMatchObject([{ nativeId: 'new-2', dateAdded: 52, tags: ['a', 'b'], note: 'Line one\nLine two', version: 1 }]);
    expect(await store.get({ id: 'new-3', dateAdded: 53 })).toBeNull();
  } finally { store.close(); }
});

test('HTML export writes TAGS and a DD note with escaping, and importing the file brings both back', () => {
  const nodes = backupNativeNodes([{ id: 'f', title: 'Folder', children: [
    { id: 'b1', title: 'A "quoted" <title>', url: 'https://one.test/?a=1&b=2' },
    { id: 'b2', title: 'No notes', url: 'https://two.test/' }] }],
  new Map(), new Set(), new Map([['b1', { nativeId: 'b1', url: null, tags: ['R&D', 'say "hi"', '<b>', 'it\'s'], updatedAt: 1, version: 1,
    note: 'Use <script>alert(1)</script> & "care"\nSecond line' }]]));
  const html = bookmarkHtml(nodes);
  expect(html).toContain('<DT><A HREF="https://one.test/?a=1&amp;b=2" TAGS="R&amp;D,say &quot;hi&quot;,&lt;b&gt;,it&#39;s">A &quot;quoted&quot; &lt;title&gt;</A>\n<DD>Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;care&quot;\nSecond line\n');
  expect(html).not.toContain('<script>');
  expect(html.match(/<DD>/gu)).toHaveLength(1);
  expect(html.match(/TAGS=/gu)).toHaveLength(1);
  const [folder] = previewNetscapeBookmarkImport(new TextEncoder().encode(html)).tree;
  expect(folder!.children.map(node => [node.title, node.tags, node.note])).toEqual([
    ['A "quoted" <title>', ['R&D', 'say "hi"', '<b>', "it's"], 'Use <script>alert(1)</script> & "care"\nSecond line'],
    ['No notes', undefined, undefined]]);
  const items = localImportItems(previewNetscapeBookmarkImport(new TextEncoder().encode(html)), 'cmd', 'Imported');
  expect(items.map(item => item.annotation)).toEqual([undefined, undefined,
    { tags: ['R&D', 'say "hi"', '<b>', "it's"], note: 'Use <script>alert(1)</script> & "care"\nSecond line' }, undefined]);
});

test('other browsers\' files: Firefox, Pinboard and Raindrop style TAGS and DD lines import as annotations', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>
    <DT><A HREF="https://a.test/" ADD_DATE="1" TAGS="  #Go , rust,GO,">First</A>
    <DD>Why this matters
    <DT><A HREF="https://b.test/" TAGS="solo">Second</A>
    <DT><H3>Folder</H3>
    <DD>folder text is not a bookmark note
    <DL><p><DT><A HREF="https://c.test/">Third</A><DD>   </DL><p>
  </DL><p>`;
  const tree = previewNetscapeBookmarkImport(new TextEncoder().encode(html)).tree;
  expect(tree[0]).toMatchObject({ title: 'First', tags: ['Go', 'rust'], note: 'Why this matters' });
  expect(tree[1]).toMatchObject({ title: 'Second', tags: ['solo'] });
  expect(tree[1]!.note).toBeUndefined();
  expect(tree[2]!.note).toBeUndefined();
  expect(tree[2]!.children.map(node => [node.title, node.note])).toEqual([['Third', undefined]]);
});

test('a plain HTML import finishes with a metadata step that keeps tags and notes, and survives a restart', async () => {
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://a.test/" TAGS="x,y">A</A><DD>note A<DT><A HREF="https://b.test/">B</A></DL>';
  const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode(html));
  const store = createLocalImportStore(factory), nodes = new Map<string, { id: string; title: string; url?: string; dateAdded: number }>();
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => [nodes.get(id)].filter(Boolean) } });
  const create = vi.fn(async (input: { title: string; url?: string }) => {
    const node = { ...input, id: `n${nodes.size + 1}`, dateAdded: nodes.size + 1 }; nodes.set(node.id, node); return node; });
  const restoreMetadata = vi.fn().mockRejectedValueOnce(new Error('metadata_failed')).mockImplementation((_plan, items) => restoreItemAnnotations(items));
  const ports = { store, hasPermission: async () => true, assertFolder: async () => undefined, create, get: async () => undefined, restoreMetadata };
  const input = { commandId: crypto.randomUUID(), digest: conversion.digest, targetNativeId: 'bar', folderTitle: 'Imported' };
  try {
    await store.preview(conversion); await store.start(input);
    expect(await store.plan(input.commandId)).toMatchObject({ annotated: true });
    expect(await createLocalImporter(ports).run(input.commandId)).toMatchObject({ state: 'attention', reason: 'metadata_failed', next: 3 });
    const importer = createLocalImporter(ports);
    await importer.resume(input.commandId);
    expect(await importer.run(input.commandId)).toMatchObject({ state: 'completed' });
    expect(create).toHaveBeenCalledTimes(3);
    const annotations = createBookmarkAnnotationStore();
    try { expect(await annotations.list()).toMatchObject([{ nativeId: 'n2', tags: ['x', 'y'], note: 'note A', url: 'https://a.test/' }]); }
    finally { annotations.close(); }
  } finally { await store.close(); }
});

test('a plain HTML import without tags or notes still completes at the last bookmark', async () => {
  const conversion = previewNetscapeBookmarkImport(new TextEncoder().encode('<DL><DT><A HREF="https://a.test/">A</A></DL>'));
  const store = createLocalImportStore(factory);
  const ports = { store, hasPermission: async () => true, assertFolder: async () => undefined, create: async () => ({ id: `n${Math.random()}` }), get: async () => undefined };
  const input = { commandId: crypto.randomUUID(), digest: conversion.digest, targetNativeId: 'bar', folderTitle: 'Imported' };
  try {
    await store.preview(conversion); await store.start(input);
    expect((await store.plan(input.commandId))?.annotated).toBeUndefined();
    expect(await createLocalImporter(ports).run(input.commandId)).toMatchObject({ state: 'completed' });
  } finally { await store.close(); }
});

test('only annotations of live, matching bookmarks are exported', async () => {
  const store = createBookmarkAnnotationStore();
  try {
    await store.save({ id: 'live', dateAdded: 1 }, { tags: ['a'], note: null });
    await store.save({ id: 'reused', dateAdded: 1 }, { tags: ['b'], note: null });
    await store.save({ id: 'gone', dateAdded: 1 }, { tags: ['c'], note: null });
    const rows = await readNativeBookmarkAnnotations([{ id: 'r', children: [{ id: 'live', url: 'https://a.test/', dateAdded: 1 },
      { id: 'reused', url: 'https://b.test/', dateAdded: 2 }] }]);
    expect([...rows.keys()]).toEqual(['live']);
  } finally { store.close(); }
});
