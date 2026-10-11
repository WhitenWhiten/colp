import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type {
  CollectionVersion,
  CollectionVersionCreateRequest,
  CollectionVersionPage,
  CollectionVersionRestoreReceipt,
  CollectionVersionRestoreRequest,
} from './types'

export function createVersionsTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http
  return {
    async createCollectionVersion(
      collectionId: string,
      body: CollectionVersionCreateRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<CollectionVersion>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async listCollectionVersions(
      collectionId: string,
      params?: { limit?: number; cursor?: string; signal?: AbortSignal },
    ) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else if (params?.limit != null) {
        query.limit = params.limit
      }
      return request<CollectionVersionPage>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions`,
        query,
        headers: { Accept: 'application/json' },
        signal: params?.signal,
      })
    },

    async getCollectionVersion(
      collectionId: string,
      versionId: string,
      opts?: { signal?: AbortSignal },
    ) {
      return request<CollectionVersion>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions/${encodeURIComponent(versionId)}`,
        headers: { Accept: 'application/json' },
        signal: opts?.signal,
      })
    },

    async restoreCollectionVersion(
      collectionId: string,
      versionId: string,
      body: CollectionVersionRestoreRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<CollectionVersionRestoreReceipt>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/versions/${encodeURIComponent(versionId)}/restore`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}
