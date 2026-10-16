import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type { FolderShareState } from './types'

function path(collectionId: string, nodeId: string) {
  return `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/share`
}
export function createFolderShareTransport(http: ProductTransportHttp) {
  return {
    getFolderShare(collectionId: string, nodeId: string, signal?: AbortSignal) {
      return http.request<FolderShareState>({ method: 'GET', path: path(collectionId, nodeId), signal })
    },
    putFolderShare(collectionId: string, nodeId: string, options: MutationCallOptions) {
      return http.request<FolderShareState>({ method: 'PUT', path: path(collectionId, nodeId),
        body: {}, contentType: 'application/json', headers: http.mutationHeaders(options), signal: options.signal })
    },
    deleteFolderShare(collectionId: string, nodeId: string, options: MutationCallOptions) {
      return http.request<FolderShareState>({ method: 'DELETE', path: path(collectionId, nodeId),
        headers: http.mutationHeaders(options), signal: options.signal })
    },
  }
}
