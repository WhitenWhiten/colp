import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type { CoverPreferenceInput, CoverPreferenceView, ImageUploadView } from './types'

export function createCoverImageTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http
  return {
    uploadCollectionImage(collectionId: string, file: File, opts: MutationCallOptions) {
      return request<ImageUploadView>({
        method: 'POST', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/images`,
        headers: mutationHeaders(opts, { 'Content-Type': file.type || 'application/octet-stream' }),
        rawBody: file, signal: opts.signal,
      })
    },
    updateNodeCover(collectionId: string, nodeId: string, body: CoverPreferenceInput, opts: MutationCallOptions & { revision: string }) {
      return request<CoverPreferenceView>({
        method: 'PUT', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/cover`,
        headers: mutationHeaders(opts, { 'If-Match': `"cover:${opts.revision}"` }),
        body, contentType: 'application/json', signal: opts.signal,
      })
    },
  }
}
