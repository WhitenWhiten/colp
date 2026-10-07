import { useCallback, useEffect, useState } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useAuth } from '../../auth/AuthContext'
import type { PublicSnapshotLoad } from '../../lib/usePublicCollectionSnapshot'

/** Graph reads are fresh and identity-bound, including after a relation edit. */
export function useGraphSnapshot(slug: string) {
  const { user, isLoggedIn, bootstrapping } = useAuth()
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([slug, isLoggedIn, user?.profileId, bootstrapping, revision])
  const [result, setResult] = useState<{ key: string; load: PublicSnapshotLoad } | null>(null)
  useEffect(() => {
    if (bootstrapping) return
    const controller = new AbortController()
    const publish = (load: PublicSnapshotLoad) => {
      if (!controller.signal.aborted) setResult({ key, load })
    }
    publish({ status: 'loading', restartCount: 0 })
    void productClient.loadPublicCollectionSnapshot(slug, {
      includeRelations: true,
      signal: controller.signal,
      onCursorRestart: ({ attempt }) => publish({ status: 'loading', restartCount: attempt }),
    }).then((snapshot) => publish({ status: 'ready', snapshot })).catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (isProductApiError(error) && error.status === 404) publish({ status: 'unavailable' })
      else publish({ status: 'error', message: "Couldn't load the graph. Try again." })
    })
    return () => controller.abort()
  }, [key, slug, bootstrapping])
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  const load: PublicSnapshotLoad = result?.key === key ? result.load : { status: 'loading', restartCount: 0 }
  return { load, retry }
}
