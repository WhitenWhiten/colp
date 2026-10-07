import { describe, expect, it } from 'vitest'
import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import {
  childrenOf,
  flattenPublicCollection,
  folderAncestors,
  folderTotals,
  immediateEntries,
  publicCollectionTreeEdges,
  type PublicCollectionFolder,
} from './publicCollectionTree'

function rootNode(): PublicCollectionNode {
  return {
    id: 'root-1', parentId: null, kind: 'root', title: 'Published contents',
    description: null, url: null, position: null,
  }
}

function folder(id: string, parentId: string, position: string, title = id): PublicCollectionNode {
  return {
    id, parentId, kind: 'folder', title, description: null, url: null, position,
  }
}

function bookmark(
  id: string,
  parentId: string,
  position: string,
  title = id,
  url = `https://${id}.example/`,
): PublicCollectionNode {
  return {
    id, parentId, kind: 'bookmark', title, description: `${title} summary`, url, position,
  }
}

function snapshot(nodes: PublicCollectionNode[]): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-public',
      slug: 'research-notes',
      title: 'Research notes',
      summary: 'A maintained map.',
      kind: 'reading_path',
      rootNodeId: 'root-1',
      owner: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'curator',
        displayName: 'Curator', avatarUrl: null,
      },
      updatedAt: '2026-07-24T12:00:00.000Z',
      access: 'public',
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

describe('flattenPublicCollection', () => {
  it('returns bookmarks in sibling position order, not snapshot insertion order', () => {
    const published = flattenPublicCollection(snapshot([
      rootNode(),
      bookmark('nd-b', 'root-1', '00000000000000000001', 'Inserted first'),
      bookmark('nd-a', 'root-1', '00000000000000000000', 'Inserted second'),
    ]))
    expect(published?.resources.map((resource) => resource.node.title)).toEqual([
      'Inserted second',
      'Inserted first',
    ])
  })

  it('walks folders depth-first with position-sorted siblings', () => {
    const published = flattenPublicCollection(snapshot([
      rootNode(),
      folder('folder-z', 'root-1', '00000000000000000001', 'Later folder'),
      bookmark('nd-later', 'folder-z', '00000000000000000000', 'Later bookmark'),
      folder('folder-a', 'root-1', '00000000000000000000', 'Earlier folder'),
      bookmark('nd-early-b', 'folder-a', '00000000000000000001', 'Early B'),
      bookmark('nd-early-a', 'folder-a', '00000000000000000000', 'Early A'),
      bookmark('nd-root', 'root-1', '00000000000000000002', 'Root bookmark'),
    ]))
    expect(published?.folders.map((item) => item.node.title)).toEqual([
      'Earlier folder',
      'Later folder',
    ])
    expect(published?.resources.map((resource) => resource.node.title)).toEqual([
      'Early A',
      'Early B',
      'Later bookmark',
      'Root bookmark',
    ])
    expect(published?.resources[0]?.path).toEqual(['Earlier folder'])
    expect(published?.resources[0]?.host).toBe('nd-early-a.example')
    expect(published?.resources[0]?.href).toBe('https://nd-early-a.example/')
  })

  it('returns null when the published root is missing', () => {
    expect(flattenPublicCollection(snapshot([bookmark('nd-a', 'root-1', '0')]))).toBeNull()
  })
})

/* Shared drill-down fixture:
   root ├── folder-a "Guides"        (position 0)
        │     ├── folder-b "Classics" (position 0)
        │     │     └── nd-deep
        │     ├── nd-a2               (position 2)
        │     └── nd-a1               (position 1)
        └── nd-root "Loose bookmark"  (position 1) */
function drillSnapshot(): PublicCollectionSnapshot {
  return snapshot([
    rootNode(),
    folder('folder-a', 'root-1', '00000000000000000000', 'Guides'),
    folder('folder-b', 'folder-a', '00000000000000000000', 'Classics'),
    bookmark('nd-deep', 'folder-b', '00000000000000000001', 'Deep note'),
    bookmark('nd-a2', 'folder-a', '00000000000000000002', 'Guide B'),
    bookmark('nd-a1', 'folder-a', '00000000000000000001', 'Guide A'),
    bookmark('nd-root', 'root-1', '00000000000000000001', 'Loose bookmark'),
  ])
}

describe('childrenOf', () => {
  it('returns direct children in sibling position order, folders and bookmarks mixed', () => {
    const published = drillSnapshot()
    expect(childrenOf(published, 'root-1').map((node) => node.title)).toEqual([
      'Guides',
      'Loose bookmark',
    ])
    expect(childrenOf(published, 'folder-a').map((node) => node.title)).toEqual([
      'Classics',
      'Guide A',
      'Guide B',
    ])
    expect(childrenOf(published, 'nd-root')).toEqual([])
  })
})

describe('folderAncestors', () => {
  it('returns the root-first ancestor chain, excluding the root and the folder itself', () => {
    const published = drillSnapshot()
    expect(folderAncestors(published, 'folder-b').map((node) => node.id)).toEqual(['folder-a'])
    expect(folderAncestors(published, 'folder-a')).toEqual([])
  })

  it('resolves unknown ids and bookmark ids to an empty chain', () => {
    const published = drillSnapshot()
    expect(folderAncestors(published, 'missing')).toEqual([])
    expect(folderAncestors(published, 'nd-deep')).toEqual([])
  })
})

describe('immediateEntries', () => {
  it('lists first-level folders with direct counts and only loose root bookmarks', () => {
    const entries = immediateEntries(drillSnapshot(), null)
    expect(entries.folders.map((entry) => entry.node.title)).toEqual(['Guides'])
    expect(entries.folders[0]?.directCount).toBe(3)
    expect(entries.resources.map((resource) => resource.node.title)).toEqual(['Loose bookmark'])
    expect(entries.resources[0]?.depth).toBe(0)
    expect(entries.resources[0]?.path).toEqual([])
  })

  it('lists a folder layer with its direct subfolders and bookmarks carrying full paths', () => {
    const entries = immediateEntries(drillSnapshot(), 'folder-a')
    expect(entries.folders.map((entry) => entry.node.title)).toEqual(['Classics'])
    expect(entries.folders[0]?.directCount).toBe(1)
    expect(entries.resources.map((resource) => resource.node.title)).toEqual(['Guide A', 'Guide B'])
    expect(entries.resources[0]?.path).toEqual(['Guides'])
    expect(entries.resources[0]?.pathIds).toEqual(['folder-a'])
    expect(entries.resources[0]?.depth).toBe(1)
    expect(entries.resources[0]?.href).toBe('https://nd-a1.example/')

    const nested = immediateEntries(drillSnapshot(), 'folder-b')
    expect(nested.folders).toEqual([])
    expect(nested.resources.map((resource) => resource.node.title)).toEqual(['Deep note'])
    expect(nested.resources[0]?.path).toEqual(['Guides', 'Classics'])
    expect(nested.resources[0]?.pathIds).toEqual(['folder-a', 'folder-b'])
  })

  it('falls back to the root layer for unknown folder ids', () => {
    const entries = immediateEntries(drillSnapshot(), 'missing')
    expect(entries.folders.map((entry) => entry.node.title)).toEqual(['Guides'])
    expect(entries.resources.map((resource) => resource.node.title)).toEqual(['Loose bookmark'])
  })
})

describe('folderTotals', () => {
  it('counts every bookmark and folder filed below each folder, at any depth', () => {
    const published = flattenPublicCollection(snapshot([
      ...drillSnapshot().nodes,
      folder('folder-c', 'folder-b', '00000000000000000001', 'Rare'),
      bookmark('nd-rare', 'folder-c', '00000000000000000000', 'Rare note'),
      folder('folder-empty', 'root-1', '00000000000000000002', 'Empty'),
    ]))
    expect(published).not.toBeNull()
    const totals = folderTotals(published!.folders, published!.resources)
    expect(Object.fromEntries(totals)).toEqual({
      'folder-a': { bookmarks: 4, folders: 2 },
      'folder-b': { bookmarks: 2, folders: 1 },
      'folder-c': { bookmarks: 1, folders: 0 },
      'folder-empty': { bookmarks: 0, folders: 0 },
    })
  })

  it('stops climbing a cyclic parent chain', () => {
    const looped: PublicCollectionFolder[] = [
      { node: folder('folder-x', 'folder-y', '0'), depth: 0 },
      { node: folder('folder-y', 'folder-x', '0'), depth: 1 },
    ]
    expect(Object.fromEntries(folderTotals(looped, []))).toEqual({
      'folder-x': { bookmarks: 0, folders: 1 },
      'folder-y': { bookmarks: 0, folders: 1 },
    })
  })
})

describe('publicCollectionTreeEdges', () => {
  it('connects adjacent bookmarks along the position-sorted tree walk', () => {
    const published = flattenPublicCollection(snapshot([
      rootNode(),
      bookmark('nd-b', 'root-1', '00000000000000000001', 'B'),
      folder('folder-a', 'root-1', '00000000000000000000', 'Folder'),
      bookmark('nd-a2', 'folder-a', '00000000000000000001', 'A2'),
      bookmark('nd-a1', 'folder-a', '00000000000000000000', 'A1'),
    ]))
    expect(published).not.toBeNull()
    expect(publicCollectionTreeEdges(published!.resources)).toEqual([
      ['nd-a1', 'nd-a2'],
      ['nd-a2', 'nd-b'],
    ])
  })
})
