/**
 * Per-history-entry scroll positions, keyed by React Router's location.key.
 *
 * The in-memory map is mirrored to sessionStorage because the entry key
 * survives a full reload in history.state — a refreshed page can therefore
 * still restore its position. Entries are LRU-capped (array order in storage
 * is the LRU order). Storage failures (private mode, quota) are swallowed:
 * the memory copy keeps working for the rest of the session.
 *
 * Pure module — no React — so the eviction and persistence logic can be
 * unit-tested directly.
 */

const STORAGE_KEY = 'known.scroll.v1'
const MAX_ENTRIES = 50

let positions: Map<string, number> | null = null

function load(): Map<string, number> {
  if (positions) return positions
  positions = new Map()
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
          positions.set(entry[0], entry[1])
        }
      }
    }
  } catch {
    /* storage unavailable or a foreign payload — start empty */
  }
  return positions
}

function persist(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...load()]))
  } catch {
    /* private mode / quota exceeded — the in-memory copy still serves this session */
  }
}

export function savePosition(key: string, y: number): void {
  const map = load()
  /* delete+set re-inserts at the end, keeping iteration order == LRU order. */
  map.delete(key)
  map.set(key, y)
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  persist()
}

export function readPosition(key: string): number | undefined {
  return load().get(key)
}
