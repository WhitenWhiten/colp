import type {
  EditableNodeView,
  EditorSnapshot,
  FolderNodeView,
  RootNodeView,
} from '../../api'
import type { TreeNode } from './types'

export function isFolder(n: TreeNode): n is FolderNodeView | RootNodeView {
  return n.kind === 'folder'
}

export function childrenOf(
  parentId: string,
  nodes: EditableNodeView[],
): EditableNodeView[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => {
      const pa = a.position ?? ''
      const pb = b.position ?? ''
      if (pa < pb) return -1
      if (pa > pb) return 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

export function parentRevision(
  parentId: string,
  root: RootNodeView,
  nodes: EditableNodeView[],
): string {
  if (parentId === root.id) return root.childrenRevision
  const folder = nodes.find((n) => n.id === parentId && n.kind === 'folder') as
    | FolderNodeView
    | undefined
  return folder?.childrenRevision ?? root.childrenRevision
}

export function resolveEditableNode(
  snap: EditorSnapshot,
  nodeId: string,
): EditableNodeView | null {
  if (snap.root.id === nodeId) return null
  return snap.nodes.find((n) => n.id === nodeId) ?? null
}

export function etagForDelete(snap: EditorSnapshot, node: EditableNodeView): {
  nodeEtag: string
  contentEtag: string
} {
  return { nodeEtag: node.etag, contentEtag: snap.collection.contentEtag }
}
