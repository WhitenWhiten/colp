/**
 * Module-scoped read cache for page data that has to survive a route change.
 *
 * Every route here is a separate route element, so React Router unmounts the
 * page component on any navigation away from it — the `<main key={pageKey}>`
 * swap in Layout is not what causes this and narrowing it changes nothing
 * (measured: a cross-route round trip mounts the page twice with or without
 * the key). With all page state in `useState`, coming back therefore replays
 * the entire first load — skeleton, spinner, enter transition — for data that
 * was on screen a second earlier. Holding it outside React is the only lever.
 *
 * Read the cache to paint the first frame, then revalidate behind it: never
 * empty what is already rendered and never re-enter the loading state when
 * there is content to show. A failed revalidation keeps the stale rows.
 *
 * Entries are dropped whenever the private session identity changes, so one
 * account can never read rows cached for another. Public, non-account data
 * (published collections, search) is keyed by its own identifier instead.
 */
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'

/**
 * The identity is stamped per entry rather than tracked for the map as a whole:
 * a request that started before a session change can still resolve after it, and
 * stamping the writer means such a write can never be read back by the new
 * account even if the call site forgets to fence it.
 */
const entries = new Map<string, { identity: string; value: unknown }>()

subscribeSession(() => {
  const next = privateSessionIdentity()
  for (const [key, entry] of entries) {
    if (entry.identity !== next) entries.delete(key)
  }
})

export function readRouteCache<T>(key: string): T | undefined {
  const entry = entries.get(key)
  if (entry === undefined || entry.identity !== privateSessionIdentity()) return undefined
  return entry.value as T
}

export function writeRouteCache<T>(key: string, value: T, identity = privateSessionIdentity()): void {
  if (identity !== privateSessionIdentity()) return
  entries.set(key, { identity, value })
}

/** Test helper: drop every cached entry without touching the session store. */
export function clearRouteCache(): void {
  entries.clear()
}
