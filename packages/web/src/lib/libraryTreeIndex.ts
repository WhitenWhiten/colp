import type { EditableNodeView } from '../api'

type TreeIndex = {
  byId: Map<string, EditableNodeView>
  children: Map<string, EditableNodeView[]>
  bookmarkCounts: Map<string, number>
}
// Snapshot node arrays are immutable React data. A replacement snapshot owns a new index.
const snapshots = new WeakMap<EditableNodeView[], TreeIndex>()
export function libraryTreeIndex(nodes: EditableNodeView[]): TreeIndex {
  const cached = snapshots.get(nodes)
  if (cached) return cached
  const byId = new Map<string, EditableNodeView>(), children = new Map<string, EditableNodeView[]>()
  for (const node of nodes) {
    byId.set(node.id, node)
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node); children.set(node.parentId, siblings)
    if (node.kind === 'folder' && !children.has(node.id)) children.set(node.id, [])
  }
  for (const siblings of children.values()) siblings.sort((a, b) => {
    const left = a.position ?? '', right = b.position ?? ''
    return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const pending = new Map<string, number>(), totals = new Map<string, number>(), ready: string[] = []
  for (const [id, siblings] of children) {
    const folders = siblings.filter(node => node.kind === 'folder').length
    pending.set(id, folders); totals.set(id, siblings.filter(node => node.kind === 'bookmark').length)
    if (!folders) ready.push(id)
  }
  const bookmarkCounts = new Map<string, number>()
  for (let at = 0; at < ready.length; at++) {
    const id = ready[at]!, count = totals.get(id) ?? 0
    bookmarkCounts.set(id, count)
    const node = byId.get(id)
    if (!node || node.kind !== 'folder' || !pending.has(node.parentId)) continue
    totals.set(node.parentId, (totals.get(node.parentId) ?? 0) + count)
    const remaining = pending.get(node.parentId)! - 1
    pending.set(node.parentId, remaining)
    if (remaining === 0) ready.push(node.parentId)
  }
  const index = { byId, children, bookmarkCounts }
  snapshots.set(nodes, index)
  return index
}
