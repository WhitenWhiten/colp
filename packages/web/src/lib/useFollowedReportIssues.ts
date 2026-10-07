import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type ReportIssueTimelineItem } from '../api'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

const FOLLOW_CHANNEL = 'known.report-follow.v1'
const FOLLOW_INVALIDATION_KEY = 'known.report-follow.invalidate.v1'
const TIMELINE_PAGE_LIMIT = 20

type TimelineCache = {
  items: ReportIssueTimelineItem[]
  nextCursor: string | null
}
const TIMELINE_CACHE_KEY = 'followed-report-issues'

export type FollowedReportIssuesStatus = 'loading' | 'ready' | 'error' | 'unavailable'

/**
 * Followed-issue timeline: the newest published issues across every followed
 * report series. Backs the Library digest reading view and the Today update
 * reminder. `unavailable` mirrors the backend 404 (feature not exposed).
 *
 * Entries whose series has no public slug (e.g. a private series the reader
 * belongs to) are dropped: the timeline is a reading entry, and those
 * issues have no public page to open. Moderation tombstones are NOT dropped
 * (#21): a hide_public row keeps its slot with placeholder copy, so the
 * reader sees the slot instead of a silently shorter list.
 */
export function useFollowedReportIssues(exposed: boolean) {
  const restored = readRouteCache<TimelineCache>(TIMELINE_CACHE_KEY)
  const [items, setItems] = useState<ReportIssueTimelineItem[]>(restored?.items ?? [])
  const [nextCursor, setNextCursor] = useState<string | null>(restored?.nextCursor ?? null)
  const [status, setStatus] = useState<FollowedReportIssuesStatus>(restored ? 'ready' : 'loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const itemsRef = useRef<ReportIssueTimelineItem[]>([])
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
      const page = await productClient.getFollowedReportIssuesPage(
        { limit: TIMELINE_PAGE_LIMIT },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current) return
      const readable = page.items.filter((item) => item.state === 'hidden' || item.series.slug != null)
      setItems(readable)
      setNextCursor(page.nextCursor)
      setMoreError(false)
      setStatus('ready')
      writeRouteCache<TimelineCache>(TIMELINE_CACHE_KEY, { items: readable, nextCursor: page.nextCursor })
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
      const page = await productClient.getFollowedReportIssuesPage(
        { cursor },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current) return
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...page.items.filter((item) => (item.state === 'hidden' || item.series.slug != null) && !seen.has(item.id))]
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
