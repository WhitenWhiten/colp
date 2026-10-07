import { useEffect, useMemo, useReducer, useSyncExternalStore } from 'react'
import { isLive, isProductApiError, productClient, type AnnotationView } from '../api'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { isAbort } from './libraryTree'

/** Note / TL;DR distilled from a bookmark's annotations (comfort rows). */
export type BookmarkAnnotationMarks = {
  tldr?: AnnotationSnippet
  note?: AnnotationSnippet
}

export type AnnotationSnippet = { text: string; format: 'plain' | 'markdown' }

/**
 * The Product API lists annotations per subject only (no batch read), so the
 * desk pulls them lazily per bookmark. The per-layer cap and the small worker
 * pool keep a large flat layer from fanning into a request storm, and the
 * session cache makes density toggles and folder hops free afterwards.
 */
const MAX_LOOKUPS_PER_LAYER = 60
const WORKERS = 4

/**
 * Private marks, in-flight reads, and denial stops are partitioned by
 * privateSessionIdentity. A session change retires every other partition
 * so a shared collection cannot keep showing the previous account's note.
 * A response may write only while the identity that started it is current.
 */
const cache = new Map<string, BookmarkAnnotationMarks>()
/** Ticket per in-flight read so a late `finally` cannot clear a newer one. */
const inflight = new Map<string, symbol>()
/** Collections whose annotation reads were denied — stop probing them. */
const denied = new Set<string>()

function entryKey(identity: string, collectionId: string, nodeId: string): string {
  return `${identity}\n${collectionId}:${nodeId}`
}

function denialKey(identity: string, collectionId: string): string {
  return `${identity}\n${collectionId}`
}

function retireForeignPartitions(current: string): void {
  const prefix = `${current}\n`
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of [...inflight.keys()]) {
    if (!key.startsWith(prefix)) inflight.delete(key)
  }
  for (const key of [...denied]) {
    if (!key.startsWith(prefix)) denied.delete(key)
  }
}

subscribeSession((snapshot) => {
  retireForeignPartitions(privateSessionIdentity(snapshot))
})

function annotationText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function marksFrom(items: AnnotationView[]): BookmarkAnnotationMarks {
  const tldr = items.find((item) => item.type === 'tldr')
  const note = items.find((item) => item.type === 'note' && item.visibility === 'private')
    ?? items.find((item) => item.type === 'note')
  const marks: BookmarkAnnotationMarks = {}
  const tldrText = tldr ? annotationText(tldr.value).trim() : ''
  const noteText = note ? annotationText(note.value).trim() : ''
  const snippet = (item: AnnotationView | undefined, text: string): AnnotationSnippet | undefined => {
    if (!item || !text) return undefined
    return { text, format: item.format === 'markdown' && typeof item.value === 'string' ? 'markdown' : 'plain' }
  }
  const tldrMark = snippet(tldr, tldrText)
  const noteMark = snippet(note, noteText)
  if (tldrMark) marks.tldr = tldrMark
  if (noteMark) marks.note = noteMark
  return marks
}

function annotationsExposed(): boolean {
  try {
    return isLive('annotations')
      || String(import.meta.env?.VITE_ANNOTATIONS_ACCEPTANCE ?? '').toLowerCase() === 'true'
  } catch {
    return false
  }
}

/** Drop one cached subject for the current identity after save/delete. */
export function invalidateBookmarkAnnotations(collectionId: string, nodeId: string): void {
  cache.delete(entryKey(privateSessionIdentity(), collectionId, nodeId))
}

export function resetBookmarkAnnotationsCacheForTests(): void {
  cache.clear()
  inflight.clear()
  denied.clear()
}

/**
 * Note / TL;DR marks for the given bookmark nodes, filled in lazily.
 * Failures stay quiet: a row without marks simply renders without snippets.
 */
export function useBookmarkAnnotations(
  collectionId: string | null,
  nodeIds: readonly string[],
  enabled: boolean,
): ReadonlyMap<string, BookmarkAnnotationMarks> {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [version, refresh] = useReducer((n: number) => n + 1, 0)
  const active = enabled && collectionId !== null && annotationsExposed()
  // Opaque ids never contain a newline; the joined key keeps the effect
  // dependency primitive so parent re-renders do not re-trigger it.
  const idsKey = nodeIds.join('\n')
  const ids = useMemo(() => (idsKey ? idsKey.split('\n') : []), [idsKey])

  useEffect(() => {
    if (!active || !collectionId || denied.has(denialKey(identity, collectionId))) return
    const requestIdentity = identity
    const queue = ids
      .slice(0, MAX_LOOKUPS_PER_LAYER)
      .filter((id) => {
        const key = entryKey(requestIdentity, collectionId, id)
        return !cache.has(key) && !inflight.has(key)
      })
    if (queue.length === 0) return
    const controller = new AbortController()
    let cancelled = false

    const run = async () => {
      for (;;) {
        const nodeId = queue.shift()
        if (
          nodeId === undefined
          || cancelled
          || requestIdentity !== privateSessionIdentity()
          || denied.has(denialKey(requestIdentity, collectionId))
        ) return
        const key = entryKey(requestIdentity, collectionId, nodeId)
        const ticket = Symbol()
        inflight.set(key, ticket)
        try {
          const items = await productClient.loadAnnotations(
            collectionId,
            { resourceType: 'node', resourceId: nodeId },
            { signal: controller.signal, maxRetries: 0 },
          )
          // A resolved read can outlive the account that started it. Cache it
          // only for that identity, including when this effect was cancelled
          // by a same-account unmount.
          if (requestIdentity !== privateSessionIdentity()) return
          cache.set(key, marksFrom(items))
          if (!cancelled) refresh()
        } catch (error) {
          if (requestIdentity !== privateSessionIdentity()) return
          if (cancelled || controller.signal.aborted || isAbort(error)) return
          // Denied reads block the whole collection so one layer cannot keep
          // re-probing; other failures cache an empty mark for this identity.
          if (isProductApiError(error) && (error.isAuthRequired || error.status === 403)) {
            denied.add(denialKey(requestIdentity, collectionId))
            return
          }
          cache.set(key, {})
        } finally {
          if (inflight.get(key) === ticket) inflight.delete(key)
        }
      }
    }

    for (let worker = 0; worker < WORKERS; worker += 1) void run()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [active, collectionId, ids, identity])

  return useMemo(() => {
    const marks = new Map<string, BookmarkAnnotationMarks>()
    if (!active || !collectionId) return marks
    for (const id of ids) {
      const entry = cache.get(entryKey(identity, collectionId, id))
      if (entry && (entry.tldr || entry.note)) marks.set(id, entry)
    }
    return marks
    // `version` re-reads the module cache after each settled lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the cache clock
  }, [active, collectionId, ids, identity, version])
}
