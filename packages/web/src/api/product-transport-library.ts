import type { ProductTransportHttp } from './product-transport-http'
import type {
  LinkHealthListParams,
  MutationCallOptions,
} from './product-transport-types'
import type {
  LinkHealthChecksReceipt,
  LinkHealthChecksRequest,
  LinkHealthPage,
} from './types'

export function createLibraryTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http
  return {
    async getMyLinkHealth(params?: LinkHealthListParams) {
      const query: Record<string, string | number | boolean | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else {
        if (params?.scope != null) {
          query.scope = params.scope
        }
        query.status = params?.status
        query.collectionId = params?.collectionId
        query.duplicate = params?.duplicate
        query.limit = params?.limit
      }
      return request<LinkHealthPage>({
        method: 'GET',
        path: '/api/v1/me/link-health',
        query,
        headers: { Accept: 'application/json' },
        signal: params?.signal,
      })
    },

    async enqueueMyLinkHealthChecks(body: LinkHealthChecksRequest, opts: MutationCallOptions) {
      return request<LinkHealthChecksReceipt>({
        method: 'POST',
        path: '/api/v1/me/link-health/checks',
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}
