import { productClient } from '../../api'
import type { EditableNodeView } from '../../api'
import { childrenOf } from '../../lib/libraryTree'

/* Where rules point: the owner's collections, their folders with readable
   paths, and this server's identity (a folder binding names the canonical
   serverUuid/collectionId/nodeId, never a label or a path). Labels here are
   presentation; the binding follows the folder's identity. */

export type FolderEntry = {
  id: string
  title: string
  /** "Reading › Academic"; the top level is the collection itself. */
  path: string
  depth: number
}

export type CollectionFolders = {
  collectionId: string
  rootId: string
  folders: FolderEntry[]
}

export type CollectionChoice = { id: string; title: string }

export interface FolderSource {
  listCollections(signal?: AbortSignal): Promise<CollectionChoice[]>
  loadFolders(collectionId: string, signal?: AbortSignal): Promise<CollectionFolders>
  /** The manifest's serverUuid, which every folder binding carries. */
  serverUuid(signal?: AbortSignal): Promise<string>
}

export function folderEntries(rootId: string, nodes: readonly EditableNodeView[]): FolderEntry[] {
  const entries: FolderEntry[] = []
  // Index folders by parent once; childrenOf then only sorts each small group.
  const byParent = new Map<string, EditableNodeView[]>()
  for (const node of nodes) {
    if (node.kind !== 'folder' || !node.parentId) continue
    const group = byParent.get(node.parentId)
    if (group) group.push(node)
    else byParent.set(node.parentId, [node])
  }
  const visit = (parentId: string, trail: readonly string[], lineage: ReadonlySet<string>) => {
    for (const node of childrenOf(parentId, byParent.get(parentId) ?? [])) {
      if (node.kind !== 'folder' || lineage.has(node.id)) continue
      const path = [...trail, node.title]
      entries.push({ id: node.id, title: node.title, path: path.join(' › '), depth: trail.length })
      visit(node.id, path, new Set([...lineage, node.id]))
    }
  }
  visit(rootId, [], new Set([rootId]))
  return entries
}

let manifestUuid: Promise<string> | null = null

export const defaultFolderSource: FolderSource = {
  async listCollections(signal) {
    const items = await productClient.loadOwnedCollections({}, { signal, maxRetries: 0 })
    return items.map((item) => ({ id: item.collection.id, title: item.collection.title }))
  },
  async loadFolders(collectionId, signal) {
    const snapshot = await productClient.loadEditorSnapshot(collectionId, { signal, maxRetries: 0 })
    return { collectionId, rootId: snapshot.root.id, folders: folderEntries(snapshot.root.id, snapshot.nodes) }
  },
  serverUuid() {
    manifestUuid ??= fetch('/.well-known/collection-protocol', { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        const body = response.ok ? await response.json() as unknown : null
        const uuid = body && typeof body === 'object' ? (body as { serverUuid?: unknown }).serverUuid : undefined
        if (typeof uuid !== 'string' || !uuid) throw new Error('This server did not say who it is.')
        return uuid
      })
      .catch((error: unknown) => {
        manifestUuid = null
        throw error
      })
    return manifestUuid
  },
}
