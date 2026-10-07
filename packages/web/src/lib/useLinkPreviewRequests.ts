import { useEffect, useRef, useState } from 'react'
import { isLive, isProductApiError, productClient } from '../api'

/**
 * LP-07: in Gallery, an owner or editor explicitly asks the server for the
 * preview images of the bookmarks on screen that have none yet. That request
 * is the consent that lets the worker fetch a private collection's pages.
 *
 * - successful node requests are deduplicated per collection per session;
 * - ids are batched (≤100 per request, ≤300 per view) after a short debounce;
 * - accepted batches trigger bounded refreshes while visible covers are missing;
 * - a 404 (backend feature off) stops requests for the rest of the session.
 */
export const LINK_PREVIEW_REQUEST_BATCH = 100
export const LINK_PREVIEW_REQUEST_DEBOUNCE_MS = 500
export const LINK_PREVIEW_REFRESH_DELAY_MS = 15_000
/** Upper bound per view so a huge unvirtualized folder cannot burst requests. */
export const LINK_PREVIEW_REQUEST_MAX_PER_VIEW = 300

export const LINK_PREVIEW_MAX_REFRESHES = 6

const acceptedByCollection = new Map<string, Set<string>>()
const requestedByCollection = new Map<string, Set<string>>()
let disabledForSession = false

/** Test hook: forget what this session already requested. */
export function resetLinkPreviewRequestsForTests(): void {
  requestedByCollection.clear()
  acceptedByCollection.clear()
  disabledForSession = false
}

export function useLinkPreviewRequests(input: {
  readonly collectionId: string | null
  /** Gallery is showing and the viewer may edit this collection. */
  readonly enabled: boolean
  /** Bookmark ids on screen whose previewImage is null. */
  readonly missingNodeIds: readonly string[]
  readonly onRefresh: () => void
}): void {
  const { collectionId, enabled, missingNodeIds, onRefresh } = input
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh
  const [acceptedVersion, setAcceptedVersion] = useState(0)
  const key = missingNodeIds.join('\u0000')

  useEffect(() => {
    if (!enabled || collectionId === null || disabledForSession || !isLive('linkPreview')) return
    if (!missingNodeIds.some((id) => acceptedByCollection.get(collectionId)?.has(id))) return
    let count = 0
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => {
        refresh.current()
        count += 1
        if (count < LINK_PREVIEW_MAX_REFRESHES) schedule()
      }, Math.min(LINK_PREVIEW_REFRESH_DELAY_MS * 2 ** count, 60_000))
    }
    schedule()
    return () => clearTimeout(timer)
    // The key represents the visible missing IDs, independently of array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, collectionId, key, acceptedVersion])

  useEffect(() => {
    if (!enabled || collectionId === null || disabledForSession || !isLive('linkPreview')) return
    const requested = requestedByCollection.get(collectionId) ?? new Set<string>()
    requestedByCollection.set(collectionId, requested)
    const pending = missingNodeIds.filter((id) => !requested.has(id)).slice(0, LINK_PREVIEW_REQUEST_MAX_PER_VIEW)
    if (pending.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      void (async () => {
        let accepted = false
        const acceptedIds = acceptedByCollection.get(collectionId) ?? new Set<string>()
        acceptedByCollection.set(collectionId, acceptedIds)
        for (let start = 0; start < pending.length && !disabledForSession && !cancelled; start += LINK_PREVIEW_REQUEST_BATCH) {
          const batch = pending.slice(start, start + LINK_PREVIEW_REQUEST_BATCH).filter((id) => !requested.has(id))
          if (batch.length === 0) continue
          for (const id of batch) requested.add(id)
          try {
            const result = await productClient.requestLinkPreviews(collectionId, batch, {
              intentId: productClient.mutationIntentKey(`link-previews:${collectionId}:${batch[0]}`, productClient.newCommandId()),
            })
            if (result.enqueued > 0) {
              accepted = true
              for (const id of batch) acceptedIds.add(id)
            }
          } catch (error) {
            for (const id of batch) requested.delete(id)
            if (isProductApiError(error) && error.status === 404) disabledForSession = true
            // A later view entry can retry transient failures.
          }
        }
        if (accepted && !cancelled) setAcceptedVersion((version) => version + 1)
      })()
    }, LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `key` carries the id list; the array identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, collectionId, key])
}
