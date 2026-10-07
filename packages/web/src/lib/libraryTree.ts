import type { EditableNodeView, RootNodeView } from '../api'

export type BookmarkNode = Extract<EditableNodeView, { kind: 'bookmark' }>
export type FolderNode = Extract<EditableNodeView, { kind: 'folder' }>

export type BookmarkRow = {
  node: BookmarkNode
  folder: string
}

export function childrenOf(parentId: string, nodes: EditableNodeView[]): EditableNodeView[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => {
      const pa = a.position ?? ''
      const pb = b.position ?? ''
      if (pa < pb) return -1
      if (pa > pb) return 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

export function childFolders(parentId: string, nodes: EditableNodeView[]): FolderNode[] {
  return childrenOf(parentId, nodes).filter((node): node is FolderNode => node.kind === 'folder')
}

export function rootFolders(root: RootNodeView, nodes: EditableNodeView[]): FolderNode[] {
  return childFolders(root.id, nodes)
}

/** The folder for a `?folder=` param, at any depth; null for stale/foreign ids. */
export function findFolder(nodes: EditableNodeView[], folderId: string | null | undefined): FolderNode | null {
  if (!folderId) return null
  const node = nodes.find((candidate) => candidate.id === folderId && candidate.kind === 'folder')
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
  const byId = new Map(nodes.map((node) => [node.id, node]))
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
  const parentId = folderId && nodes.some((node) => node.id === folderId && node.kind === 'folder')
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
  const start = folderId && nodes.some((node) => node.id === folderId && node.kind === 'folder')
    ? folderId
    : root.id
  const startTitle = start === root.id
    ? ''
    : nodes.find((node) => node.id === start && node.kind === 'folder')?.title ?? ''
  const rows: BookmarkRow[] = []
  const visit = (parentId: string, folder: string, lineage: ReadonlySet<string>) => {
    for (const node of childrenOf(parentId, nodes)) {
      if (lineage.has(node.id)) continue
      const next = new Set(lineage)
      next.add(node.id)
      if (node.kind === 'folder') {
        visit(node.id, node.title, next)
      } else if (node.kind === 'bookmark') {
        rows.push({ node, folder })
      }
    }
  }
  visit(start, startTitle, new Set([start]))
  return rows
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export function hostInitial(host: string): string {
  const leaf = host.replace(/^www\./, '').trim()
  const letter = leaf.charAt(0)
  return letter ? letter.toUpperCase() : '#'
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}
