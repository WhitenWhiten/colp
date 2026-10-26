/** Only Library read models survive a page reload. Session and CSRF data never enter this store. */
import { privateSessionIdentity, subscribeSession, verifiedSessionAccountId } from '../api/sessionStore'

const KEYS = new Set(['account-library', 'library-desk'])
const PREFIX = 'known.library.read-cache.v1:'
// Leave room for other preferences in the browser's localStorage quota.
const MAX_LENGTH = 2_000_000
const pending = new Map<string, { identity: string; value: unknown }>()
let timer: ReturnType<typeof setTimeout> | undefined

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Reject old/incomplete read models instead of handing a broken tree to the desk. */
function usable(key: string, value: unknown): boolean {
  if (!record(value)) return false
  if (key === 'account-library') {
    return value.state === 'ready' && record(value.library) && typeof value.library.id === 'string'
      && typeof value.library.rootNodeId === 'string' && value.library.library === true
  }
  if (!record(value.snaps) || !strings(value.expanded)
    || (value.collapsedSections !== undefined && !strings(value.collapsedSections))
    || (value.userCollapsed !== undefined && !strings(value.userCollapsed))) return false
  return Object.entries(value.snaps).every(([id, snap]) => record(snap) && record(snap.collection)
    && snap.collection.id === id && record(snap.root) && typeof snap.root.id === 'string'
    && record(snap.capabilities) && record(snap.page) && snap.page.hasMore === false
    && Array.isArray(snap.nodes) && snap.nodes.every(node => record(node)
      && typeof node.id === 'string' && typeof node.title === 'string'
      && (node.kind === 'bookmark' || node.kind === 'folder')))
}

export function readPersistentRouteCache<T>(key: string): T | undefined {
  const owner = verifiedSessionAccountId()
  if (!KEYS.has(key) || !owner) return undefined
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (!raw) return undefined
    const entry: unknown = JSON.parse(raw)
    if (record(entry) && entry.accountId === owner && usable(key, entry.value)) {
      return entry.value as T
    }
    window.localStorage.removeItem(PREFIX + key)
  } catch { /* Unavailable, full or corrupt storage falls back to a normal load. */ }
  return undefined
}

function flush(): void {
  clearTimeout(timer)
  timer = undefined
  const owner = verifiedSessionAccountId()
  for (const [key, entry] of pending) {
    pending.delete(key)
    if (!owner || entry.identity !== privateSessionIdentity()) continue
    try {
      const raw = JSON.stringify({ accountId: owner, savedAt: Date.now(), value: entry.value })
      if (raw.length <= MAX_LENGTH) window.localStorage.setItem(PREFIX + key, raw)
      else window.localStorage.removeItem(PREFIX + key)
    } catch { /* Persistence is optional; the in-memory cache remains usable. */ }
  }
}

export function writePersistentRouteCache(key: string, value: unknown, identity: string): void {
  if (!KEYS.has(key) || !verifiedSessionAccountId()) return
  pending.set(key, { identity, value })
  clearTimeout(timer)
  // Coalesce tree/UI updates and keep serialization out of the first paint.
  timer = setTimeout(flush, 200)
}

export function deletePersistentRouteCache(key: string): void {
  if (!KEYS.has(key)) return
  pending.delete(key)
  try { window.localStorage.removeItem(PREFIX + key) } catch { /* optional storage */ }
}

let previousAccount = verifiedSessionAccountId()
subscribeSession(snapshot => {
  const next = verifiedSessionAccountId()
  if (!snapshot.authenticated || (previousAccount && next && previousAccount !== next)) {
    for (const key of KEYS) deletePersistentRouteCache(key)
  }
  previousAccount = snapshot.authenticated ? next ?? previousAccount : undefined
})

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}
