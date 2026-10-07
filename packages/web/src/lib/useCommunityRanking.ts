import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isCommunityExposureEnabled,
  isProductApiError,
  productClient,
  type CommunityRankingItem,
  type CommunityRankingQueryParams,
} from '../api'
import { isAbort } from './libraryTree'

/**
 * CS-02 hot ranking board feed.
 *
 * Pages arrive in strict server order (hot DESC, kind ASC, id ASC) and are
 * appended verbatim — the board never re-sorts client-side. The opaque
 * cursor binds filters, so any parameter change resets pagination instead
 * of reusing a stale cursor; a snapshot_expired/invalid_cursor response
 * restarts from the first page exactly once per fetch cycle.
 */
export interface CommunityRankingBoard {
  readonly items: readonly CommunityRankingItem[]
  readonly scoreVersion: string | null
  readonly asOf: string | null
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly error: string | null
  /** true when the board endpoint is unavailable (feature off / no permission). */
  readonly unavailable: boolean
  readonly hasMore: boolean
  loadMore(): void
  reload(): void
}

function filtersKey(query: CommunityRankingQueryParams): string {
  return JSON.stringify([
    query.kind ?? null,
    query.collectionId ?? null,
    query.q ?? null,
    query.tag ?? null,
    query.language ?? null,
    query.limit ?? null,
  ])
}

function isSnapshotRestart(error: unknown): boolean {
  return isProductApiError(error)
    && (error.code === 'snapshot_expired' || error.code === 'invalid_cursor')
}

function isUnavailable(error: unknown): boolean {
  return isProductApiError(error)
    && (error.status === 404 || error.status === 403)
}

export function useCommunityRanking(
  query: CommunityRankingQueryParams,
): CommunityRankingBoard {
  const enabled = isCommunityExposureEnabled()
  const key = filtersKey(query)
  const queryRef = useRef<CommunityRankingQueryParams>(query)
  queryRef.current = query
  const [items, setItems] = useState<readonly CommunityRankingItem[]>([])
  const [meta, setMeta] = useState<{ scoreVersion: string | null; asOf: string | null }>({
    scoreVersion: null,
    asOf: null,
  })
  const [loading, setLoading] = useState(enabled)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const nextCursorRef = useRef<string | null>(null)
  const loadingMoreRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  const loadPage = useCallback(async (reset: boolean, restarted = false) => {
    setError(null)
    if (reset) {
      loadingMoreRef.current = false
      setLoadingMore(false)
      setLoading(true)
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      nextCursorRef.current = null
      setItems([])
    } else {
      if (loadingMoreRef.current || !nextCursorRef.current) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      abortRef.current = new AbortController()
    }
    const controller = abortRef.current
    const { signal } = controller
    const current = queryRef.current
    try {
      const page = await productClient.getCommunityRanking({
        ...current,
        ...(reset ? {} : { cursor: nextCursorRef.current ?? undefined }),
      }, { signal })
      if (signal.aborted) return
      nextCursorRef.current = page.nextCursor
      setMeta({ scoreVersion: page.scoreVersion, asOf: page.asOf })
      setItems((previous) => reset ? page.items : [...previous, ...page.items])
    } catch (err) {
      if (isAbort(err) || signal.aborted) return
      // A stale snapshot or invalid cursor restarts from the first page once;
      // the retry runs inside the same user-visible load cycle.
      if (!restarted && isSnapshotRestart(err)) {
        await loadPage(true, true)
        return
      }
      if (isUnavailable(err)) {
        setUnavailable(true)
        setItems([])
        nextCursorRef.current = null
      } else {
        setError('Check your connection and try again.')
      }
    } finally {
      if (!reset) {
        if (abortRef.current === controller) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      } else if (!signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setItems([])
      setUnavailable(false)
      return
    }
    // Filter/board change: discard the bound cursor and restart pagination.
    nextCursorRef.current = null
    setUnavailable(false)
    void loadPage(true)
    return () => {
      abortRef.current?.abort()
    }
  }, [enabled, key, loadPage])

  return {
    items,
    scoreVersion: meta.scoreVersion,
    asOf: meta.asOf,
    loading,
    loadingMore,
    error,
    unavailable,
    hasMore: nextCursorRef.current !== null,
    loadMore: useCallback(() => { void loadPage(false) }, [loadPage]),
    reload: useCallback(() => { void loadPage(true) }, [loadPage]),
  }
}
