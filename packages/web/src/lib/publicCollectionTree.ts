import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api'
import { previewCover, type PreviewCover } from './linkPreview'

export function safeExternalUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

export function hostForUrl(value: string | null): string {
  if (!value) return '-'
  try {
    const url = new URL(value)
    return url.hostname || '-'
  } catch {
    return '-'
  }
}

export function comparePublicSiblings(left: PublicCollectionNode, right: PublicCollectionNode): number {
  const leftPosition = left.position ?? ''
  const rightPosition = right.position ?? ''
  if (leftPosition < rightPosition) return -1
  if (leftPosition > rightPosition) return 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export type PublicCollectionResource = {
  node: PublicCollectionNode
  depth: number
  path: string[]
  /** Ancestor folder ids (root excluded), parallel to `path` — the strict
      membership key for folder filtering (titles can collide or repeat). */
  pathIds: string[]
  href: string | null
  host: string
}

export type PublicCollectionFolder = {
  node: PublicCollectionNode
  depth: number
}

export function flattenPublicCollection(snapshot: PublicCollectionSnapshot) {
  const root = snapshot.nodes.find(
    (node) => node.id === snapshot.collection.rootNodeId && node.kind === 'root',
  )
  if (!root) return null

  const childrenByParent = new Map<string, PublicCollectionNode[]>()
  for (const node of snapshot.nodes) {
    if (node.id === root.id || node.parentId === null) continue
    const children = childrenByParent.get(node.parentId) ?? []
    children.push(node)
    childrenByParent.set(node.parentId, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort(comparePublicSiblings)
  }

  const folders: PublicCollectionFolder[] = []
  const resources: PublicCollectionResource[] = []

  const visit = (parentId: string, depth: number, path: string[], pathIds: string[], lineage: ReadonlySet<string>) => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (lineage.has(node.id)) continue
      const nextLineage = new Set(lineage)
      nextLineage.add(node.id)
      if (node.kind === 'folder') {
        folders.push({ node, depth })
        visit(node.id, depth + 1, [...path, node.title], [...pathIds, node.id], nextLineage)
      } else if (node.kind === 'bookmark') {
        resources.push({
          node,
          depth,
          path,
          pathIds,
          href: safeExternalUrl(node.url),
          host: hostForUrl(node.url),
        })
      }
    }
  }

  visit(root.id, 0, [], [], new Set([root.id]))
  return { root, folders, resources }
}

/** Direct children of a node, in sibling position order. */
export function childrenOf(
  snapshot: PublicCollectionSnapshot,
  parentId: string,
): PublicCollectionNode[] {
  return snapshot.nodes
    .filter((node) => node.parentId === parentId && node.id !== parentId)
    .sort(comparePublicSiblings)
}

/** Ancestor folders of `folderId`, root-first, excluding the published root
    and the folder itself. Unknown / non-folder ids and broken or cyclic
    parent chains resolve to the ancestors actually reachable (possibly
    none) instead of throwing. */
export function folderAncestors(
  snapshot: PublicCollectionSnapshot,
  folderId: string,
): PublicCollectionNode[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const rootId = snapshot.collection.rootNodeId
  const start = byId.get(folderId)
  if (!start || start.kind !== 'folder') return []
  const chain: PublicCollectionNode[] = []
  const seen = new Set<string>([folderId])
  let current = start
  while (current.parentId !== null && current.parentId !== rootId) {
    const parent = byId.get(current.parentId)
    if (!parent || parent.kind !== 'folder' || seen.has(parent.id)) break
    chain.unshift(parent)
    seen.add(parent.id)
    current = parent
  }
  return chain
}

export type PublicCollectionFolderEntry = {
  node: PublicCollectionNode
  /** Direct children (subfolders + bookmarks). Null when the count is unknown. */
  directCount: number | null
}

export type PublicCollectionEntries = {
  folders: PublicCollectionFolderEntry[]
  resources: PublicCollectionResource[]
}

/** One layer of the drill-down view: the direct subfolders and direct
    bookmarks of `folderId` (or of the published root when null/unknown).
    Bookmarks carry their full root-relative path so metadata matches the
    flattened walk. */
export function immediateEntries(
  snapshot: PublicCollectionSnapshot,
  folderId: string | null = null,
): PublicCollectionEntries {
  const rootId = snapshot.collection.rootNodeId
  const current = folderId
    ? snapshot.nodes.find((node) => node.id === folderId && node.kind === 'folder')
    : undefined
  const ancestors = current ? folderAncestors(snapshot, current.id) : []
  const path = current ? [...ancestors.map((node) => node.title), current.title] : []
  const pathIds = current ? [...ancestors.map((node) => node.id), current.id] : []

  // R15-28: one pass counts every parent's children; calling childrenOf per
  // folder scanned all nodes once per folder.
  const childCounts = new Map<string, number>()
  for (const node of snapshot.nodes) {
    if (node.parentId === null || node.parentId === node.id) continue
    childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1)
  }
  const folders: PublicCollectionFolderEntry[] = []
  const resources: PublicCollectionResource[] = []
  for (const node of childrenOf(snapshot, current?.id ?? rootId)) {
    if (node.kind === 'folder') {
      folders.push({ node, directCount: childCounts.get(node.id) ?? 0 })
    } else if (node.kind === 'bookmark') {
      resources.push({
        node,
        depth: path.length,
        path,
        pathIds,
        href: safeExternalUrl(node.url),
        host: hostForUrl(node.url),
      })
    }
  }
  return { folders, resources }
}

/** Everything filed below a folder, at any depth. */
export type PublicFolderTotals = {
  bookmarks: number
  folders: number
}

/** Subtree totals for every folder of the flattened walk — what the
    Contents rows, the folder cards and the in-folder head count. Bookmarks
    come from each resource's pathIds (one pass); folders climb their
    parent chain, cut at the first repeat so a cyclic chain terminates. */
export function folderTotals(
  folders: readonly PublicCollectionFolder[],
  resources: readonly PublicCollectionResource[],
): Map<string, PublicFolderTotals> {
  const totals = new Map<string, PublicFolderTotals>()
  const parentOf = new Map<string, string | null>()
  for (const { node } of folders) {
    totals.set(node.id, { bookmarks: 0, folders: 0 })
    parentOf.set(node.id, node.parentId)
  }
  for (const resource of resources) {
    for (const id of resource.pathIds) {
      const entry = totals.get(id)
      if (entry) entry.bookmarks += 1
    }
  }
  for (const { node } of folders) {
    const seen = new Set<string>([node.id])
    let parentId = parentOf.get(node.id) ?? null
    while (parentId !== null && !seen.has(parentId)) {
      const entry = totals.get(parentId)
      if (!entry) break
      entry.folders += 1
      seen.add(parentId)
      parentId = parentOf.get(parentId) ?? null
    }
  }
  return totals
}

/** What a folder card shows when the folders are the whole layer: its
    subtree bookmark total, its direct subfolders, and the first few
    bookmarks in curated (DFS) order. */
export type PublicFolderPreview = {
  bookmarkCount: number
  folderCount: number
  sample: PublicCollectionResource[]
  /** First valid preview covers anywhere inside (Gallery mosaic). */
  covers: PreviewCover[]
}

/** Previews for a layer's folders from one children index over the
    snapshot (instead of a node scan per child). Cyclic parents are cut by
    the visited set. */
export function folderPreviews(
  snapshot: PublicCollectionSnapshot,
  folderIds: readonly string[],
  sampleSize = 3,
  coverLimit = 4,
): Map<string, PublicFolderPreview> {
  const children = new Map<string, PublicCollectionNode[]>()
  for (const node of snapshot.nodes) {
    if (!node.parentId || node.parentId === node.id) continue
    const siblings = children.get(node.parentId)
    if (siblings) siblings.push(node)
    else children.set(node.parentId, [node])
  }
  for (const siblings of children.values()) siblings.sort(comparePublicSiblings)

  const previews = new Map<string, PublicFolderPreview>()
  for (const folderId of folderIds) {
    const preview: PublicFolderPreview = { bookmarkCount: 0, folderCount: 0, sample: [], covers: [] }
    const visited = new Set<string>([folderId])
    const walk = (parentId: string) => {
      for (const node of children.get(parentId) ?? []) {
        if (visited.has(node.id)) continue
        visited.add(node.id)
        if (node.kind === 'folder') {
          if (parentId === folderId) preview.folderCount += 1
          walk(node.id)
        } else if (node.kind === 'bookmark') {
          preview.bookmarkCount += 1
          if (preview.covers.length < coverLimit) {
            const cover = previewCover(node.previewImage)
            if (cover) preview.covers.push(cover)
          }
          if (preview.sample.length < sampleSize) {
            preview.sample.push({
              node, depth: 0, path: [], pathIds: [],
              href: safeExternalUrl(node.url),
              host: hostForUrl(node.url),
            })
          }
        }
      }
    }
    walk(folderId)
    previews.set(folderId, preview)
  }
  return previews
}

/** Adjacent bookmarks in the position-sorted DFS walk (anonymous tree edges). */
export function publicCollectionTreeEdges(
  resources: Array<{ node: { id: string } }>,
): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  for (let index = 0; index < resources.length - 1; index += 1) {
    const from = resources[index]?.node.id
    const to = resources[index + 1]?.node.id
    if (from && to) edges.push([from, to])
  }
  return edges
}

export function publicCollectionKindLabel(
  kind: PublicCollectionSnapshot['collection']['kind'],
): string {
  switch (kind) {
    case 'bookmarks': return 'Bookmarks'
    case 'reading_path': return 'Reading path'
    case 'knowledge_collection': return 'Knowledge collection'
    case 'mixed': return 'Mixed collection'
  }
}
