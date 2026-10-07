import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEATURE_FLAGS, getExploreCollections, isReportsExposureEnabled } from '../api'
import type { PublicReportSeries } from '../api/types'
import type { ExploreCard } from './mapExploreItem'
import { mapExploreItem } from './mapExploreItem'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'
import { usePublicReports } from './usePublicReports'

const DIGEST_GRACE_MS = 400

export type ExploreFeedSort = 'updated' | 'popular' | 'links'

/** One merged row of the Explore board: a public collection, a reading path,
 *  or a digest series. `sortKey` orders the loaded window only (an updated
 *  time, a follower/view count, or an entry/issue count). Those fields do
 *  not share one backend comparator, and the two cursors are not one ranking. */
export type ExploreFeedItem =
  | { kind: 'collection' | 'path'; sortKey: number; payload: ExploreCard }
  | { kind: 'digest'; sortKey: number; payload: PublicReportSeries }

type CachedBoard = { items: ExploreCard[]; cursor: string | null }

/** One entry per board: the tag and sort together decide what is on screen. */
function cacheKey(sort: ExploreFeedSort, tag: string, language = '') {
  return `explore:${sort}:${tag}:${language}`
}

/** Flag-off only. Dynamic so neither the entry nor the live Explore chunk
 *  carries the demo seed. */
async function mockExploreCards(): Promise<ExploreCard[]> {
  const { mockCollections, mockCollectionExtras } = await import('../api/mock-data')
  return mockCollections.flatMap((collection) => {
    // Every seeded collection has extras by construction; skip rather than
    // fabricate a card if the seed ever drifts.
    const extras = mockCollectionExtras[collection.id]
    if (!extras) return []
    return [{
      id: collection.id,
      title: collection.title,
      description: collection.summary ?? '',
      updatedAt: collection.updatedAt,
      ...extras,
    }]
  })
}

function collectionSortKey(sort: ExploreFeedSort, card: ExploreCard): number {
  if (sort === 'updated') return Date.parse(card.updatedAt) || 0
  if (sort === 'popular') return card.followers ?? card.viewCount ?? 0
  return card.links ?? 0
}

function digestSortKey(sort: ExploreFeedSort, series: PublicReportSeries): number {
  if (sort === 'updated') return Date.parse(series.issues[0]?.publishedAt ?? series.updatedAt) || 0
  if (sort === 'popular') return series.followerCount ?? 0
  return series.issues.length
}

/* U-26: freeze the prefix already shown, merge new rows only onto the tail,
   and de-dupe by kind + id. A new sort, tag, language, or explicit refresh
   may reorder that loaded window. The reorder is not a strict global order —
   collections and digests stay separately paged, and followers/views or
   issues/links do not share one backend comparator. Each source keeps its
   own in-flight gate; one click may advance both. */

function feedItemKey(item: ExploreFeedItem): string {
  return `${item.kind}:${item.payload.id}`
}

function sourceKey(card: ExploreCard): string {
  return `${card.kind === 'reading_path' ? 'path' : 'collection'}:${card.id}`
}

function dedupeCards(existing: readonly ExploreCard[], incoming: readonly ExploreCard[]): ExploreCard[] {
  const seen = new Set(existing.map(sourceKey))
  const next = existing.slice()
  for (const card of incoming) {
    const key = sourceKey(card)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(card)
  }
  return next
}

function sameKeys(left: readonly string[] | null, right: readonly string[]): boolean {
  if (left === null || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Local display order of whatever is already loaded. Not a global ranking. */
function orderLoadedWindow(items: readonly ExploreFeedItem[]): ExploreFeedItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => right.item.sortKey - left.item.sortKey || left.index - right.index)
    .map(({ item }) => item)
}

function mergeTail(frozenKeys: readonly string[], incoming: readonly ExploreFeedItem[]): ExploreFeedItem[] {
  const byKey = new Map(incoming.map((item) => [feedItemKey(item), item]))
  const used = new Set<string>()
  const prefix: ExploreFeedItem[] = []
  for (const key of frozenKeys) {
    const item = byKey.get(key)
    if (!item || used.has(key)) continue
    used.add(key)
    prefix.push(item)
  }
  const tail: ExploreFeedItem[] = []
  for (const item of incoming) {
    const key = feedItemKey(item)
    if (used.has(key)) continue
    used.add(key)
    tail.push(item)
  }
  return [...prefix, ...orderLoadedWindow(tail)]
}

/**
 * The Explore board as one feed: the cursor-paginated public collections
 * stream merged with the public report directory. Both sources keep their
 * own cursor; "Load more" advances both (a dry source just stops paging)
 * and does not move a card already shown. Digests carry no topic tags, so
 * a topic filter drops them from the merge and the reports gate decides
 * whether they appear at all.
 */
export function useExploreFeed({ sort, tag, language, includeDigests }: {
  sort: ExploreFeedSort
  /** Server-side topic filter — the real chip value, so kind switches do not refetch. */
  tag: string
  language?: string
  /** Digests carry no topics: the caller passes true for 'All' or a digest-only view. */
  includeDigests: boolean
}) {
  const restored = FEATURE_FLAGS.explore ? readRouteCache<CachedBoard>(cacheKey(sort, tag, language ?? '')) : undefined
  const [collections, setCollections] = useState<ExploreCard[]>(() => restored?.items ?? [])
  const [loading, setLoading] = useState<boolean>(FEATURE_FLAGS.explore && restored === undefined)
  const [error, setError] = useState<string | null>(null)
  const nextCursorRef = useRef<string | null>(restored?.cursor ?? null)
  const itemsRef = useRef<ExploreCard[]>(restored?.items ?? [])
  const paintedKeyRef = useRef<string | null>(restored ? cacheKey(sort, tag, language ?? '') : null)
  const abortRef = useRef<AbortController | null>(null)
  const restoredOnMountRef = useRef(restored !== undefined)
  const loadingMoreRef = useRef(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const boardKey = cacheKey(sort, tag, language ?? '')
  const [orderBoard, setOrderBoard] = useState(boardKey)
  const [frozenKeys, setFrozenKeys] = useState<readonly string[] | null>(null)

  const reportsExposed = isReportsExposureEnabled()
  const reports = usePublicReports(reportsExposed, language)
  // A failed revalidation keeps rows already on screen. An empty error or a
  // disabled directory still hides digests; it does not drop a shown prefix.
  const digestsAvailable = reportsExposed
    && reports.status !== 'unavailable'
    && (reports.status !== 'error' || reports.items.length > 0)

  const replace = useCallback((next: ExploreCard[]) => {
    itemsRef.current = next
    setCollections(next)
  }, [])

  const loadPage = useCallback(async (reset: boolean) => {
    setError(null)
    // A reset that already has the right board on screen is a revalidation:
    // keep the cards so a round trip through a collection does not wipe the
    // grid. Changing the tag or sort is a different board, so it does clear.
    const revalidating = reset && itemsRef.current.length > 0
      && cacheKey(sort, tag, language ?? '') === paintedKeyRef.current
    if (reset) {
      loadingMoreRef.current = false
      setLoadingMore(false)
      if (!revalidating) {
        setLoading(true)
        replace([])
      }
      abortRef.current?.abort()
      abortRef.current = new AbortController()
    } else {
      if (loadingMoreRef.current || !nextCursorRef.current) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      abortRef.current = new AbortController()
    }
    const controller = abortRef.current
    const { signal } = controller
    try {
      const page = await getExploreCollections({
        limit: 24,
        sort,
        ...(tag === 'All' ? {} : { tag }),
        ...(language ? { language } : {}),
        ...(reset ? {} : { cursor: nextCursorRef.current ?? undefined }),
      }, { signal })
      if (signal.aborted) return
      nextCursorRef.current = page.nextCursor
      const mapped = page.items.map(mapExploreItem)
      // Replacing the collection window (first page, board change, refresh)
      // may reorder. Appending a page must not.
      if (reset) setFrozenKeys(null)
      replace(reset ? dedupeCards([], mapped) : dedupeCards(itemsRef.current, mapped))
      paintedKeyRef.current = cacheKey(sort, tag, language ?? '')
      writeRouteCache<CachedBoard>(paintedKeyRef.current, {
        items: itemsRef.current, cursor: nextCursorRef.current,
      })
    } catch (err) {
      if (isAbort(err) || signal.aborted) return
      // A failed revalidation keeps the board already on screen.
      if (!revalidating) setError("Couldn't load collections")
    } finally {
      if (!reset) {
        if (abortRef.current === controller) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      } else if (!signal.aborted) setLoading(false)
    }
  }, [tag, language, replace, sort])

  useEffect(() => {
    if (!FEATURE_FLAGS.explore) {
      let cancelled = false
      void mockExploreCards().then((cards) => {
        if (!cancelled) replace(cards)
      })
      return () => {
        cancelled = true
      }
    }
    nextCursorRef.current = null
    void loadPage(true)
    return () => {
      abortRef.current?.abort()
    }
  }, [loadPage, replace])

  const incoming = useMemo<ExploreFeedItem[]>(() => {
    const merged: ExploreFeedItem[] = []
    const seen = new Set<string>()
    const push = (item: ExploreFeedItem) => {
      const key = feedItemKey(item)
      if (seen.has(key)) return
      seen.add(key)
      merged.push(item)
    }
    for (const card of collections) {
      push({
        kind: card.kind === 'reading_path' ? 'path' : 'collection',
        sortKey: collectionSortKey(sort, card),
        payload: card,
      })
    }
    if (digestsAvailable && includeDigests) {
      for (const series of reports.items) {
        push({ kind: 'digest', sortKey: digestSortKey(sort, series), payload: series })
      }
    }
    return merged
  }, [collections, digestsAvailable, includeDigests, reports.items, sort])

  /* R15-14: hold the first paint until both sources settle, but never more
     than DIGEST_GRACE_MS after the collections arrive, so the first window
     is ordered once. A row that arrives after that window is shown appends. */
  const waitingForDigests = digestsAvailable && includeDigests && reports.status === 'loading'
  const [digestGraceOver, setDigestGraceOver] = useState(false)
  useEffect(() => {
    if (loading || !waitingForDigests) {
      setDigestGraceOver(false)
      return
    }
    const timer = setTimeout(() => setDigestGraceOver(true), DIGEST_GRACE_MS)
    return () => clearTimeout(timer)
  }, [loading, waitingForDigests])
  // A board restored from the route cache is already on screen: no hold.
  const holdForDigests = !loading && waitingForDigests && !digestGraceOver && !restoredOnMountRef.current

  const boardChanged = orderBoard !== boardKey
  if (boardChanged) {
    setOrderBoard(boardKey)
    setFrozenKeys(null)
  }
  const keysForOrder = boardChanged ? null : frozenKeys
  const ordered = holdForDigests || keysForOrder === null
    ? orderLoadedWindow(incoming)
    : mergeTail(keysForOrder, incoming)
  if (!boardChanged && !holdForDigests && ordered.length > 0) {
    const nextKeys = ordered.map(feedItemKey)
    if (!sameKeys(frozenKeys, nextKeys)) setFrozenKeys(nextKeys)
  }
  const shown = holdForDigests ? [] : ordered

  const hasMore = FEATURE_FLAGS.explore
    && (Boolean(nextCursorRef.current) || (digestsAvailable && Boolean(reports.nextCursor)))

  /* One click advances each live cursor. That is two sources, not a second
     copy of one page; loadPage and the reports directory each ignore an
     in-flight repeat. */
  const loadMore = useCallback(() => {
    void loadPage(false)
    if (digestsAvailable && reports.nextCursor) reports.loadMore()
  }, [digestsAvailable, loadPage, reports])

  return {
    items: shown,
    digestsAvailable,
    loading: loading || holdForDigests,
    loadingMore: loadingMore || reports.loadingMore,
    error,
    hasMore,
    loadMore,
    reload: useCallback(() => void loadPage(true), [loadPage]),
  }
}
