import { expect, test } from 'vitest';
import { scanBoundary } from '../src/bookmark-boundary.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import { rangePreviewChanges } from '../src/range-preview-changes.js';

const bookmark = (nativeId: string, url = `https://example.test/${nativeId}`): NormalizedBookmarkNode => ({
  nativeId, title: nativeId, kind: 'bookmark', managed: false, url, children: [],
});
const folder = (nativeId: string, children: readonly NormalizedBookmarkNode[], managed = false): NormalizedBookmarkNode => ({
  nativeId, title: nativeId, kind: 'folder', managed, children,
});
const roots: readonly NormalizedBookmarkRoot[] = [{ ...folder('bar', [
  bookmark('loose'), folder('old', [bookmark('already-synced')]), folder('new', [bookmark('new-bookmark')]),
  folder('private', [bookmark('private-bookmark')]), folder('managed', [{ ...bookmark('managed-bookmark'), managed: true }], true),
  bookmark('unsupported', 'javascript:alert(1)'),
]), rootKind: 'bookmarks_bar' }];

test('coverage additions exclude old subtrees, private folders, managed nodes and unsupported bookmarks', () => {
  const before = scanBoundary({ roots, selectedNativeIds: ['old'] });
  const after = scanBoundary({ roots, selectedNativeIds: ['bar', 'old', 'new'], privateNativeIds: ['private'] });
  expect(rangePreviewChanges(roots, before, after)).toEqual({ addedBookmarkCount: 2, addedFolders: [
    { nativeId: 'bar', title: 'bar', path: 'bar', bookmarkCount: 1 },
    { nativeId: 'new', title: 'new', path: 'bar / new', bookmarkCount: 1 },
  ] });
});

test('unchanged selections have no additions, and restoring private coverage counts that subtree once', () => {
  const before = scanBoundary({ roots, selectedNativeIds: ['bar'], privateNativeIds: ['private'] });
  expect(rangePreviewChanges(roots, before, before)).toEqual({ addedBookmarkCount: 0, addedFolders: [] });
  const after = scanBoundary({ roots, selectedNativeIds: ['bar'] });
  expect(rangePreviewChanges(roots, before, after)).toEqual({ addedBookmarkCount: 1, addedFolders: [
    { nativeId: 'private', title: 'private', path: 'bar / private', bookmarkCount: 1 },
  ] });
});
