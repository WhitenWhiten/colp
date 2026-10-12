import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { personalBookmarks } from '../src/bookmark-subscriptions/guards.js';
import { resolveDefaultBookmarkParent } from '../src/bookmark-placement.js';
import type { FolderTreeNode } from '../src/save-folder.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';
import { captureTarget } from '../src/sw/capture-target.js';
import { task } from './fixtures/capture.js';
import { buildFolderRows } from '../src/folder-tree-model.js';
import { projectManagerRoot } from '../src/bookmark-manager-visibility.js';
import { supportedBookmarkTree } from '../src/bookmark-folder-policy.js';
import { folderChoices } from '../src/library-folder-picker.js';

vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  ready: async () => undefined, all: async () => [], count: async () => 0, pendingOperations: async () => [],
} }));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureScope: async () => undefined }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: {} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { throw new Error('signed_out'); } }));

function nodesById(nodes: readonly FolderTreeNode[]): Map<string, FolderTreeNode> {
  return new Map(nodes.flatMap(node => [[node.id, node] as const, ...nodesById(node.children ?? [])]));
}

beforeEach(() => {
  const nodes = nodesById(workspaceFolderTree());
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } }, bookmarks: {
    get: async (id: string) => nodes.has(id) ? [nodes.get(id)] : [],
    create: vi.fn(async () => ({ id: 'created', title: 'Page' })),
    move: vi.fn(async () => ({ id: 'saved', title: 'Page' })),
  } });
});
afterEach(() => vi.unstubAllGlobals());

test.each(['workspaces', 'project', 'workspace-folder'])('native writes cannot target %s', async parentId => {
  await expect(personalBookmarks.create({ parentId, title: 'Page', url: 'https://example.org/' }))
    .rejects.toThrow('bookmark_folder_unavailable');
  await expect(personalBookmarks.create({ parentId, title: 'New folder' }))
    .rejects.toThrow('bookmark_folder_unavailable');
  await expect(personalBookmarks.move('a', { parentId })).rejects.toThrow('bookmark_folder_unavailable');
  expect(chrome.bookmarks.create).not.toHaveBeenCalled();
  expect(chrome.bookmarks.move).not.toHaveBeenCalled();
});

test.each(['workspaces', 'project', 'workspace-folder'])('capture admission refuses %s', async nativeId => {
  await expect(captureTarget(task.scope, nativeId)).rejects.toThrow('capture_target_unavailable');
});

test('a user-created same-name folder remains a valid native destination', async () => {
  await personalBookmarks.create({ parentId: 'user-workspace', title: 'Page', url: 'https://example.org/' });
  await personalBookmarks.move('a', { parentId: 'user-workspace' });
  expect(chrome.bookmarks.create).toHaveBeenCalledOnce();
  expect(chrome.bookmarks.move).toHaveBeenCalledExactlyOnceWith('a', { parentId: 'user-workspace' });
  expect(await captureTarget(task.scope, 'user-workspace')).toMatchObject({ nativeId: 'user-workspace' });
});

test('the browser default never falls back to the workspace container', async () => {
  const tree = workspaceFolderTree();
  expect(await resolveDefaultBookmarkParent({ getTree: async () => tree })).toBe('2');
  const children = tree[0]!.children!.map(node => node.id === '2' ? { ...node, id: 'other' } : node);
  expect(await resolveDefaultBookmarkParent({ getTree: async () => [{ ...tree[0]!, children }] })).toBe('other');
});

test('older Chromium bookmark roots are retained by identity regardless of their names', () => {
  const root: FolderTreeNode = { id: '0', title: '', children: ['1', '2', '3'].map(id => ({
    id, parentId: '0', title: 'Workspaces', children: [{ id: `folder-${id}`, parentId: id, title: 'Group', children: [] }],
  })) };
  expect(projectManagerRoot(root)).toBe(root);
  expect(buildFolderRows([root], { mounts: new Set(), excluded: new Set() }).map(row => row.id))
    .toEqual(['1', 'folder-1', '2', 'folder-2', '3', 'folder-3']);
});

test('modern account bookmark roots are retained by type with arbitrary native ids', () => {
  const root: FolderTreeNode = { id: '0', title: '', children: [
    { id: '401', parentId: '0', title: 'Workspaces', folderType: 'bookmarks-bar', children: [] },
    { id: '402', parentId: '0', title: 'Group', folderType: 'other', children: [] },
    { id: '403', parentId: '0', title: '作業スペース', folderType: 'mobile', children: [] },
  ] };
  expect(projectManagerRoot(root)).toBe(root);
  expect(buildFolderRows([root], { mounts: new Set(), excluded: new Set() }).map(row => row.id)).toEqual(['401', '402', '403']);
});

test('an explicit unsupported root type cannot borrow a legacy bookmark root identity', () => {
  const root: FolderTreeNode = { id: '0', title: '', children: [
    { id: '3', parentId: '0', title: 'Any name', folderType: 'workspace', children: [{ id: 'project', title: 'Project', children: [] }] },
  ] };
  expect(projectManagerRoot(root).children).toEqual([]);
  expect(buildFolderRows([root], { mounts: new Set(['3']), excluded: new Set() })).toEqual([]);
});

test.each(['工作区', 'Workspaces', 'Renamed container'])('shared folder choices and native projections exclude the %s subtree', title => {
  const raw = workspaceFolderTree(title), before = structuredClone(raw);
  const projected = supportedBookmarkTree(raw);
  expect(projected[0]?.children?.map(node => node.id)).toEqual(['1', '2']);
  expect(folderChoices(raw).map(choice => choice.id)).toEqual(['1', 'a', 'user-workspace', '2', 'b']);
  expect(folderChoices(raw).find(choice => choice.id === 'user-workspace')?.title).toBe(title);
  expect(raw).toEqual(before);
});

test('shared choices keep every descendant of a managed root disabled', () => {
  const choices = folderChoices([{ id: '0', title: '', children: [
    { id: 'policy', title: 'Managed', unmodifiable: 'managed', children: [{ id: 'child', title: 'Child', children: [] }] },
  ] }]);
  expect(choices.map(choice => [choice.id, choice.disabled])).toEqual([['policy', true], ['child', true]]);
});
