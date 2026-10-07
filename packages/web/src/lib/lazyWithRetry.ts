import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * R15-19: React caches a rejected `lazy()` import, so one dropped chunk
 * request used to break the route until a manual reload. The import is
 * retried twice; if it still fails, the page reloads once per chunk
 * (a sessionStorage flag stops a reload loop) and otherwise the error
 * reaches the route boundary, which offers "Reload page".
 */

const RETRY_DELAYS_MS = [300, 1_000] as const
const RELOAD_FLAG_PREFIX = 'known.chunk-reload:'

const CHUNK_ERROR_PATTERN =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/iu

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ChunkLoadError' || CHUNK_ERROR_PATTERN.test(error.message)
}

function readFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(RELOAD_FLAG_PREFIX + key) !== null
  } catch {
    return true
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.sessionStorage.setItem(RELOAD_FLAG_PREFIX + key, '1')
    else window.sessionStorage.removeItem(RELOAD_FLAG_PREFIX + key)
  } catch {
    // Without storage there is no loop guard, so reloadOnce() never reloads.
  }
}

/**
 * Reloads the page unless this key already caused a reload in this tab.
 * Returns whether a reload was started. Storage failures count as "already
 * reloaded" so an unguarded reload loop cannot happen.
 */
export function reloadOnce(key: string, reload: () => void = () => window.location.reload()): boolean {
  if (readFlag(key)) return false
  writeFlag(key, true)
  if (!readFlag(key)) return false
  reload()
  return true
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type RetryOptions = {
  sleep?: (ms: number) => Promise<void>
  reload?: () => void
}

export async function importWithRetry<T>(key: string, load: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const sleep = options.sleep ?? wait
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!)
    try {
      const module = await load()
      writeFlag(key, false)
      return module
    } catch (error) {
      lastError = error
    }
  }
  if (reloadOnce(key, options.reload)) {
    // Keep Suspense showing its fallback while the page reloads.
    return new Promise<T>(() => {})
  }
  throw lastError
}

/** `lazy()` with import retry and a one-shot reload. `key` names the chunk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React's own lazy() bound
export function lazyWithRetry<C extends ComponentType<any>>(key: string, load: () => Promise<C>): LazyExoticComponent<C> {
  return lazy(async () => ({ default: await importWithRetry(key, load) }))
}
