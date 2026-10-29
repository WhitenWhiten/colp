import type { EditableNodeView, RootNodeView } from '../api'
import { libraryTreeIndex } from './libraryTreeIndex'

export type BookmarkNode = Extract<EditableNodeView, { kind: 'bookmark' }>
export type FolderNode = Extract<EditableNodeView, { kind: 'folder' }>

/** The library's root reads All bookmarks everywhere (the library, search,
    automations); its stored title never shows. */
export const LIBRARY_ROOT = 'All bookmarks'

/** Other collections keep their own titles. */
export function rootTitle(collection: { title: string; library?: boolean }): string {
  return collection.library ? LIBRARY_ROOT : collection.title
}

export type BookmarkRow = {
  node: BookmarkNode
  folder: string
}

export function childrenOf(parentId: string, nodes: EditableNodeView[]): EditableNodeView[] {
  return [...(libraryTreeIndex(nodes).children.get(parentId) ?? [])]
}

export function childFolders(parentId: string, nodes: EditableNodeView[]): FolderNode[] {
  return childrenOf(parentId, nodes).filter((node): node is FolderNode => node.kind === 'folder')
}

/** The folder for a `?folder=` param, at any depth; null for stale/foreign ids. */
export function findFolder(nodes: EditableNodeView[], folderId: string | null | undefined): FolderNode | null {
  if (!folderId) return null
  const candidate = libraryTreeIndex(nodes).byId.get(folderId)
  const node = candidate?.kind === 'folder' ? candidate : undefined
  return (node as FolderNode | undefined) ?? null
}

/** Ancestor folders of `folderId`, top-down, root and the folder itself
    excluded. Broken or cyclic parent chains resolve to the ancestors
    actually reachable instead of throwing. */
export function folderTrail(
  root: RootNodeView,
  nodes: EditableNodeView[],
  folderId: string,
): FolderNode[] {
  const { byId } = libraryTreeIndex(nodes)
  const start = byId.get(folderId)
  if (!start || start.kind !== 'folder') return []
  const chain: FolderNode[] = []
  const seen = new Set<string>([folderId])
  let current: FolderNode = start
  while (current.parentId !== root.id) {
    const parent = byId.get(current.parentId)
    if (!parent || parent.kind !== 'folder' || seen.has(parent.id)) break
    chain.unshift(parent)
    seen.add(parent.id)
    current = parent
  }
  return chain
}

export type LibraryFolderEntry = {
  node: FolderNode
  /** Direct children (subfolders + bookmarks) — the count on folder rows. */
  directCount: number
}

export type LibraryLayerEntries = {
  folders: LibraryFolderEntry[]
  bookmarks: BookmarkNode[]
}

/** One layer of the desk drill-down: the direct subfolders and direct
    bookmarks of `folderId` (or of the root when null/unknown) — the same
    model the public collection page uses. */
export function immediateEntries(
  root: RootNodeView,
  nodes: EditableNodeView[],
  folderId?: string | null,
): LibraryLayerEntries {
  const parentId = folderId && findFolder(nodes, folderId)
    ? folderId
    : root.id
  const folders: LibraryFolderEntry[] = []
  const bookmarks: BookmarkNode[] = []
  for (const node of childrenOf(parentId, nodes)) {
    if (node.kind === 'folder') {
      folders.push({ node, directCount: childrenOf(node.id, nodes).length })
    } else if (node.kind === 'bookmark') {
      bookmarks.push(node)
    }
  }
  return { folders, bookmarks }
}

export function flattenBookmarks(
  root: RootNodeView,
  nodes: EditableNodeView[],
  folderId?: string | null,
): BookmarkRow[] {
  const folder = findFolder(nodes, folderId)
  const start = folder?.id ?? root.id
  const { children } = libraryTreeIndex(nodes)
  const pending = [...(children.get(start) ?? [])].reverse().map(node => ({ node, folder: folder?.title ?? '' }))
  const seen = new Set([start]), rows: BookmarkRow[] = []
  while (pending.length) {
    const current = pending.pop()!
    if (seen.has(current.node.id)) continue
    seen.add(current.node.id)
    if (current.node.kind === 'bookmark') rows.push({ node: current.node, folder: current.folder })
    else if (current.node.kind === 'folder') {
      const siblings = children.get(current.node.id) ?? []
      for (let i = siblings.length - 1; i >= 0; i--) pending.push({ node: siblings[i]!, folder: current.node.title })
    }
  }
  return rows
}

/** All folder totals are computed once per snapshot; malformed cycles use the guarded traversal. */
export function countBookmarks(root: RootNodeView, nodes: EditableNodeView[], folderId?: string | null): number {
  const id = findFolder(nodes, folderId)?.id ?? root.id
  return libraryTreeIndex(nodes).bookmarkCounts.get(id) ?? flattenBookmarks(root, nodes, folderId).length
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/**
 * The host as a person reads it: a leading `www.` is dropped, so the same
 * bookmark reads `anthropic.com` in the library, a shared page, the graph and
 * the inbox alike. Display text only: search matching, favicon keys and URLs,
 * resource kind detection and the DomainMark tone keep the raw host.
 */
export function displayHost(host: string): string {
  return host.replace(/^www\.(?=.)/iu, '')
}

export function hostInitial(host: string): string {
  const leaf = displayHost(host).trim()
  const letter = leaf.charAt(0)
  return letter ? letter.toUpperCase() : '#'
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
