import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type PublicReportSeries } from '../api'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

const DIRECTORY_PAGE_LIMIT = 24

function directoryCacheKey(language?: string) {
  return `reports:public-directory:${language ?? ''}`
}

type DirectoryCache = {
  items: PublicReportSeries[]
  nextCursor: string | null
}

export type PublicReportsStatus = 'loading' | 'ready' | 'error' | 'unavailable'

/**
 * Public report directory for the Explore rail and the /reports index.
 * The route cache paints the first frame on a remount; revalidation happens
 * behind the rendered rows. `unavailable` mirrors the backend 404 while the
 * KNOWN_FEATURE_REPORTS_PUBLIC gate is off.
 */
export function usePublicReports(exposed: boolean, language?: string) {
  const restored = readRouteCache<DirectoryCache>(directoryCacheKey(language))
  const [items, setItems] = useState<PublicReportSeries[]>(restored?.items ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(restored?.nextCursor ?? null)
  const [status, setStatus] = useState<PublicReportsStatus>(restored ? 'ready' : 'loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const itemsRef = useRef<PublicReportSeries[]>([])
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
      const page = await productClient.getPublicReportsPage(
        { limit: DIRECTORY_PAGE_LIMIT, ...(language ? { language } : {}) },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current) return
      setItems(page.items)
      setNextCursor(page.nextCursor)
      setMoreError(false)
      setStatus('ready')
      writeRouteCache<DirectoryCache>(directoryCacheKey(language), { items: page.items, nextCursor: page.nextCursor })
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
  }, [exposed, language])

  /* Series-id de-dupe and this in-flight gate stay. Explore applies kind + id
     on top of them and does not treat this cursor as one sort with collections. */
  const loadMore = useCallback(async () => {
    const cursor = nextCursor
    if (!cursor || loadingMore || controllerRef.current) return
    const controller = new AbortController()
    controllerRef.current = controller
    const requestGeneration = ++generation.current
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await productClient.getPublicReportsPage(
        { cursor, ...(language ? { language } : {}) },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current) return
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => !seen.has(item.id))]
      })
      setNextCursor(page.nextCursor)
      setStatus('ready')
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || isAbort(error)) return
      setMoreError(true)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (requestGeneration === generation.current) setLoadingMore(false)
    }
  }, [loadingMore, nextCursor, language])

  useEffect(() => {
    if (!exposed) return
    void loadFirstPage()
    return () => {
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [exposed, loadFirstPage])

  return { items, nextCursor, status, loadingMore, moreError, loadFirstPage, loadMore }
}
