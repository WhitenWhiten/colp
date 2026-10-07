import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { annotationKindTitle, searchKindLabel } from './searchCopy'
import { isLive, productClient } from '../api'
import { ProductApiError, wrapProductError } from '../api/errors'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import type { SearchPage, SearchResourceType, SearchResult } from '../api/types'
import { readRouteCache, writeRouteCache } from './routeCache'
import { resourcePrimaryTarget } from './useResourceNode'

export type ProductSearchState = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'loading-more'

type SearchSnapshot = {
  items: SearchResult[]
  cursor: string | null
  hasMore: boolean
  state: ProductSearchState
  error: ProductApiError | null
  appendedResultId: string | null
}

const emptySnapshot: SearchSnapshot = {
  items: [], cursor: null, hasMore: false, state: 'idle', error: null, appendedResultId: null,
}

function includes(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}

async function mockSearch(params: { q: string; types?: SearchResourceType[]; limit?: number }): Promise<SearchPage> {
  // Flag-off only. Keep this a dynamic import so the live Search chunk does
  // not pull the mock barrel (and the desk seed it re-exports).
  const { collections, curators, featuredResources } = await import('../api/mock-data')
  const query = params.q.trim()
  const allowed = new Set<SearchResourceType>(params.types ?? ['collection', 'node', 'profile', 'annotation'])
  const all: SearchResult[] = []
  if (allowed.has('collection')) {
    for (const item of collections) {
      if (includes(`${item.title} ${item.description} ${item.curator} ${item.tags.join(' ')}`, query)) {
        all.push({ resourceType: 'collection', resourceId: item.slug, title: item.title, snippet: item.description, rank: 0.7 })
      }
    }
  }
  if (allowed.has('profile')) {
    for (const item of Object.values(curators)) {
      if (includes(`${item.name} ${item.handle} ${item.bio}`, query)) {
        all.push({ resourceType: 'profile', resourceId: item.handle, handle: item.handle, displayName: item.name, avatarUrl: null, snippet: item.bio, rank: 0.65 })
      }
    }
  }
  if (allowed.has('node')) {
    for (const item of featuredResources) {
      if (includes(`${item.title} ${item.summary} ${item.host}`, query)) {
        all.push({ resourceType: 'node', resourceId: item.id, collectionId: 'interface-systems', title: item.title, urlHost: item.host, snippet: item.summary, rank: 0.6 })
      }
    }
  }
  const items = all.slice(0, params.limit ?? 20)
  return {
    query,
    types: [...allowed],
    items,
    page: { returnedCount: items.length, hasMore: false, nextCursor: null },
    consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
  }
}

function mergeUnique(current: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const seen = new Set(current.map((item) => `${item.resourceType}:${item.resourceId}`))
  return [...current, ...incoming.filter((item) => {
    const key = `${item.resourceType}:${item.resourceId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })]
}

type CachedSearch = Pick<SearchSnapshot, 'items' | 'cursor' | 'hasMore'>

function cacheKey(query: string, typesKey: string) {
  return `search:${typesKey}:${query}`
}

function restoredSnapshot(query: string, typesKey: string): SearchSnapshot {
  if (!query) return emptySnapshot
  const cached = readRouteCache<CachedSearch>(cacheKey(query, typesKey))
  if (cached === undefined || cached.items.length === 0) return emptySnapshot
  return { ...emptySnapshot, ...cached, state: 'ready' }
}

export function useProductSearch(input: {
  query: string
  types?: SearchResourceType[]
  limit: number
  debounceMs?: number
}) {
  const query = input.query.trim()
  const typesKey = input.types?.join(',') ?? ''
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failedCursorRef = useRef<string | undefined>(undefined)
  const paramsRef = useRef(input)
  paramsRef.current = input
  const paintedKeyRef = useRef<string | null>(query ? cacheKey(query, typesKey) : null)
  // Empty until a read for this session paints. A session change clears it so
  // a failed revalidation cannot keep the previous account's hits. Anonymous
  // search stays enabled; only the painted identity changes.
  const paintedIdentityRef = useRef(privateSessionIdentity())
  const identityRef = useRef(paintedIdentityRef.current)
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(() => restoredSnapshot(query, typesKey))
  const subscribeIdentity = useCallback((notify: () => void) => subscribeSession(() => {
    const next = privateSessionIdentity()
    if (next !== identityRef.current) {
      identityRef.current = next
      paintedIdentityRef.current = ''
      paintedKeyRef.current = null
      generationRef.current += 1
      controllerRef.current?.abort()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      failedCursorRef.current = undefined
      setSnapshot({ ...emptySnapshot })
    }
    notify()
  }), [])
  const identity = useSyncExternalStore(subscribeIdentity, privateSessionIdentity, privateSessionIdentity)

  const execute = useCallback(async (generation: number, cursor?: string) => {
    if (generation !== generationRef.current) return
    const params = paramsRef.current
    const currentQuery = params.query.trim()
    if (!currentQuery) return
    const requestedIdentity = privateSessionIdentity()
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setSnapshot((current) => {
      if (generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
      // Re-running the same query behind results already on screen (a route
      // round trip) revalidates instead of blanking back to "Searching…".
      // Hits painted for another session are not that page.
      const revalidating = !cursor && current.items.length > 0
        && cacheKey(currentQuery, params.types?.join(',') ?? '') === paintedKeyRef.current
        && paintedIdentityRef.current === requestedIdentity
      return {
        ...(cursor || revalidating ? current : emptySnapshot),
        state: revalidating ? current.state : cursor ? 'loading-more' : 'loading',
        error: null,
      }
    })
    try {
      const page = isLive('search')
        ? await productClient.searchResources({
            q: currentQuery,
            ...(params.types?.length ? { types: params.types } : {}),
            ...(cursor ? { cursor } : { limit: params.limit }),
          }, { signal: controller.signal, maxRetries: 0 })
        : await mockSearch({ q: currentQuery, types: params.types, limit: params.limit })
      if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return
      failedCursorRef.current = undefined
      // Ranking and relevance are the backend's call (per-script trigram
      // threshold); the client never second-guesses hits by substring, which
      // would drop legitimate fuzzy, stemmed and Unicode-folded matches.
      setSnapshot((current) => {
        if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
        const incoming = page.items
        const items = cursor ? mergeUnique(current.items, incoming) : incoming
        const next: SearchSnapshot = {
          items,
          cursor: page.page.nextCursor,
          hasMore: items.length > 0 && page.page.hasMore,
          state: items.length ? 'ready' : 'empty',
          error: null,
          appendedResultId: cursor ? incoming[0]?.resourceId ?? null : null,
        }
        paintedIdentityRef.current = requestedIdentity
        paintedKeyRef.current = cacheKey(currentQuery, params.types?.join(',') ?? '')
        writeRouteCache<CachedSearch>(paintedKeyRef.current, {
          items: next.items, cursor: next.cursor, hasMore: next.hasMore,
        }, requestedIdentity)
        return next
      })
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return
      failedCursorRef.current = cursor
      const error = wrapProductError(reason)
      setSnapshot((current) => {
        if (generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
        if (paintedIdentityRef.current !== requestedIdentity) return { ...emptySnapshot, state: 'error', error }
        return { ...current, state: 'error', error }
      })
    }
  }, [])

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    controllerRef.current?.abort()
    if (timerRef.current) clearTimeout(timerRef.current)
    // A session change clears the painted identity before this effect runs.
    // Don't put that session's hits back up just because the query string
    // is unchanged. Anonymous search still runs below.
    setSnapshot(paintedIdentityRef.current === identity ? restoredSnapshot(query, typesKey) : { ...emptySnapshot })
    failedCursorRef.current = undefined
    if (!query) return
    timerRef.current = setTimeout(() => { void execute(generation) }, input.debounceMs ?? 300)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      controllerRef.current?.abort()
    }
  }, [execute, identity, input.debounceMs, query, typesKey])

  const retry = useCallback(() => { void execute(generationRef.current, failedCursorRef.current) }, [execute])
  const loadMore = useCallback(() => {
    if (snapshot.cursor && snapshot.hasMore && snapshot.state !== 'loading-more') {
      void execute(generationRef.current, snapshot.cursor)
    }
  }, [execute, snapshot.cursor, snapshot.hasMore, snapshot.state])

  return { ...snapshot, retry, loadMore }
}

export function searchResultHref(result: SearchResult): string {
  switch (result.resourceType) {
    case 'profile': return `/u/${encodeURIComponent(result.handle)}`
    case 'collection': return `/c/${encodeURIComponent(result.resourceId)}`
    case 'node': {
      const target = resourcePrimaryTarget(result.resourceId, null, { collectionId: result.collectionId, subjectType: 'node' })
      return target.kind === 'internal' ? target.to : target.href
    }
    case 'annotation': {
      const target = resourcePrimaryTarget(result.subject.id, null, { collectionId: result.collectionId, subjectType: result.subject.type })
      return target.kind === 'internal' ? target.to : target.href
    }
  }
}

export function searchResultTitle(result: SearchResult): string {
  if (result.resourceType === 'profile') return result.displayName
  // The API carries no subject title: the annotation's own text is the
  // title, its type rides the kind chip and its subject the meta line.
  if (result.resourceType === 'annotation') {
    return result.snippet.trim() || `${annotationKindTitle(result.annotationType)} on a ${searchKindLabel(result.subject.type)}`
  }
  return result.title
}
