import type { ProductTransportHttp } from './product-transport-http'
import type {
  Etagged,
  LinkHealthListParams,
  MutationCallOptions,
  ReadingProgressListParams,
  SavedResourceListParams,
} from './product-transport-types'
import type {
  LinkHealthChecksReceipt,
  LinkHealthChecksRequest,
  LinkHealthPage,
  ReadingProgressMutationResult,
  ReadingProgressPage,
  ReadingProgressResourceType,
  ReadingProgressUpdate,
  ReadingProgressView,
  SavedResourcePage,
  SavedResourceType,
  SaveResourceResult,
} from './types'

export function createLibraryTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async listSavedResources(params?: SavedResourceListParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) query.cursor = params.cursor
      else {
        query.resourceType = params?.resourceType
        query.collectionId = params?.collectionId
        query.createdAfter = params?.createdAfter
        query.createdBefore = params?.createdBefore
        query.limit = params?.limit
      }
      return request<SavedResourcePage>({ method: 'GET', path: '/api/v1/saved-resources', query, signal: params?.signal })
    },

    async saveResource(resourceType: SavedResourceType, resourceId: string, opts: MutationCallOptions) {
      return request<SaveResourceResult>({ method: 'PUT', path: `/api/v1/saved-resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, headers: mutationHeaders(opts), signal: opts.signal })
    },

    async unsaveResource(resourceType: SavedResourceType, resourceId: string, opts: MutationCallOptions) {
      return request<void>({ method: 'DELETE', path: `/api/v1/saved-resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, headers: mutationHeaders(opts), signal: opts.signal, emptyOk: true })
    },

    async listReadingProgress(params?: ReadingProgressListParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) query.cursor = params.cursor
      else { query.status = params?.status; query.limit = params?.limit }
      return request<ReadingProgressPage>({ method: 'GET', path: '/api/v1/reading-progress', query, signal: params?.signal })
    },

    async getReadingProgress(
      resourceType: ReadingProgressResourceType,
      resourceId: string,
      signal?: AbortSignal,
    ) {
      try {
        return await request<ReadingProgressView>({ method: 'GET', path: `/api/v1/reading-progress/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, signal })
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null
        throw error
      }
    },

    async putReadingProgress(
      resourceType: ReadingProgressResourceType,
      resourceId: string,
      body: ReadingProgressUpdate,
      opts: MutationCallOptions,
    ) {
      return request<Etagged<ReadingProgressMutationResult>>({ method: 'PUT', path: `/api/v1/reading-progress/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, headers: mutationHeaders(opts), body, contentType: 'application/json', signal: opts.signal, includeEtag: true })
    },

    async resetReadingProgress(
      resourceType: ReadingProgressResourceType,
      resourceId: string,
      opts: MutationCallOptions,
    ) {
      return request<void>({ method: 'DELETE', path: `/api/v1/reading-progress/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, headers: mutationHeaders(opts), signal: opts.signal, emptyOk: true })
    },

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
