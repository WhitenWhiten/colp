import { expect, test } from 'vitest';
import { nativeClassificationFolders, LOCAL_TAXONOMY_MAX_FOLDERS } from '../src/classification-local-taxonomy.js';
import { validClassificationRequest } from '../src/classification-messages.js';
import { buildClassificationCandidates } from '../src/generated/classification/index.js';
import type { FolderTreeNode } from '../src/save-folder.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';

const tree: FolderTreeNode[] = [{ id: '0', title: '', children: [
  { id: '1', title: 'Bookmarks bar', children: [
    { id: '10', title: 'Research', children: [
      { id: '11', title: 'Papers', children: [] },
      { id: '12', title: 'a page', url: 'https://example.org/' },
    ] },
    { id: '13', title: 'Feeds (subscription)', children: [{ id: '14', title: 'Inside feed', children: [] }] },
    { id: '15', title: 'a bar page', url: 'https://example.org/bar' },
  ] },
  { id: '2', title: 'Other bookmarks', children: [{ id: '20', title: 'Recipes', children: [] }] },
  { id: '3', title: 'Managed', unmodifiable: 'managed', children: [{ id: '30', title: 'Policy', children: [] }] },
] }];

test('local candidates are the browser folders, with the built-in roots as containers', () => {
  const folders = nativeClassificationFolders(tree, { excluded: new Set(['13']), descriptions: new Map([['10', 'Academic reading']]) });
  expect(folders).toEqual([
    { id: '10', parentId: null, title: 'Research', description: 'Academic reading', bookmarkExamples: [{ title: 'a page', hostname: 'example.org' }] },
    { id: '11', parentId: '10', title: 'Papers', description: null },
    { id: '20', parentId: null, title: 'Recipes', description: null },
  ]);
  // Native ids feed the shared policy unchanged; no collection or account is involved.
  const candidates = buildClassificationCandidates({ bookmark: { title: 'A paper', url: 'https://example.org/p', description: null },
    folders, tagUsage: [], existingTags: [], requested: { folder: true, tags: false } });
  expect(candidates.l1.map(folder => folder.id).sort()).toEqual(['10', '20']);
});

test('native examples omit the just-saved bookmark and excluded or managed subtrees', () => {
  const folders = nativeClassificationFolders(tree, { excluded: new Set(['13']), excludeBookmarkId: '12' });
  expect(folders.map(folder => folder.id)).toEqual(['10', '11', '20']);
  expect(folders.every(folder => !folder.bookmarkExamples?.length)).toBe(true);
});

test.each(['工作区', '工作區', 'Workspaces', ' Workspace ', '作業スペース', 'Espaces de travail', 'Renamed container', 'Group'])('omits the %s root and its descendants from classification', title => {
  const folders = nativeClassificationFolders(workspaceFolderTree(title), { excluded: new Set() });
  expect(folders.map(folder => folder.id)).toEqual(['a', 'user-workspace', 'b']);
  const candidates = buildClassificationCandidates({ bookmark: { title: 'Research project', url: 'https://workspace.example/', description: null },
    folders, tagUsage: [], existingTags: [], requested: { folder: true, tags: false } });
  expect(candidates.l1.map(folder => folder.id).sort()).toEqual(['a', 'b', 'user-workspace']);
  expect(folders.every(folder => !folder.bookmarkExamples?.length)).toBe(true);
});

test('an oversized tree is refused instead of building an unbounded prompt', () => {
  const children = Array.from({ length: LOCAL_TAXONOMY_MAX_FOLDERS + 1 }, (_, i) => ({ id: String(100 + i), title: `F${i}`, children: [] }));
  expect(() => nativeClassificationFolders([{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children }] }], { excluded: new Set() }))
    .toThrow('local_taxonomy_too_large');
});

test('the local preview message carries no collection, node or billing', () => {
  const document = { source: 'extension', bookmark: { title: 'A page', url: 'https://example.org/', description: null }, requested: { folder: true, tags: false } };
  const commandId = '6f0c2a55-5f0e-4b8a-9a55-0c2a555f0e4b';
  expect(validClassificationRequest({ kind: 'known.classification.local-preview', commandId, userGesture: true, document })).toBe(true);
  expect(validClassificationRequest({ kind: 'known.classification.local-preview', collectionId: 'c', commandId, userGesture: true, document })).toBe(false);
  expect(validClassificationRequest({ kind: 'known.classification.local-preview', commandId, userGesture: true,
    document: { ...document, billing: { priceVersion: 'v1', maxPoints: 1 } } })).toBe(false);
  expect(validClassificationRequest({ kind: 'known.classification.local-context' })).toBe(false);
});
