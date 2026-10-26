// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { createBookmarkManagerNavigation } from '../src/bookmark-manager-navigation.js';
import { parseHubRoute } from '../src/options-router.js';

test('source-folder links open the folder contents while ordinary bookmark links retain parent selection', async () => {
  const host = document.createElement('div'); host.innerHTML = '<header class="page-head"></header>';
  const navigation = createBookmarkManagerNavigation(host);
  const nodes = new Map([
    ['parent', { id: 'parent', title: 'Other bookmarks' }],
    ['folder', { id: 'folder', title: 'Site saves', parentId: 'parent' }],
    ['bookmark', { id: 'bookmark', title: 'Item', parentId: 'folder', url: 'https://example.test/' }],
  ]);
  window.location.hash = '#bookmarks?folder=folder';
  expect(parseHubRoute(location.hash).params.get('folder')).toBe('folder');
  expect(await navigation.prepare(nodes, false)).toMatchObject({ folderId: 'folder', nativeId: 'folder' });
  window.location.hash = '#bookmarks?native=bookmark';
  expect(await navigation.prepare(nodes, false)).toMatchObject({ folderId: 'folder', nativeId: 'bookmark' });
});
