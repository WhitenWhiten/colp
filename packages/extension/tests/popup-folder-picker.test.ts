// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { FOLDER_RECENTS } from '../src/folder-recents.js';
import { FOLDER_DEFAULT_BINDING, FOLDER_ONCE_BINDING, type FolderTreeNode } from '../src/save-folder.js';
import { bindSaveFolderPicker } from '../src/save-folder-ui.js';
import { byId as shellById, mountPopupShell } from './fixtures/popup-shell.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';

type Node = FolderTreeNode;

/* Mirrors real Chromium: the invisible root '0' has no parentId and no
   `unmodifiable` flag. */
const tree: Node[] = [{
  id: '0', title: '', children: [{
    id: '1', title: 'Bookmarks bar', parentId: '0', children: [
      { id: 'a', title: 'Alpha Research', parentId: '1', children: [] },
      { id: 'b', title: 'Beta', parentId: '1', children: [] },
    ],
  }],
}];
/* A second top-level folder, as Chromium's "Other bookmarks". */
const wideTree: Node[] = [{ ...tree[0]!, children: [...tree[0]!.children!, {
  id: '2', title: 'Other bookmarks', parentId: '0', children: [{ id: 'c', title: 'Cooking', parentId: '2', children: [] }],
}] }];

function flatten(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function stubChrome(roots: Node[] = tree, local: Record<string, unknown> = { [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: 'b' } }): Record<string, unknown> {
  const byId = new Map(flatten(roots).map((node) => [node.id, node]));
  vi.stubGlobal('chrome', {
    permissions: { contains: vi.fn(async () => true) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in local ? { [key]: local[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, items); }),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    },
    bookmarks: {
      getTree: vi.fn(async () => roots),
      get: vi.fn(async (id: string) => (byId.has(id) ? [byId.get(id)] : [])),
    },
    tabs: { create: vi.fn() },
    runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
  });
  return local;
}

function mountPicker(excluded: ReadonlySet<string> = new Set(), onChosen?: () => void) {
  document.body.innerHTML = `
    <button id="dest-toggle" type="button" aria-expanded="false">Save to</button>
    <div id="dest-panel" hidden>
      <input id="dest-search">
      <div id="folder-tree"></div>
      <form id="folder-new"><input id="folder-new-name"></form>
    </div>
    <span id="folder-current"></span>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const picker = bindSaveFolderPicker({
    destToggle: byId('dest-toggle'), destPanel: byId('dest-panel'), folderCurrent: byId('folder-current'),
    folderTree: byId('folder-tree'), folderNew: byId('folder-new'), folderNewName: byId('folder-new-name'), destSearch: byId<HTMLInputElement>('dest-search'),
    persistDraft: () => undefined, setFeedback: () => undefined,
    excludedFolderIds: async () => excluded, ...(onChosen ? { onChosen } : {}),
  });
  return { picker, toggle: byId<HTMLButtonElement>('dest-toggle'), tree: byId('folder-tree'), panel: byId('dest-panel') };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('the folder tree has one tab stop on the chosen folder and a pick returns focus to the toggle', async () => {
  stubChrome();
  const { picker, toggle, tree: folderTree, panel } = mountPicker();
  await picker.init('col-1', ['1']);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
  const options = Array.from(folderTree.querySelectorAll<HTMLButtonElement>('[data-folder-id]'));
  expect(options.map((option) => [option.dataset.folderId, option.tabIndex])).toEqual([
    ['1', -1], ['a', -1], ['b', 0],
  ]);

  options[1]!.focus();
  options[1]!.click();
  await vi.waitFor(() => expect(panel.hidden).toBe(true));
  expect(document.activeElement).toBe(toggle);
  expect(picker.chosenFolderId()).toBe('a');
});

test('the first folder is the tab stop when nothing is chosen yet', async () => {
  stubChrome(tree, {});
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('col-1', ['1']);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
  const stops = Array.from(folderTree.querySelectorAll<HTMLButtonElement>('[data-folder-id]'))
    .filter((option) => option.tabIndex === 0);
  expect(stops.map((option) => option.dataset.folderId)).toEqual(['1']);
});

test('re-init while the panel is open keeps it open', async () => {
  stubChrome();
  const { picker, toggle, tree: folderTree, panel } = mountPicker();
  await picker.init('col-1', ['1']);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
  await picker.init('col-2', ['1']);
  expect(panel.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

test('ArrowDown skips a filtered-out option', async () => {
  stubChrome();
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('col-1', ['1']);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
  const options = Array.from(folderTree.querySelectorAll<HTMLButtonElement>('[data-folder-id]'));
  options[1]!.hidden = true;
  options[0]!.focus();
  options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(options[2]);
});

test('with no sync mounts (signed-out device scope) every folder is one flat list', async () => {
  stubChrome();
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
  expect(folderTree.querySelector('[role="group"]')).toBeNull();
});

test('a stale mount that matches no folder still lists every folder', async () => {
  stubChrome();
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('col-1', ['gone']);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
});

test('folders keep the browser order; a synced folder is only marked, never labelled', async () => {
  stubChrome(wideTree);
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('col-1', ['c']);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(5));
  const rows = Array.from(folderTree.querySelectorAll<HTMLElement>('[data-folder-id]'));
  expect(rows.map((row) => [row.dataset.folderId, row.hasAttribute('data-synced')])).toEqual([
    ['1', false], ['a', false], ['b', false], ['2', false], ['c', true],
  ]);
  // The row is the kit's: a folder icon, the name, and (for the chosen one) a check drawn by CSS.
  expect(rows[0]!.classList.contains('folder-opt')).toBe(true);
  expect(rows[0]!.querySelector('svg[data-icon="folder"]')).not.toBeNull();
  expect(rows.some((row) => row.textContent?.includes('Synced'))).toBe(false);
});

test('read-only subscription folders are not offered as destinations', async () => {
  stubChrome(wideTree);
  const { picker, tree: folderTree } = mountPicker(new Set(['2']));
  await picker.init('col-1', []);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));
  expect(folderTree.querySelector('[data-folder-id="c"]')).toBeNull();
});

test.each(['工作区', 'Workspaces', '作業スペース', 'Renamed container', 'Group'])('the popup and recent shortcuts omit the %s subtree', async title => {
  stubChrome(workspaceFolderTree(title), { [FOLDER_RECENTS]: { ids: ['workspaces', 'project', 'workspace-folder', 'a'] } });
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  const ids = Array.from(folderTree.querySelectorAll<HTMLElement>('[data-folder-id]')).map(row => row.dataset.folderId);
  expect(ids).toEqual(['a', '1', 'a', 'user-workspace', '2', 'b']);
  expect(folderTree.textContent).not.toContain('Research project');
  expect(folderTree.textContent).not.toContain('Workspace papers');
});

test.each(['workspaces', 'project', 'workspace-folder'])('rejects local and synced suggestions for %s', async id => {
  stubChrome(workspaceFolderTree());
  const { picker } = mountPicker();
  await picker.init('col-1', ['workspaces', '1']);
  expect(await picker.chooseSuggestedFolder(id, true)).toBe(false);
  expect(await picker.chooseSuggestedFolder(id)).toBe(false);
  expect(picker.chosenFolderId()).toBe('b');
  expect(await picker.chooseSuggestedFolder('user-workspace', true)).toBe(true);
});

test.each(['workspaces', 'project', 'workspace-folder'])('ignores a saved workspace destination %s during initialization', async id => {
  stubChrome(workspaceFolderTree(), { [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: id } });
  vi.mocked(chrome.storage.session.get).mockResolvedValue({
    [FOLDER_ONCE_BINDING]: { collectionId: 'device', folderNativeId: id },
  });
  const { picker } = mountPicker();
  await picker.init('device', []);
  expect(picker.chosenFolderId()).toBe('');
});

test('recent shortcuts remain available without overriding the explicit default', async () => {
  stubChrome(wideTree, {
    [FOLDER_RECENTS]: { ids: ['c', 'gone', 'a'] },
    [FOLDER_DEFAULT_BINDING]: { collectionId: 'col-1', folderNativeId: 'b' },
  });
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('col-1', ['1']);
  expect(picker.chosenFolderId()).toBe('b');
  expect(document.getElementById('folder-current')!.textContent).toBe('Beta');
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[role="group"]')).toHaveLength(2));
  const recent = folderTree.querySelector('[data-folder-group="recent"]')!;
  expect(Array.from(recent.querySelectorAll<HTMLElement>('[data-folder-id]')).map((row) => row.dataset.folderId))
    .toEqual(['c', 'a']);
  expect(folderTree.querySelector('#folder-tree-group-recent')!.textContent).toBe('Recent');
  // A recent row names its parents, so two folders with one name stay apart.
  expect(recent.querySelector('[data-folder-id="c"] .folder-opt-trail')!.textContent).toBe('Other bookmarks');
  // One tab stop, on the chosen folder's first row.
  const stops = Array.from(folderTree.querySelectorAll<HTMLElement>('[data-folder-id]')).filter((row) => row.tabIndex === 0);
  expect(stops).toHaveLength(1);
  expect(stops[0]!.dataset.folderId).toBe('b');
});

test('a saved pick becomes the newest recent folder, whether or not it syncs', async () => {
  const local = stubChrome(wideTree, { [FOLDER_RECENTS]: { ids: ['a', 'c'] } });
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  expect(picker.chosenFolderId()).toBe('');
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelector('[data-folder-group="all"] [data-folder-id="c"]')).not.toBeNull());
  folderTree.querySelector<HTMLButtonElement>('[data-folder-group="all"] [data-folder-id="c"]')!.click();
  await vi.waitFor(() => expect(picker.chosenFolderId()).toBe('c'));
  await picker.commit('device');
  expect(local[FOLDER_RECENTS]).toEqual({ ids: ['c', 'a'] });
});

test.each(['device', 'col-1'])('saving an AI suggestion preserves the explicit default in %s', async scope => {
  const defaultFolder = { collectionId: scope, folderNativeId: 'b' };
  const local = stubChrome(tree, { [FOLDER_DEFAULT_BINDING]: defaultFolder });
  const { picker } = mountPicker();
  await picker.init(scope, scope === 'device' ? [] : ['1']);
  expect(await picker.chooseSuggestedFolder('a', true)).toBe(true);
  expect(chrome.storage.session.set).not.toHaveBeenCalled();
  expect(picker.userPicked()).toBe(false);
  await picker.commit(scope);
  expect(local[FOLDER_DEFAULT_BINDING]).toEqual(defaultFolder);
  expect(local[FOLDER_RECENTS]).toEqual({ ids: ['a'] });
  const reopened = mountPicker().picker;
  await reopened.init(scope, scope === 'device' ? [] : ['1']);
  expect(reopened.chosenFolderId()).toBe('b');
});

test('refreshing the same popup preserves an accepted AI folder without remembering it for another popup', async () => {
  stubChrome(tree, { [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: 'b' } });
  const { picker } = mountPicker();
  await picker.init('device', []);
  await picker.chooseSuggestedFolder('a', true);
  await picker.init('device', []);
  expect(picker.chosenFolderId()).toBe('a');
  expect(document.getElementById('folder-current')!.textContent).toBe('Alpha Research');
});

test('an initialization still loading the default cannot overwrite a suggestion accepted meanwhile', async () => {
  stubChrome(tree, { [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: 'b' } });
  const { picker } = mountPicker();
  await picker.init('device', []);
  const get = vi.mocked(chrome.storage.local.get);
  let finish!: (value: Record<string, unknown>) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refreshing = picker.init('device', []);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await picker.chooseSuggestedFolder('a', true);
  finish({ [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: 'b' } });
  await refreshing;
  expect(picker.chosenFolderId()).toBe('a');
  expect(document.getElementById('folder-current')!.textContent).toBe('Alpha Research');
});

test('a missing default opens the picker and never chooses a recent folder', async () => {
  stubChrome(tree, { [FOLDER_DEFAULT_BINDING]: { collectionId: 'col-1', folderNativeId: 'gone' },
    [FOLDER_RECENTS]: { ids: ['a'] } });
  const { picker } = mountPicker();
  await picker.init('col-1', ['1']);
  expect(picker.chosenFolderId()).toBe('');
  expect(picker.isOpen()).toBe(true);
});

test('a search lists matches flat with their paths, and the Recent group steps aside', async () => {
  stubChrome(wideTree, { [FOLDER_RECENTS]: { ids: ['c'] } });
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelector('[data-folder-group="recent"]')).not.toBeNull());
  const search = document.getElementById('dest-search') as HTMLInputElement;
  search.value = 'cook';
  search.dispatchEvent(new Event('input'));
  expect(folderTree.querySelector('[data-folder-group]')).toBeNull();
  const rows = Array.from(folderTree.querySelectorAll<HTMLElement>('[data-folder-id]'));
  expect(rows.map((row) => row.dataset.folderId)).toEqual(['c']);
  expect(rows[0]!.querySelector('.folder-opt-trail')!.textContent).toBe('Other bookmarks');
});

test('an out-of-range pick applies at once: no prompt, and the next save goes there', async () => {
  stubChrome(tree, { [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: 'a' } });
  const onChosen = vi.fn();
  const { picker, tree: folderTree, panel } = mountPicker(new Set(), onChosen);
  await picker.init('col-1', ['a']);
  expect(await picker.syncTarget()).toEqual({ kind: 'synced', collectionId: 'col-1' });
  await picker.open();
  await vi.waitFor(() => expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(3));

  onChosen.mockClear();
  folderTree.querySelector<HTMLButtonElement>('[data-folder-id="b"]')!.click();
  // F-07: the pick is chosen before anything else happens, so Enter can never save to the old folder.
  await vi.waitFor(() => expect(picker.chosenFolderId()).toBe('b'));
  await vi.waitFor(() => expect(panel.hidden).toBe(true));
  expect(onChosen).toHaveBeenCalled();
  expect(await picker.isOutOfRange()).toBe(true);
  expect(await picker.syncTarget()).toEqual({ kind: 'local' });
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

test('with no live mounts the sync target is unknown, never local', async () => {
  stubChrome();
  const { picker } = mountPicker();
  await picker.init('col-1', []);
  expect(await picker.syncTarget()).toEqual({ kind: 'unknown' });
  await picker.init('device', ['1']);
  expect(await picker.syncTarget()).toEqual({ kind: 'unknown' });
});

test('the search matches anywhere in a folder name, and Enter takes the first match', async () => {
  stubChrome(wideTree, {});
  const { picker, tree: folderTree, panel } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  const search = document.getElementById('dest-search') as HTMLInputElement;
  search.value = 'research';
  search.dispatchEvent(new Event('input'));
  expect(Array.from(folderTree.querySelectorAll<HTMLElement>('[data-folder-id]')).map((row) => row.dataset.folderId)).toEqual(['a']);
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  search.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(picker.chosenFolderId()).toBe('a'));
  await vi.waitFor(() => expect(panel.hidden).toBe(true));
});

test('a search that matches nothing says so, and clearing it brings the tree back', async () => {
  stubChrome(wideTree, {});
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  const search = document.getElementById('dest-search') as HTMLInputElement;
  search.value = 'zzz';
  search.dispatchEvent(new Event('input'));
  expect(folderTree.querySelector('.folder-empty')?.textContent).toBe('No folders match.');
  expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(0);
  search.value = '';
  search.dispatchEvent(new Event('input'));
  expect(folderTree.querySelector('.folder-empty')).toBeNull();
  expect(folderTree.querySelectorAll('[data-folder-id]')).toHaveLength(5);
});

/** A tree as people keep them: a top level of six folders, each with two subfolders. */
const nestedTree: Node[] = [{ id: '0', title: '', children: [{
  id: '1', title: 'Bookmarks bar', parentId: '0', children: ['p', 'q', 'r', 's', 't', 'u'].map((id) => ({
    id, title: `Folder ${id}`, parentId: '1', children: [
      { id: `${id}1`, title: `Sub ${id}1`, parentId: id, children: [] },
      { id: `${id}2`, title: `Sub ${id}2`, parentId: id, children: [] },
    ],
  })),
}] }];

test('a long tree opens its first level and the chosen branch; a chevron or ArrowRight opens more', async () => {
  stubChrome(nestedTree, { [FOLDER_DEFAULT_BINDING]: { collectionId: 'device', folderNativeId: 'r2' } });
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  const ids = () => Array.from(folderTree.querySelectorAll<HTMLElement>('[data-folder-id]')).map((row) => row.dataset.folderId);
  // Nineteen folders would not fit: the top level opens, the rest folds, except the branch holding the chosen folder.
  expect(ids()).toEqual(['1', 'p', 'q', 'r', 'r1', 'r2', 's', 't', 'u']);
  const row = (id: string) => folderTree.querySelector<HTMLButtonElement>(`[data-folder-id="${id}"]`)!;
  expect(row('1').getAttribute('aria-expanded')).toBe('true');
  expect(row('p').getAttribute('aria-expanded')).toBe('false');
  expect(row('r1').hasAttribute('aria-expanded')).toBe(false);
  expect(row('r1').getAttribute('aria-level')).toBe('3');
  // The chevron opens a branch without picking it.
  row('p').querySelector<HTMLElement>('.folder-twisty')!.click();
  expect(ids()).toContain('p1');
  expect(picker.chosenFolderId()).toBe('r2');
  // ArrowRight opens, ArrowLeft folds and then climbs to the parent.
  row('q').focus();
  row('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(ids()).toContain('q1');
  expect(document.activeElement).toBe(row('q'));
  row('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.activeElement).toBe(row('q1'));
  row('q1').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(document.activeElement).toBe(row('q'));
  row('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(ids()).not.toContain('q1');
});

test('a recent folder opens onto its own subfolders in place', async () => {
  stubChrome(nestedTree, { [FOLDER_RECENTS]: { ids: ['t'] } });
  const { picker, tree: folderTree } = mountPicker();
  await picker.init('device', []);
  await picker.open();
  const recent = () => folderTree.querySelector<HTMLElement>('[data-folder-group="recent"]')!;
  const top = recent().querySelector<HTMLButtonElement>('[data-folder-id="t"]')!;
  expect(top.getAttribute('aria-expanded')).toBe('false');
  top.querySelector<HTMLElement>('.folder-twisty')!.click();
  expect(Array.from(recent().querySelectorAll<HTMLElement>('[data-folder-id]')).map((row) => row.dataset.folderId)).toEqual(['t', 't1', 't2']);
  recent().querySelector<HTMLButtonElement>('[data-folder-id="t2"]')!.click();
  await vi.waitFor(() => expect(picker.chosenFolderId()).toBe('t2'));
});

/** The picker on the real popup markup: pill, parent, panel, search, listbox and the inline new-folder row. */
function mountShellPicker(options: { onPick?: (id: string) => void; remember?: boolean } = {}) {
  mountPopupShell();
  const toggle = shellById<HTMLButtonElement>('dest-toggle');
  const picker = bindSaveFolderPicker({
    destToggle: toggle, destPanel: shellById('dest-panel'), folderCurrent: shellById('dest-folder'), folderParent: shellById('dest-parent'),
    folderTree: shellById('folder-tree'), folderNew: shellById<HTMLFormElement>('folder-new'), folderNewName: shellById<HTMLInputElement>('folder-new-name'),
    folderNewOpen: shellById<HTMLButtonElement>('folder-new-open'), folderNewLabel: shellById('folder-new-label'),
    folderCreate: shellById('folder-create'), destSearch: shellById<HTMLInputElement>('dest-search'),
    persistDraft: () => undefined, setFeedback: () => undefined, excludedFolderIds: async () => new Set<string>(),
    ...(options.onPick ? { onPick: options.onPick } : {}), ...(options.remember === undefined ? {} : { remember: options.remember }),
  });
  return { picker, toggle, panel: shellById('dest-panel'), tree: shellById('folder-tree') };
}

test('the pill shows the leaf name, and the parent only when asked, muted before it', async () => {
  stubChrome(wideTree);
  const { picker } = mountShellPicker();
  await picker.init('device', []);
  await picker.adopt('a');
  expect(shellById('dest-folder').textContent).toBe('Alpha Research');
  expect(shellById('dest-parent').hidden).toBe(true);
  picker.setParentVisible(true);
  await vi.waitFor(() => expect(shellById('dest-parent').textContent).toBe('Bookmarks bar ›'));
  expect(shellById('dest-parent').hidden).toBe(false);
  picker.setParentVisible(false);
  await vi.waitFor(() => expect(shellById('dest-parent').hidden).toBe(true));
});

test('showing the parent before any folder is chosen leaves the pill on its placeholder', async () => {
  stubChrome(wideTree);
  const { picker } = mountShellPicker();
  picker.setParentVisible(true);
  expect(shellById('dest-folder').textContent).toBe('');
  expect(shellById('dest-parent').hidden).toBe(true);
});

test('opening the panel focuses the search and the check mark follows the chosen folder', async () => {
  stubChrome(wideTree);
  const { picker, toggle, panel, tree } = mountShellPicker();
  await picker.init('device', []);
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(shellById('dest-search'));
  expect(Array.from(tree.querySelectorAll('[aria-selected="true"]')).map((row) => (row as HTMLElement).dataset.folderId)).toEqual(['b']);
  expect(tree.getAttribute('role')).toBe('tree');
  expect(tree.querySelectorAll('[role="treeitem"]').length).toBeGreaterThan(0);
});

test('ArrowDown from the search lands on the first folder, and arrows roam the tree', async () => {
  stubChrome(wideTree);
  const { picker, panel, tree } = mountShellPicker();
  await picker.init('device', []);
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  const options = Array.from(tree.querySelectorAll<HTMLButtonElement>('[data-folder-id]'));
  shellById('dest-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(options[0]);
  options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(options.at(-1));
});

test('"New folder in <name>" turns into an inline input; Escape steps back, then closes the panel', async () => {
  stubChrome(wideTree);
  const { picker, toggle, panel } = mountShellPicker();
  await picker.init('device', []);
  await picker.adopt('a');
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  const open = shellById<HTMLButtonElement>('folder-new-open');
  expect(shellById('folder-new-label').textContent).toBe('New folder in Alpha Research');
  expect(shellById('folder-create').hidden).toBe(true);
  open.click();
  expect(open.hidden).toBe(true);
  expect(shellById('folder-create').hidden).toBe(false);
  expect(document.activeElement).toBe(shellById('folder-new-name'));

  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  shellById('folder-new-name').dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(shellById('folder-create').hidden).toBe(true);
  expect(open.hidden).toBe(false);
  expect(panel.hidden).toBe(false);
  expect(document.activeElement).toBe(open);

  open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(panel.hidden).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(toggle);
});

test('Escape in the panel does not reach the rest of the popup', async () => {
  stubChrome(wideTree);
  const { picker, panel } = mountShellPicker();
  await picker.init('device', []);
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  const seen = vi.fn();
  document.addEventListener('keydown', seen);
  shellById('dest-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  document.removeEventListener('keydown', seen);
  expect(panel.hidden).toBe(true);
  expect(seen).not.toHaveBeenCalled();
});

test('creating a folder inside the chosen one picks it and collapses the input', async () => {
  const local = stubChrome(wideTree);
  const create = vi.fn(async (details: { parentId: string; title: string }) => ({ id: 'new', ...details }));
  (chrome.bookmarks as unknown as { create: unknown }).create = create;
  const { picker, panel } = mountShellPicker();
  await picker.init('device', []);
  await picker.adopt('a');
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  shellById<HTMLButtonElement>('folder-new-open').click();
  shellById<HTMLInputElement>('folder-new-name').value = 'Reading';
  shellById<HTMLFormElement>('folder-new').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ parentId: 'a', title: 'Reading' }));
  await vi.waitFor(() => expect(picker.chosenFolderId()).toBe('new'));
  expect(shellById('folder-create').hidden).toBe(true);
  expect(shellById<HTMLInputElement>('folder-new-name').value).toBe('');
  expect(local).toBeDefined();
});

test('a pick reports to the host once, and a result that must not change the save folder can opt out of remembering', async () => {
  const local = stubChrome(wideTree, {});
  const onPick = vi.fn();
  const { picker, panel, tree } = mountShellPicker({ onPick, remember: false });
  await picker.init('col-1', ['1']);
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  tree.querySelector<HTMLButtonElement>('[data-folder-id="b"]')!.click();
  await vi.waitFor(() => expect(onPick).toHaveBeenCalledExactlyOnceWith('b'));
  expect(picker.chosenFolderId()).toBe('b');
  expect(Object.keys(local).some((key) => key.startsWith('known.sync.folder'))).toBe(false);
  // Picking the folder that is already chosen is not a change.
  await picker.open();
  await vi.waitFor(() => expect(panel.hidden).toBe(false));
  tree.querySelector<HTMLButtonElement>('[data-folder-id="b"]')!.click();
  await vi.waitFor(() => expect(panel.hidden).toBe(true));
  expect(onPick).toHaveBeenCalledOnce();
});

test('an excluded root keeps its descendants local and rejects a server suggestion', async () => {
  stubChrome();
  const { picker } = mountPicker();
  await picker.init('library', ['1'], ['1']);
  expect(await picker.syncTarget()).toEqual({ kind: 'local' });
  expect(await picker.isOutOfRange()).toBe(true);
  expect(await picker.chooseSuggestedFolder('a')).toBe(false);
  expect(await picker.chooseSuggestedFolder('a', true)).toBe(true);
});
