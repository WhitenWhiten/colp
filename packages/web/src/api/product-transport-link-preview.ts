import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type { BookmarkPreviewModeView, LinkPreviewRequestAccepted } from './types'

/** LP-05 preview requests and the per-bookmark preview mode (404 while the feature is off). */
export function createLinkPreviewTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http
  const modePath = (collectionId: string, nodeId: string) =>
    `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/preview-image-mode`

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

    async getBookmarkPreviewMode(collectionId: string, nodeId: string, signal?: AbortSignal) {
      return request<BookmarkPreviewModeView>({
        method: 'GET',
        path: modePath(collectionId, nodeId),
        headers: { Accept: 'application/json' },
        signal,
      })
    },

    async setBookmarkPreviewMode(
      collectionId: string,
      nodeId: string,
      mode: BookmarkPreviewModeView['mode'],
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<BookmarkPreviewModeView>({
        method: 'PUT',
        path: modePath(collectionId, nodeId),
        headers: mutationHeaders(opts),
        body: { mode },
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}
