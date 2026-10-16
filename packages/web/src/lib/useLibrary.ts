import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type LibraryCollection } from '../api'
import { getSessionSnapshot, privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { subscribeLibraryInvalidation } from './libraryInvalidation'
import { readRouteCache, writeRouteCache } from './routeCache'

type LibraryState = { library: LibraryCollection | null; state: 'loading' | 'ready' | 'error'; message: string }
const EMPTY: LibraryState = { library: null, state: 'loading', message: 'Loading your library' }
const CACHE_KEY = 'account-library'

/** The account's one library. The identity fence also covers a mounted account switch. */
export function useLibrary() {
  const [identity, setIdentity] = useState(privateSessionIdentity)
  const [value, setValue] = useState<LibraryState>(() => readRouteCache<LibraryState>(CACHE_KEY) ?? EMPTY)
  const renderedIdentity = useRef(identity)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => subscribeSession(() => setIdentity(privateSessionIdentity())), [])

  const reload = useCallback(async () => {
    controller.current?.abort()
    const active = new AbortController(); controller.current = active
    const at = ++generation.current; const owner = privateSessionIdentity()
    if (!getSessionSnapshot().authenticated) { setValue({ ...EMPTY, state: 'ready', message: 'Sign in to view your library' }); return }
    try {
      const library = await productClient.getLibrary({ signal: active.signal, maxRetries: 0 })
      if (active.signal.aborted || at !== generation.current || owner !== privateSessionIdentity()) return
      const next: LibraryState = { library, state: 'ready', message: 'Your bookmark library' }
      setValue(next); writeRouteCache(CACHE_KEY, next)
    } catch (error) {
      if (active.signal.aborted || at !== generation.current || owner !== privateSessionIdentity()) return
      setValue(current => ({ ...current, state: 'error', message: isProductApiError(error) ? error.recoveryHint : "Couldn't load your library" }))
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
