import { parseNetscapeBookmarkHtml, type NetscapeBookmarkItem } from '@know-n/colp/sync/browser'
import { productClient, type EditableNodeView, type EditorSnapshot } from '../api'
import type { CreateNodeRequest } from '../api/types'

export const BOOKMARK_IMPORT_MAX_BYTES = 8 * 1024 * 1024

export function previewBookmarkImport(html: string) {
  const document = parseNetscapeBookmarkHtml(html)
  let folders = 0
  let bookmarks = 0
  const visit = (items: readonly NetscapeBookmarkItem[]) => {
    for (const item of items) {
      if (item.title.length > 512) throw new Error('A title exceeds 512 characters. Shorten it before importing.')
      if (item.kind === 'folder') { folders += 1; visit(item.children) }
      else {
        const url = new URL(item.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || item.url.length > 2048) {
          throw new Error('Bookmarks must have absolute HTTP or HTTPS URLs without credentials, up to 2048 characters.')
        }
        bookmarks += 1
      }
    }
  }
  visit(document.children)
  return { items: document.children, folders, bookmarks }
}

/** One attempt keeps command intents across ambiguous network failures. */
export function bookmarkImportAttempt() {
  const intents = new Map<string, string>()
  return Object.assign((path: string) => {
    let intent = intents.get(path)
    if (!intent) { intent = productClient.newCommandId(); intents.set(path, intent) }
    return intent
  }, { requests: new Map<string, CreateNodeRequest>(), completed: new Map<string, EditableNodeView>() })
}

export async function importBookmarks(options: {
  snapshot: EditorSnapshot
  parentId: string
  items: readonly NetscapeBookmarkItem[]
  skipDuplicates: boolean
  intentFor: ReturnType<typeof bookmarkImportAttempt>
  signal: AbortSignal
  onProgress: (created: number, skipped: number) => void
}, client = productClient) {
  const { snapshot, parentId, items, skipDuplicates, intentFor, signal, onProgress } = options
  const nodes = [...snapshot.nodes]
  if (parentId !== snapshot.root.id && !nodes.some(n => n.id === parentId && n.kind === 'folder')) {
    throw new Error('The destination folder no longer exists. Choose another folder.')
  }
  let created = 0
  let skipped = 0
  const visit = async (entries: readonly NetscapeBookmarkItem[], parent: string, path: string): Promise<void> => {
    const siblings = nodes.filter(n => n.parentId === parent).sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0)
    let afterId = siblings.at(-1)?.id ?? null
    for (const [index, entry] of entries.entries()) {
      signal.throwIfAborted()
      const title = entry.title.trim() || (entry.kind === 'folder' ? 'Untitled folder' : entry.url)
      const existing = skipDuplicates ? nodes.find(n => n.parentId === parent && n.kind === entry.kind
        && (entry.kind === 'bookmark' ? n.kind === 'bookmark' && n.url === entry.url : n.title === title)) : undefined
      const itemPath = `${path}/${index}`
      const completed = intentFor.completed.get(itemPath)
      let id = completed?.id ?? existing?.id
      if (completed) { created += 1 }
      else if (id) { skipped += 1 }
      else {
        if (!intentFor.requests.has(itemPath) && nodes.length + 1 >= 10_000) throw new Error('This collection has reached its 10,000-node limit. Import the remaining items into another collection.')
        const body: CreateNodeRequest = intentFor.requests.get(itemPath) ?? {
          parentId: parent, afterId, beforeId: null,
          node: entry.kind === 'folder'
            ? { kind: 'folder', title, description: null, tags: [], visibility: 'inherit' }
            : { kind: 'bookmark', title, url: entry.url, description: null, tags: [], visibility: 'inherit' },
        }
        intentFor.requests.set(itemPath, body)
        const result = await client.createCollectionNode(snapshot.collection.id, body,
          { intentId: intentFor(itemPath), rotateCommandOnConflict: false, signal })
        signal.throwIfAborted()
        id = result.node.id
        intentFor.completed.set(itemPath, result.node)
        nodes.push(result.node)
        afterId = id
        created += 1
      }
      if (!id) throw new Error('The server did not return an imported item.')
      onProgress(created, skipped)
      if (entry.kind === 'folder') await visit(entry.children, id, itemPath)
    }
  }
  await visit(items, parentId, '')
  return { created, skipped }
}
