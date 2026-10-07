import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { classifyRouteError, type RouteFailureKind } from './classifyRouteError'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

export type RouteDataStatus = 'loading' | 'ready' | RouteFailureKind

type ReloadOptions = { silent?: boolean }

type Options<T> = {
  cacheKey: string
  enabled?: boolean
  load: (signal: AbortSignal) => Promise<T>
  fallbackError?: string
}

/**
 * Shared loader for pages that paint RouteState from one GET.
 *
 * First paint reads `routeCache` so a round trip does not replay the skeleton.
 * A later failure keeps cached rows only when the caller asked for a silent
 * refresh (Export polling); a visible reload still classifies 401 / 404 /
 * other errors onto RouteState.
 */
export function useRouteData<T>({
  cacheKey,
  enabled = true,
  load,
  fallbackError = "Couldn't load this page. Try again.",
}: Options<T>) {
  const identityVersion = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const restored = enabled ? readRouteCache<T>(cacheKey) : undefined
  const [data, setDataState] = useState<T | undefined>(restored)
  const [status, setStatus] = useState<RouteDataStatus>(
    !enabled ? 'unavailable' : restored !== undefined ? 'ready' : 'loading',
  )
  const [error, setError] = useState<string | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const setData = useCallback((next: T) => {
    if (identityVersion !== privateSessionIdentity()) return
    dataRef.current = next
    setDataState(next)
    writeRouteCache(cacheKey, next)
  }, [cacheKey, identityVersion])

  const reload = useCallback(async (opts?: ReloadOptions) => {
    if (!enabled) {
      setStatus('unavailable')
      setError(null)
      return
    }
    controllerRef.current?.abort()
    const identity = identityVersion
    if (identity !== privateSessionIdentity()) return
    const controller = new AbortController()
    controllerRef.current = controller
    const requestGeneration = ++generation.current
    const cached = readRouteCache<T>(cacheKey)
    if (cached !== undefined && dataRef.current === undefined) {
      dataRef.current = cached
      setDataState(cached)
      setStatus('ready')
    }
    const silent = opts?.silent === true
    if (!silent && dataRef.current === undefined) {
      setStatus('loading')
      setError(null)
    }
    try {
      const next = await loadRef.current(controller.signal)
      if (controller.signal.aborted || requestGeneration !== generation.current || identity !== privateSessionIdentity()) return
      dataRef.current = next
      setDataState(next)
      writeRouteCache(cacheKey, next, identity)
      setStatus('ready')
      setError(null)
    } catch (err) {
      if (controller.signal.aborted || requestGeneration !== generation.current || identity !== privateSessionIdentity()) return
      if (isAbort(err)) {
        if (dataRef.current === undefined) setStatus('ready')
        return
      }
      const kind = classifyRouteError(err)
      if (silent && kind === 'error') { setError('Offline or unavailable · showing previously loaded data.'); return }
      dataRef.current = undefined
      setDataState(undefined)
      setStatus(kind)
      setError(kind === 'error' ? fallbackError : null)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [cacheKey, enabled, fallbackError, identityVersion])

  useEffect(() => {
    let identity = privateSessionIdentity()
    const unsubscribe = subscribeSession(() => {
      if (identity === privateSessionIdentity()) return
      identity = privateSessionIdentity(); generation.current++; controllerRef.current?.abort()
      dataRef.current = undefined; setDataState(undefined); setStatus('unavailable'); setError(null)
    })
    dataRef.current = readRouteCache<T>(cacheKey); setDataState(dataRef.current)
    void reload()
    return () => {
      unsubscribe()
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [reload, cacheKey])

  return { data, status, error, reload, setData }
}
