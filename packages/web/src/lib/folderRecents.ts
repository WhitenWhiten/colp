/**
 * The folders this browser last filed into, newest first, per collection:
 * the folder picker's Recent group, as in the extension popup. A per-viewer
 * convenience in localStorage; an unreadable or blocked store reads as empty.
 */
const KEY_PREFIX = 'colp.folder.recent.v1:'
export const FOLDER_RECENTS_LIMIT = 5

export function readFolderRecents(collectionId: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY_PREFIX + collectionId) ?? '[]')
    if (!Array.isArray(stored)) return []
    const ids = stored.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
    return [...new Set(ids)].slice(0, FOLDER_RECENTS_LIMIT)
  } catch {
    return []
  }
}

export function pushFolderRecent(collectionId: string, folderId: string): void {
  const ids = [folderId, ...readFolderRecents(collectionId).filter((id) => id !== folderId)].slice(0, FOLDER_RECENTS_LIMIT)
  try {
    localStorage.setItem(KEY_PREFIX + collectionId, JSON.stringify(ids))
  } catch { /* Best effort: the next save records again. */ }
}
