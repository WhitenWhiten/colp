import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isProductApiError, productClient, type ReportSeries } from '../api'
import { isAbort } from './libraryTree'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { readRouteCache, writeRouteCache } from './routeCache'

const MINE_CHANNEL = 'known.my-reports.v1'
const MINE_INVALIDATION_KEY = 'known.my-reports.invalidate.v1'
const MINE_PAGE_LIMIT = 20

/** Route-cache entry so a desk remount paints the Mine list from the last
   visit instead of flashing a loading row. */
type MineCache = {
  items: ReportSeries[]
  nextCursor: string | null
}
const MINE_CACHE_KEY = 'my-reports'

export type MyReportsStatus = 'loading' | 'ready' | 'error' | 'unavailable'

/** Called after a create/archive anywhere in the app so other desks and tabs
   repaint the Mine list. */
export function notifyMyReportsChanged() {
  try {
    window.localStorage.setItem(MINE_INVALIDATION_KEY, String(Date.now()))
  } catch { /* storage may be unavailable — the same-tab channel below still fires */ }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(MINE_CHANNEL)
    channel.postMessage('changed')
    channel.close()
  }
}

/**
 * Report series the signed-in curator owns or collaborates on — the sidebar's
 * Mine list and the /library/digests board. `unavailable` mirrors the backend
 * 404 (feature not exposed). Mirrors useFollowedReports.
 */
export function useMyReports(exposed: boolean) {
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const restored = readRouteCache<MineCache>(MINE_CACHE_KEY)
  const [items, setItems] = useState<ReportSeries[]>(restored?.items ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(restored?.nextCursor ?? null)
  const [status, setStatus] = useState<MyReportsStatus>(restored ? 'ready' : 'loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const itemsRef = useRef<ReportSeries[]>([])
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const renderedIdentityRef = useRef(sessionIdentity)
  itemsRef.current = items

  const loadFirstPage = useCallback(async () => {
    if (!exposed) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const requestIdentity = sessionIdentity
    const requestGeneration = ++generation.current
    const keepExisting = itemsRef.current.length > 0
    if (!keepExisting) setStatus('loading')
    try {
      const page = await productClient.listMyReports(
        { limit: MINE_PAGE_LIMIT },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current
        || privateSessionIdentity() !== requestIdentity) return
      setItems(page.items)
      setNextCursor(page.nextCursor)
      setMoreError(false)
      setStatus('ready')
      writeRouteCache<MineCache>(MINE_CACHE_KEY, { items: page.items, nextCursor: page.nextCursor })
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current
        || privateSessionIdentity() !== requestIdentity || isAbort(error)) return
      if (isProductApiError(error) && (error.status === 404 || error.code === 'resource_not_found')) {
        setStatus('unavailable')
        return
      }
      if (!keepExisting) {
        setItems([])
        setNextCursor(null)
      }
      setStatus('error')
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [exposed, sessionIdentity])

  const loadMore = useCallback(async () => {
    const cursor = nextCursor
    if (!cursor || loadingMore || controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    const requestIdentity = sessionIdentity
    const requestGeneration = ++generation.current
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listMyReports(
        { cursor },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current
        || privateSessionIdentity() !== requestIdentity) return
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => !seen.has(item.id))]
      })
      setNextCursor(page.nextCursor)
      setMoreError(false)
      setStatus('ready')
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current
        || privateSessionIdentity() !== requestIdentity || isAbort(error)) return
      setMoreError(true)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (requestGeneration === generation.current) setLoadingMore(false)
    }
  }, [loadingMore, nextCursor, sessionIdentity])

  useEffect(() => {
    renderedIdentityRef.current = sessionIdentity
    const cached = readRouteCache<MineCache>(MINE_CACHE_KEY)
    setItems(cached?.items ?? [])
    setNextCursor(cached?.nextCursor ?? null)
    setStatus(cached ? 'ready' : 'loading')
    setMoreError(false)
    if (!exposed) return
    void loadFirstPage()
    const onStorage = (event: StorageEvent) => {
      if (event.key === MINE_INVALIDATION_KEY) void loadFirstPage()
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(MINE_CHANNEL)
    if (channel) channel.onmessage = () => { void loadFirstPage() }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      channel?.close()
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [exposed, loadFirstPage, sessionIdentity])

  const identityReady = renderedIdentityRef.current === sessionIdentity
  return {
    items: identityReady ? items : [],
    status: identityReady ? status : 'loading' as MyReportsStatus,
    nextCursor: identityReady ? nextCursor : null,
    loadingMore: identityReady ? loadingMore : false,
    moreError: identityReady ? moreError : false,
    loadFirstPage, loadMore,
  }
}
