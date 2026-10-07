import type { EditorSnapshot } from '../../api'
type Node = EditorSnapshot['nodes'][number]
/** Keep deep/repeated folder names distinguishable without unbounded ancestry rendering. */
export function classificationFolderLabel(nodes: ReadonlyMap<string, Node>, id: string): string {
  const path: string[] = [], seen = new Set<string>()
  let current: string | null = id
  while (current && !seen.has(current) && path.length < 16) {
    seen.add(current)
    const node = nodes.get(current)
    if (!node || node.kind !== 'folder') break
    const title = node.title || 'Untitled folder'
    path.unshift(title.length > 120 ? `${title.slice(0, 80)}…${title.slice(-39)}` : title)
    current = node.parentId
  }
  if (current && path.length === 16) path.unshift('…')
  return path.join(' / ') || 'Folder no longer available'
}
