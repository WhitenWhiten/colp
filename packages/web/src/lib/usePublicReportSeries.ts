import { useEffect, useState } from 'react'
import { isProductApiError, productClient, type PublicReportSeries } from '../api'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

export type PublicReportSeriesLoad =
  | { status: 'loading' }
  | { status: 'ready'; series: PublicReportSeries }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }

function cacheKey(slug: string) {
  return `public-report:${slug}`
}

function restored(slug: string): PublicReportSeriesLoad {
  const series = readRouteCache<PublicReportSeries>(cacheKey(slug))
  return series === undefined ? { status: 'loading' } : { status: 'ready', series }
}

/**
 * Public report series (with its bounded issue archive) for /reports/:slug.
 * Same paint-then-revalidate contract as usePublicCollectionSnapshot: a
 * cached series renders immediately and a failed revalidation keeps it.
 */
export function usePublicReportSeries(slug: string) {
  const [reloadKey, setReloadKey] = useState(0)
  const [load, setLoad] = useState<PublicReportSeriesLoad>(() => restored(slug))

  useEffect(() => {
    const controller = new AbortController()
    const cached = restored(slug)
    setLoad(cached)
    const revalidating = cached.status === 'ready'

    void productClient.getPublicReportSeries(slug, { signal: controller.signal }).then((series) => {
      if (controller.signal.aborted) return
      writeRouteCache(cacheKey(slug), series)
      setLoad({ status: 'ready', series })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return
      // A withdrawn or gated report must surface even if we still hold a snapshot.
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
  }, [slug, reloadKey])

  return { load, reload: () => setReloadKey((key) => key + 1) }
}
