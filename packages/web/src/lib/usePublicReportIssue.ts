import { useEffect, useState } from 'react'
import { isProductApiError, productClient, type PublicReportIssue } from '../api'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

export type PublicReportIssueLoad =
  | { status: 'loading' }
  | { status: 'ready'; issue: PublicReportIssue }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

function cacheKey(slug: string, editionId: string) {
  return `public-report-issue:${slug}:${editionId}`
}

function restored(slug: string, editionId: string): PublicReportIssueLoad {
  const issue = readRouteCache<PublicReportIssue>(cacheKey(slug, editionId))
  return issue === undefined ? { status: 'loading' } : { status: 'ready', issue }
}

/**
 * Single public issue for /reports/:slug/issues/:editionId. The issue is the
 * digest cover (title/summary/publishedAt) plus the source Collection slug;
 * the entry stream itself comes from usePublicCollectionSnapshot on that slug.
 */
export function usePublicReportIssue(slug: string, editionId: string) {
  const [reloadKey, setReloadKey] = useState(0)
  const [load, setLoad] = useState<PublicReportIssueLoad>(() => restored(slug, editionId))

  useEffect(() => {
    const controller = new AbortController()
    const cached = restored(slug, editionId)
    setLoad(cached)
    const revalidating = cached.status === 'ready'

    void productClient.getPublicReportIssue(slug, editionId, { signal: controller.signal }).then((issue) => {
      if (controller.signal.aborted) return
      writeRouteCache(cacheKey(slug, editionId), issue)
      setLoad({ status: 'ready', issue })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return
      if (isProductApiError(error) && (error.status === 404 || error.code === 'resource_not_found')) {
        setLoad({ status: 'unavailable' })
        return
      }
      if (revalidating) return
      setLoad({
        status: 'error',
        message: isProductApiError(error) ? error.recoveryHint : 'Check your connection and try again.',
      })
    })
    return () => controller.abort()
  }, [slug, editionId, reloadKey])

  return { load, reload: () => setReloadKey((key) => key + 1) }
}
