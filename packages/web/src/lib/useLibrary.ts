import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type LibraryCollection } from '../api'
import { getSessionSnapshot, privateSessionIdentity, subscribeSession, verifiedSessionAccountId } from '../api/sessionStore'
import { subscribeLibraryInvalidation } from './libraryInvalidation'
import { deleteRouteCache, readRouteCache, writeRouteCache } from './routeCache'

type LibraryState = { library: LibraryCollection | null; state: 'loading' | 'ready' | 'error'; message: string }
const EMPTY: LibraryState = { library: null, state: 'loading', message: 'Loading your library' }
const CACHE_KEY = 'account-library'
// /me hydrates after /session without changing the session epoch. It also
// unlocks the persisted read cache, whose account must first be verified.
const cacheIdentity = () => `${privateSessionIdentity()}:${verifiedSessionAccountId() ?? ''}`

/** The library id this page already knows, without asking the server (null until a page loaded it). */
export function knownLibraryId(): string | null {
  return readRouteCache<LibraryState>(CACHE_KEY)?.library?.id ?? null
}

/** The account's one library. The identity fence also covers a mounted account switch. */
export function useLibrary() {
  const [identity, setIdentity] = useState(cacheIdentity)
  const [value, setValue] = useState<LibraryState>(() => readRouteCache<LibraryState>(CACHE_KEY) ?? EMPTY)
  const renderedIdentity = useRef(identity)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => subscribeSession(() => setIdentity(cacheIdentity())), [])

  const reload = useCallback(async () => {
    controller.current?.abort()
    const active = new AbortController(); controller.current = active
    const at = ++generation.current; const owner = privateSessionIdentity()
    if (!getSessionSnapshot().authenticated) { setValue({ ...EMPTY, state: 'ready', message: 'Sign in to view your library' }); return }
    if (!verifiedSessionAccountId()) return
    try {
      const library = await productClient.getLibrary({ signal: active.signal, maxRetries: 0 })
      if (active.signal.aborted || at !== generation.current || owner !== privateSessionIdentity()) return
      const next: LibraryState = { library, state: 'ready', message: 'Your bookmark library' }
      setValue(next); writeRouteCache(CACHE_KEY, next)
    } catch (error) {
      if (active.signal.aborted || at !== generation.current || owner !== privateSessionIdentity()) return
      const denied = isProductApiError(error) && [401, 403, 404].includes(error.status)
      if (denied) { deleteRouteCache(CACHE_KEY); deleteRouteCache('library-desk') }
      setValue(current => ({ ...current, ...(denied ? { library: null } : {}), state: 'error', message: isProductApiError(error) ? error.recoveryHint : "Couldn't load your library" }))
    }
  }, [])
  useEffect(() => {
    renderedIdentity.current = identity
    setValue(readRouteCache<LibraryState>(CACHE_KEY) ?? EMPTY)
    void reload()
    return () => { controller.current?.abort(); generation.current += 1 }
  }, [identity, reload])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeLibraryInvalidation(() => { clearTimeout(timer); timer = setTimeout(() => void reload(), 300) })
    return () => { clearTimeout(timer); unsubscribe() }
  }, [reload])
  return { ...(renderedIdentity.current === identity ? value : EMPTY), reload }
}
