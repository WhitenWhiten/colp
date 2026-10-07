import { describe, expect, it } from 'vitest'
import type { EditableNodeView, RootNodeView } from '../api'
import {
  childFolders,
  findFolder,
  flattenBookmarks,
  folderTrail,
  hostInitial,
  hostOf,
  immediateEntries,
  rootFolders,
} from './libraryTree'

function root(): RootNodeView {
  return {
    id: 'root-1',
    collectionId: 'col-1',
    kind: 'folder',
    folderRole: 'root',
    parentId: null,
    position: null,
    title: 'Root',
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: '"root"',
    readOnly: false,
    readOnlyReason: null,
    childrenRevision: '1',
    childrenEtag: '"root-children"',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }
}

function folder(id: string, title: string, parentId: string, position: string): EditableNodeView {
  return {
    id,
    collectionId: 'col-1',
    kind: 'folder',
    folderRole: null,
    parentId,
    position,
    title,
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: `"${id}"`,
    readOnly: false,
    readOnlyReason: null,
    childrenRevision: '1',
    childrenEtag: `"${id}-children"`,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }
}

function bookmark(id: string, title: string, parentId: string, position: string): EditableNodeView {
  return {
    id,
    collectionId: 'col-1',
    kind: 'bookmark',
    parentId,
    position,
    title,
    url: `https://${id}.example`,
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: `"${id}"`,
    readOnly: false,
    readOnlyReason: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }
}

describe('libraryTree', () => {
  const treeRoot = root()
  const nodes = [
    folder('folder-a', 'Design', 'root-1', '1'),
    folder('folder-b', 'Later', 'root-1', '2'),
    bookmark('bm-root', 'Loose link', 'root-1', '3'),
    bookmark('bm-a', 'Grid systems', 'folder-a', '1'),
    bookmark('bm-nested', 'Nested note', 'folder-a', '2'),
    bookmark('bm-b', 'Queue item', 'folder-b', '1'),
  ]

  it('lists only first-level folders under the collection root', () => {
    expect(rootFolders(treeRoot, nodes).map((item) => item.title)).toEqual(['Design', 'Later'])
  })

  it('flattens every bookmark, and can filter to one folder', () => {
    expect(flattenBookmarks(treeRoot, nodes).map((row) => row.node.title)).toEqual([
      'Grid systems',
      'Nested note',
      'Queue item',
      'Loose link',
    ])
    expect(flattenBookmarks(treeRoot, nodes, 'folder-b').map((row) => row.node.title)).toEqual([
      'Queue item',
    ])
  })

  it('derives a stable host mark from the URL', () => {
    expect(hostOf('https://www.example.com/path')).toBe('www.example.com')
    expect(hostInitial('www.example.com')).toBe('E')
    expect(hostInitial('')).toBe('#')
  })

  const deepNodes = [
    ...nodes,
    folder('folder-a-sub', 'Archive', 'folder-a', '3'),
    bookmark('bm-deep', 'Deep note', 'folder-a-sub', '1'),
  ]

  it('finds folders at any depth and ignores stale or non-folder ids', () => {
    expect(findFolder(deepNodes, 'folder-a-sub')?.title).toBe('Archive')
    expect(findFolder(deepNodes, 'bm-root')).toBeNull()
    expect(findFolder(deepNodes, 'gone')).toBeNull()
    expect(findFolder(deepNodes, null)).toBeNull()
  })

  it('walks the ancestor trail of a nested folder, root excluded', () => {
    expect(folderTrail(treeRoot, deepNodes, 'folder-a-sub').map((node) => node.title)).toEqual(['Design'])
    expect(folderTrail(treeRoot, deepNodes, 'folder-a')).toEqual([])
    expect(folderTrail(treeRoot, deepNodes, 'bm-root')).toEqual([])
  })

  it('lists subfolders of any folder in sibling order', () => {
    expect(childFolders('folder-a', deepNodes).map((node) => node.title)).toEqual(['Archive'])
    expect(childFolders('folder-b', deepNodes)).toEqual([])
  })

  it('returns one drill-down layer: direct subfolders with counts plus direct bookmarks', () => {
    const rootLayer = immediateEntries(treeRoot, deepNodes)
    expect(rootLayer.folders.map(({ node, directCount }) => [node.title, directCount])).toEqual([
      ['Design', 3],
      ['Later', 1],
    ])
    expect(rootLayer.bookmarks.map((node) => node.title)).toEqual(['Loose link'])

    const designLayer = immediateEntries(treeRoot, deepNodes, 'folder-a')
    expect(designLayer.folders.map(({ node }) => node.title)).toEqual(['Archive'])
    expect(designLayer.bookmarks.map((node) => node.title)).toEqual(['Grid systems', 'Nested note'])

    // Stale ids fall back to the root layer, like the public page.
    expect(immediateEntries(treeRoot, deepNodes, 'gone').bookmarks.map((node) => node.title))
      .toEqual(['Loose link'])
  })
})
