import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type {
  BookmarkFaviconSource,
  FaviconCreateIconJobRequest,
  FaviconIconJob,
  FaviconIconJobAccepted,
  FaviconIconPolicy,
  FaviconIconPolicyPatch,
  FaviconPolicyResult,
  SetBookmarkFaviconSourceRequest,
} from './types'

/**
 * FO-01/FO-02 favicon policy/source transport. The GETs are ETagged reads
 * (the response ETag is the If-Match validator for the mutations) and the
 * mutations carry Known-Command-Id + Origin + X-CSRF-Token through
 * mutationHeaders. online is written through the source PUT and refreshed by
 * the durable refreshBookmarkFavicon POST (FO-02); uploaded enters only
 * through the existing image upload.
 */
export function createFaviconTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async getMyFaviconPolicy(signal?: AbortSignal) {
      return request<FaviconIconPolicy & { etag: string }>({
        method: 'GET',
        path: '/api/v1/me/favicon-policy',
        includeEtag: true,
        signal,
      })
    },

    async updateMyFaviconPolicy(
      patch: FaviconIconPolicyPatch,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<FaviconPolicyResult>({
        method: 'PATCH',
        path: '/api/v1/me/favicon-policy',
        headers: mutationHeaders(opts),
        body: patch,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async getBookmarkFaviconSource(collectionId: string, nodeId: string, signal?: AbortSignal) {
      return request<BookmarkFaviconSource & { etag: string }>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/favicon-source`,
        includeEtag: true,
        signal,
      })
    },

    async setBookmarkFaviconSource(
      collectionId: string,
      nodeId: string,
      body: SetBookmarkFaviconSourceRequest,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<BookmarkFaviconSource>({
        method: 'PUT',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/favicon-source`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async refreshBookmarkFavicon(
      collectionId: string,
      nodeId: string,
      opts: MutationCallOptions & { ifMatch: string },
    ) {
      return request<FaviconIconJobAccepted>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/favicon-refresh`,
        headers: mutationHeaders(opts),
        signal: opts.signal,
      })
    },

    // FO-03 account job surface (create/get/retry durable batch jobs).
    async createMyFaviconJob(body: FaviconCreateIconJobRequest, opts: MutationCallOptions) {
      return request<FaviconIconJobAccepted>({
        method: 'POST',
        path: '/api/v1/me/favicon-jobs',
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async getMyFaviconJob(jobId: string, signal?: AbortSignal) {
      return request<FaviconIconJob>({
        method: 'GET',
        path: `/api/v1/me/favicon-jobs/${encodeURIComponent(jobId)}`,
        signal,
      })
    },

    async retryMyFaviconJob(jobId: string, opts: MutationCallOptions) {
      return request<FaviconIconJobAccepted>({
        method: 'POST',
        path: `/api/v1/me/favicon-jobs/${encodeURIComponent(jobId)}/retry`,
        headers: mutationHeaders(opts),
        signal: opts.signal,
      })
    },
  }
}