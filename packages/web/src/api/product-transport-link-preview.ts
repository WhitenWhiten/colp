import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type { LinkPreviewRequestAccepted } from './types'

/** LP-05 preview requests (404 while the feature is off). */
export function createLinkPreviewTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async requestCollectionLinkPreviews(collectionId: string, nodeIds: readonly string[], opts: MutationCallOptions) {
      return request<LinkPreviewRequestAccepted>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/link-preview-requests`,
        headers: mutationHeaders(opts),
        body: { nodeIds: [...nodeIds] },
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}
