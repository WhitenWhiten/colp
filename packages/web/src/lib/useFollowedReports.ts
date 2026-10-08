import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type ReportSeries } from '../api'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

const FOLLOW_CHANNEL = 'known.report-follow.v1'
const FOLLOW_INVALIDATION_KEY = 'known.report-follow.invalidate.v1'
const FOLLOWED_PAGE_LIMIT = 20

/** Route-cache entry so a desk remount paints the Digests section from the
   last visit instead of flashing a loading row. */
type FollowedCache = {
  items: ReportSeries[]
  nextCursor: string | null
}
const FOLLOWED_CACHE_KEY = 'followed-reports'

export type FollowedReportsStatus = 'loading' | 'ready' | 'error' | 'unavailable'

/**
 * Followed report series for the Library sidebar Digests section.
 * Follow/unfollow events in this or another tab arrive through the
 * report-follow broadcast channel and reload the first page without clearing
 * the rows already rendered. `unavailable` mirrors the backend 404 (feature
 * not exposed).
 */
export function useFollowedReports(exposed: boolean) {
  const restored = readRouteCache<FollowedCache>(FOLLOWED_CACHE_KEY)
  const [items, setItems] = useState<ReportSeries[]>(restored?.items ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(restored?.nextCursor ?? null)
  const [status, setStatus] = useState<FollowedReportsStatus>(restored ? 'ready' : 'loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const itemsRef = useRef<ReportSeries[]>([])
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  itemsRef.current = items

  const loadFirstPage = useCallback(async () => {
    if (!exposed) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const requestGeneration = ++generation.current
    const keepExisting = itemsRef.current.length > 0
    if (!keepExisting) setStatus('loading')
    try {
      const page = await productClient.listFollowedReports(
        { limit: FOLLOWED_PAGE_LIMIT },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current) return
      setItems(page.items)
      setNextCursor(page.nextCursor)
      setMoreError(false)
      setStatus('ready')
      writeRouteCache<FollowedCache>(FOLLOWED_CACHE_KEY, { items: page.items, nextCursor: page.nextCursor })
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || isAbort(error)) return
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
  }, [exposed])

  const loadMore = useCallback(async () => {
    const cursor = nextCursor
    if (!cursor || loadingMore || controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    const requestGeneration = ++generation.current
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.listFollowedReports(
        { cursor },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current) return
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => !seen.has(item.id))]
      })
      setNextCursor(page.nextCursor)
      setMoreError(false)
      setStatus('ready')
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || isAbort(error)) return
      setMoreError(true)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (requestGeneration === generation.current) setLoadingMore(false)
    }
  }, [loadingMore, nextCursor])

  useEffect(() => {
    if (!exposed) return
    void loadFirstPage()
    const onStorage = (event: StorageEvent) => {
      if (event.key === FOLLOW_INVALIDATION_KEY) void loadFirstPage()
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(FOLLOW_CHANNEL)
    if (channel) channel.onmessage = () => { void loadFirstPage() }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      channel?.close()
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [exposed, loadFirstPage])

  return { items, nextCursor, status, loadingMore, moreError, loadFirstPage, loadMore }
}
