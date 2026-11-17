import { useCallback, useEffect, useState } from 'react'
import { productClient, type EditorSnapshot, type SearchResult } from '../../api'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'
import { readDeskCache } from '../library-desk/data'
import { rootTitle } from '../../lib/libraryTree'
import { pruneRouteCache, readRouteCache, writeRouteCache } from '../../lib/routeCache'

/**
 * Where a search hit lives, after linkding's one quiet line under the title:
 * the collection and the folder trail, and whether a node is a folder. The
 * search API names neither, so the page reads them from the collection's
 * editor tree — the desk's cached snapshot when the owner came from the
 * library, otherwise one tree load per collection in the results.
 */
export type SearchPlace = {
  /** A node hit's real kind; null when the tree did not have it. */
  kind: 'folder' | 'bookmark' | null
  /** Collection title, then the folders down to the hit's parent. */
  trail: string[]
  /** An annotation's subject title. */
  subjectTitle: string | null
}

type PlaceNode = { kind: 'folder' | 'bookmark'; parentId: string; title: string }

export type PlaceIndex = {
  title: string
  rootId: string
  nodes: Record<string, PlaceNode>
}

type CachedIndex = { at: number; index: PlaceIndex | null }

/** The desk's own staleness window: a tree younger than this is not re-paged. */
const FRESH_MS = 60_000
/** Results span few collections; past this many, the rest go without a trail. */
const MAX_COLLECTIONS = 4
const MAX_TRAIL_DEPTH = 6
/** Editor trees are large; keep only the most recently used indexes in memory. */
export const MAX_CACHED_PLACE_INDEXES = 8
const PLACES_CACHE_PREFIX = 'search-places:'

type InFlight = { controller: AbortController; promise: Promise<PlaceIndex | null> }
const inFlight = new Map<string, InFlight>()
let cacheIdentity = privateSessionIdentity()

const cacheKey = (collectionId: string) => `${PLACES_CACHE_PREFIX}${collectionId}`

export function placeIndexFromSnapshot(snapshot: EditorSnapshot): PlaceIndex {
  const nodes: Record<string, PlaceNode> = {}
  for (const node of snapshot.nodes) {
    nodes[node.id] = { kind: node.kind === 'folder' ? 'folder' : 'bookmark', parentId: node.parentId, title: node.title }
  }
  // Trails start where the library starts: "All bookmarks", never the stored title.
  return { title: rootTitle(snapshot.collection), rootId: snapshot.root.id, nodes }
}

function trailTo(index: PlaceIndex, parentId: string): string[] {
  const folders: string[] = []
  let current = parentId
  const seen = new Set<string>()
  while (current !== index.rootId && !seen.has(current) && folders.length < MAX_TRAIL_DEPTH) {
    seen.add(current)
    const node = index.nodes[current]
    if (!node || node.kind !== 'folder') break
    folders.unshift(node.title)
    current = node.parentId
  }
  return [index.title, ...folders]
}

export function placeFor(result: SearchResult, index: PlaceIndex | null | undefined): SearchPlace | null {
  if (!index || result.resourceType === 'collection') return null
  if (result.resourceType === 'node') {
    const node = index.nodes[result.resourceId]
    if (!node) return { kind: null, trail: [index.title], subjectTitle: null }
    return { kind: node.kind, trail: trailTo(index, node.parentId), subjectTitle: null }
  }
  if (result.subject.type === 'collection') return { kind: null, trail: [], subjectTitle: index.title }
  const subject = index.nodes[result.subject.id]
  if (!subject) return { kind: null, trail: [index.title], subjectTitle: null }
  return { kind: null, trail: trailTo(index, subject.parentId), subjectTitle: subject.title }
}

/** Long trails keep both ends: "Reading notes › … › Design". */
export function compactTrail(trail: readonly string[]): string[] {
  return trail.length <= 3 ? [...trail] : [trail[0]!, '…', trail[trail.length - 1]!]
}

/** Read a collection's index, seeding it from the desk's snapshot when possible. */
export function readCachedPlaceIndex(collectionId: string): CachedIndex | undefined {
  const cached = readRouteCache<CachedIndex>(cacheKey(collectionId))
  if (cached) return cached
  const snap = readDeskCache()?.snaps[collectionId]
  if (!snap) return undefined
  return rememberPlaceIndex(collectionId, { at: Date.now(), index: placeIndexFromSnapshot(snap) })
}

/** Store one collection index and evict the least recently used beyond the bound. */
export function rememberPlaceIndex(collectionId: string, entry: CachedIndex): CachedIndex {
  writeRouteCache<CachedIndex>(cacheKey(collectionId), entry)
  pruneRouteCache(PLACES_CACHE_PREFIX, MAX_CACHED_PLACE_INDEXES)
  return entry
}

/**
 * One tree read per collection, shared by every caller asking while it is in
 * flight. The index cache means a fresh entry is never re-paged; a failed
 * read keeps a stale index when there is one, otherwise it records the miss
 * so a keystroke storm does not re-page the same collection.
 */
export function loadPlaceIndex(collectionId: string): Promise<PlaceIndex | null> {
  const existing = inFlight.get(collectionId)
  if (existing) return existing.promise
  const cached = readCachedPlaceIndex(collectionId)
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.index)
  const requestIdentity = privateSessionIdentity()
  const controller = new AbortController()
  const load: InFlight = { controller, promise: Promise.resolve(null) }
  load.promise = productClient.loadEditorSnapshot(collectionId, { signal: controller.signal, maxRetries: 0 })
    .then((snapshot) => {
      if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return null
      return rememberPlaceIndex(collectionId, { at: Date.now(), index: placeIndexFromSnapshot(snapshot) }).index
    })
    .catch(() => {
      if (controller.signal.aborted || privateSessionIdentity() !== requestIdentity) return null
      // No trail for this collection; a stale tree, if any, stays in use.
      if (!readCachedPlaceIndex(collectionId)?.index) {
        rememberPlaceIndex(collectionId, { at: Date.now(), index: null })
      }
      return null
    })
    .finally(() => {
      if (inFlight.get(collectionId) === load) inFlight.delete(collectionId)
    })
  inFlight.set(collectionId, load)
  return load.promise
}

// A new private identity invalidates tree indexes (the route cache drops them)
// and must not leave the previous account's reads resolving into the new one.
subscribeSession(() => {
  const next = privateSessionIdentity()
  if (next === cacheIdentity) return
  cacheIdentity = next
  for (const { controller } of inFlight.values()) controller.abort()
  inFlight.clear()
})

function placeCollections(items: readonly SearchResult[]): string[] {
  const ids: string[] = []
  for (const item of items) {
    if (item.resourceType === 'collection' || ids.includes(item.collectionId)) continue
    ids.push(item.collectionId)
    if (ids.length === MAX_COLLECTIONS) break
  }
  return ids
}

/** Resolves each hit's place; re-renders as collection trees arrive. */
export function useSearchPlaces(items: readonly SearchResult[]): (result: SearchResult) => SearchPlace | null {
  const key = placeCollections(items).join('\n')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    for (const collectionId of key.split('\n')) {
      const cached = readCachedPlaceIndex(collectionId)
      if (cached && Date.now() - cached.at < FRESH_MS) continue
      void loadPlaceIndex(collectionId).then((index) => {
        // A cached-but-stale index is already on screen; only a fresh read re-renders.
        if (!cancelled && index) setVersion((value) => value + 1)
      })
    }
    return () => { cancelled = true }
  }, [key])

  return useCallback(
    (result: SearchResult) => (result.resourceType === 'collection' ? null : placeFor(result, readCachedPlaceIndex(result.collectionId)?.index)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the re-read signal
    [version],
  )
}
