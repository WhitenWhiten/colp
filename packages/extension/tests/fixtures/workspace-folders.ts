import type { FolderTreeNode } from '../../src/save-folder.js';

/** Edge's workspace container is a peer of the native bookmark roots. */
export function workspaceFolderTree(title = 'Workspaces'): FolderTreeNode[] {
  return [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
      { id: 'a', parentId: '1', title: 'Research', children: [] },
      { id: 'user-workspace', parentId: '1', title, children: [] },
    ] },
    { id: 'workspaces', parentId: '0', title, children: [
      { id: 'project', parentId: 'workspaces', title: 'Research project', children: [
        { id: 'workspace-folder', parentId: 'project', title: 'Workspace papers', children: [] },
        { id: 'workspace-bookmark', parentId: 'project', title: 'Workspace page', url: 'https://workspace.example/' },
      ] },
    ] },
    { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [
      { id: 'b', parentId: '2', title: 'Recipes', children: [] },
    ] },
  ] }];
}
