import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  isProductApiError,
  privateSessionIdentity,
  productClient,
  subscribeSession,
  type PublicCollectionSnapshot,
} from '../api'
import { readRouteCache, writeRouteCache } from './routeCache'

export type PublicSnapshotLoad =
  | { status: 'loading'; restartCount: number }
  | { status: 'ready'; snapshot: PublicCollectionSnapshot }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

/**
 * Shared by the collection board, the path reader, the graph and share views,
 * so a hop between two views of the same collection used to reassemble the
 * whole published snapshot from scratch — the heaviest read in the product.
 *
 * A member response can include nodes the payload does not mark as private.
 * When the session identity that loaded that tree is gone, the whole tree is
 * retired and refetched; nothing here tries to guess which nodes are public.
 */
function cacheKey(slug: string) {
  return `public-collection:${slug}`
}

function sessionIdentity(): string {
  return privateSessionIdentity()
}

function restored(slug: string): PublicSnapshotLoad {
  const snapshot = readRouteCache<PublicCollectionSnapshot>(cacheKey(slug))
  return snapshot === undefined ? { status: 'loading', restartCount: 0 } : { status: 'ready', snapshot }
}

export function usePublicCollectionSnapshot(slug: string | null) {
  const identity = useSyncExternalStore(subscribeSession, sessionIdentity, sessionIdentity)
  const [reloadKey, setReloadKey] = useState(0)
  const [load, setLoad] = useState<PublicSnapshotLoad>(() => (slug ? restored(slug) : { status: 'unavailable' }))
  const [seenIdentity, setSeenIdentity] = useState(identity)

  // Drop the rendered tree before paint. The route cache is already stamped
  // by session identity, so a miss must not keep a member projection in state.
  if (seenIdentity !== identity) {
    setSeenIdentity(identity)
    if (!slug) setLoad({ status: 'unavailable' })
    else if (load.status === 'ready') setLoad({ status: 'loading', restartCount: 0 })
  }

  useEffect(() => {
    if (!slug) {
      setLoad({ status: 'unavailable' })
      return
    }
    const requestIdentity = identity
    const controller = new AbortController()
    const cached = restored(slug)
    // Paint the cached snapshot and revalidate behind it. Only a slug we have
    // never assembled, or a projection from another session, shows loading.
    setLoad(cached)
    const revalidating = cached.status === 'ready'

    void productClient.loadPublicCollectionSnapshot(slug, {
      signal: controller.signal,
      onCursorRestart: ({ attempt }) => {
        if (controller.signal.aborted || revalidating || requestIdentity !== privateSessionIdentity()) return
        setLoad({ status: 'loading', restartCount: attempt })
      },
    }).then((snapshot) => {
      if (controller.signal.aborted || requestIdentity !== privateSessionIdentity()) return
      writeRouteCache(cacheKey(slug), snapshot, requestIdentity)
      setLoad({ status: 'ready', snapshot })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      if (requestIdentity !== privateSessionIdentity()) return
      // A withdrawn collection must surface even if we still hold a snapshot.
      if (isProductApiError(error) && (error.status === 404 || error.code === 'resource_not_found')) {
        setLoad({ status: 'unavailable' })
        return
      }
      // Keep the rendered tree only when this failure is still the same
      // identity and the cache still holds that projection. A miss after
      // session loss, or an explicit cache clear, must not resurrect it.
      if (revalidating) return
      setLoad({
        status: 'error',
        message: isProductApiError(error) ? error.recoveryHint : 'Check your connection and try again.',
      })
    })

    return () => controller.abort()
  }, [slug, reloadKey, identity])

  const retry = useCallback(() => setReloadKey((value) => value + 1), [])
  return { load, retry }
}

/** The last snapshot painted for this slug, without triggering a load — for
 *  optional previews that must never block (the series-page issue-front
 *  table-of-contents row, R10-11). Returns null when nothing is cached. */
export function peekPublicCollectionSnapshot(slug: string): PublicCollectionSnapshot | null {
  return readRouteCache<PublicCollectionSnapshot>(cacheKey(slug)) ?? null
}
