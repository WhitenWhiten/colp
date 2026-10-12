// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBookmarkManager } from '../src/bookmark-manager.js';
import type { ManagerElements, NativeNode } from '../src/bookmark-manager-dom.js';
import { projectManagerRoot } from '../src/bookmark-manager-visibility.js';

const annotations = vi.hoisted(() => ({ all: vi.fn(), load: vi.fn(), search: vi.fn() }));
vi.mock('../src/bookmark-manager-annotations.js', () => ({ createManagerAnnotations: () => annotations }));
vi.mock('../src/folder-description-native.js', () => ({ readNativeFolderDescriptions: async () => new Map() }));

let manager: ReturnType<typeof createBookmarkManager> | undefined;
beforeEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '#bookmarks');
  annotations.all.mockResolvedValue([]);
  annotations.load.mockResolvedValue(new Map());
  annotations.search.mockResolvedValue([]);
});
afterEach(() => { manager?.deactivate(); manager = undefined; vi.unstubAllGlobals(); });

function elements(): ManagerElements {
  const pane = document.createElement('section'); document.body.append(pane);
  function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag) {
    const node = document.createElement(tag); pane.append(node); return node;
  }
  return { pane, gate: element('div'), gateButton: element('button'), reloadHint: element('p'),
    body: element('div'), card: element('div'), tree: element('div'), list: element('div'), path: element('div'),
    search: element('input'), newFolder: element('button'), newBookmark: element('button'),
    feedback: element('p'), selectToggle: element('button'), syncState: element('span') };
}

test.each(['工作区', 'Workspaces', '作業スペース', 'Renamed container', 'Group'])('hides the %s root throughout the manager without changing browser bookmarks', async title => {
  const saved: NativeNode = { id: 'saved', parentId: 'bar', title: 'Saved page', url: 'https://example.test/saved' };
  const hidden: NativeNode = { id: 'hidden', parentId: 'project', title: 'Workspace page', url: 'https://example.test/workspace' };
  const nested: NativeNode = { id: 'nested', parentId: 'bar', title, children: [] };
  const root: NativeNode = { id: '0', title: '', children: [
    { id: 'bar', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [saved, nested] },
    { id: 'other', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
    { id: 'workspaces', parentId: '0', title, children: [
      { id: 'project', parentId: 'workspaces', title: 'Research project', children: [hidden] },
    ] },
  ] };
  const original = structuredClone(root);
  const mutations = { create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() };
  const search = vi.fn().mockResolvedValue([hidden, saved, root.children![2]]);
  const sendMessage = vi.fn().mockImplementation(async (request: { kind: string }) => request.kind === 'known.roots.boundaries'
    ? { ok: true, boundaries: { selected: ['workspaces', 'project'], privateLocal: [] } } : { ok: false });
  vi.stubGlobal('chrome', { permissions: { contains: async () => true },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage, onMessage: { addListener: vi.fn() } },
    bookmarks: { getTree: async () => [root], search, ...mutations } });
  annotations.all.mockResolvedValue([
    { nativeId: hidden.id, url: hidden.url, tags: ['workspace-only'], note: null, updatedAt: 1, version: 1 },
  ]);
  annotations.search.mockResolvedValue([hidden.id]);
  const ui = elements(); manager = createBookmarkManager(ui);
  await manager.activate();

  // Pinned sync roots and tag navigation must not reintroduce the hidden subtree.
  expect(ui.tree.textContent).not.toContain('Research project');
  expect(ui.tree.textContent).not.toContain('workspace-only');
  expect(ui.tree.querySelectorAll('.mgr-tree-label')).toHaveLength(3);
  expect(ui.tree.textContent).toContain(title); // Ordinary same-name folder under the bar is kept.
  expect(ui.list.querySelector('[data-id="saved"]')).not.toBeNull();
  expect(ui.list.querySelector('[data-id="nested"]')).not.toBeNull();

  ui.search.value = 'page';
  await manager.activate();
  expect(search).toHaveBeenCalledWith({ query: 'page' });
  expect(ui.list.querySelectorAll('.mgr-row')).toHaveLength(1);
  expect(ui.list.querySelector('[data-id="hidden"]')).toBeNull();
  expect(ui.list.querySelector('[data-id="workspaces"]')).toBeNull();
  expect(ui.path.textContent).toBe('Search results (1)');

  // Direct navigation cannot display a hidden project, and the default folder still works.
  ui.search.value = '';
  history.replaceState(null, '', '#bookmarks?native=project');
  await manager.activate();
  expect(ui.list.querySelector('[data-id="saved"]')).not.toBeNull();
  expect(ui.list.querySelector('[data-id="hidden"]')).toBeNull();
  expect(root).toEqual(original);
  for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
});

test('keeps built-in and managed bookmark roots even when their title matches Workspaces', () => {
  const root: NativeNode = { id: '0', title: '', children: [
    { id: 'bar', title: 'Workspaces', folderType: 'bookmarks-bar', children: [] },
    { id: 'managed', title: '工作区', unmodifiable: 'managed', children: [] },
  ] };
  expect(projectManagerRoot(root)).toBe(root);
});
