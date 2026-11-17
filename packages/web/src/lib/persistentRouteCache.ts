/** Only Library read models survive a page reload. Session and CSRF data never enter this store. */
import { privateSessionIdentity, subscribeSession, verifiedSessionAccountId } from '../api/sessionStore'

const KEYS = new Set(['account-library', 'library-desk'])
const PREFIX = 'known.library.read-cache.v1:'
// Leave room for other preferences in the browser's localStorage quota.
const MAX_LENGTH = 2_000_000
/** Rough serialized size of one desk node; used to skip hopeless payloads cheaply. */
const DESK_NODE_BYTES = 512
const DESK_NODE_OVERHEAD_BYTES = 64
const DESK_BASE_BYTES = 4_096
const DESK_LIST_ITEM_BYTES = 64
const pending = new Map<string, { identity: string; value: unknown }>()
/** Last envelope written per key, so an unchanged read model is not stringified again. */
const lastWritten = new Map<string, { value: unknown; identity: string; accountId: string; raw: string | null }>()
let timer: ReturnType<typeof setTimeout> | undefined

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * A conservative estimate for the one large persisted model, without
 * `JSON.stringify`: a typical node is at least 512 serialized bytes, but a
 * long description or title must count too, or a few-hundred-node desk with
 * long text would still be encoded in full before the exact check. A
 * below-threshold estimate still gets that exact length check.
 */
function estimateNodeBytes(node: Record<string, unknown>): number {
  let chars = 0
  for (const value of Object.values(node)) {
    if (typeof value === 'string') chars += value.length
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') chars += item.length
    }
  }
  return Math.max(DESK_NODE_BYTES, chars + DESK_NODE_OVERHEAD_BYTES)
}

function estimateBytes(key: string, value: unknown): number {
  if (key !== 'library-desk' || !record(value)) return 0
  let bytes = DESK_BASE_BYTES
  if (record(value.snaps)) {
    for (const snap of Object.values(value.snaps)) {
      if (!record(snap)) continue
      if (Array.isArray(snap.nodes)) {
        for (const node of snap.nodes) {
          bytes += record(node) ? estimateNodeBytes(node) : DESK_NODE_BYTES
        }
      }
      if (record(snap.collection)) bytes += DESK_NODE_BYTES
      if (record(snap.root)) bytes += DESK_NODE_BYTES
    }
  }
  for (const list of [value.expanded, value.collapsedSections, value.userCollapsed]) {
    if (Array.isArray(list)) bytes += list.length * DESK_LIST_ITEM_BYTES
  }
  return bytes
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
  const identity = privateSessionIdentity()
  for (const [key, entry] of pending) {
    pending.delete(key)
    if (!owner || entry.identity !== identity) continue
    const cached = lastWritten.get(key)
    if (cached && cached.value === entry.value && cached.identity === entry.identity && cached.accountId === owner) {
      try {
        // Same read model for the same identity: reuse the serialized envelope.
        if (cached.raw === null) window.localStorage.removeItem(PREFIX + key)
        else window.localStorage.setItem(PREFIX + key, cached.raw)
      } catch { /* Persistence is optional. */ }
      continue
    }
    if (estimateBytes(key, entry.value) > MAX_LENGTH) {
      // Too large to fit before we even encode it: do not stringify multi-MB.
      lastWritten.set(key, { value: entry.value, identity: entry.identity, accountId: owner, raw: null })
      try { window.localStorage.removeItem(PREFIX + key) } catch { /* optional storage */ }
      continue
    }
    try {
      const raw = JSON.stringify({ accountId: owner, savedAt: Date.now(), value: entry.value })
      if (raw.length <= MAX_LENGTH) {
        window.localStorage.setItem(PREFIX + key, raw)
        lastWritten.set(key, { value: entry.value, identity: entry.identity, accountId: owner, raw })
      } else {
        lastWritten.set(key, { value: entry.value, identity: entry.identity, accountId: owner, raw: null })
        window.localStorage.removeItem(PREFIX + key)
      }
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
  lastWritten.delete(key)
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
