import type { ProductTransportHttp } from './product-transport-http'
import type {
  PublicCollectionPageParams,
  SearchParams,
} from './product-transport-types'
import type { PublicCollectionPage, SearchPage } from './types'

export function createSearchPublicTransport(http: ProductTransportHttp) {
  const { request } = http
  return {
    async getPublicCollectionPage(slug: string, params?: PublicCollectionPageParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.includeRelations) query.include = 'relations'
      if (params?.limit != null) {
        query.limit = params.limit
      }
      if (params?.cursor) {
        query.cursor = params.cursor
      }
      return request<PublicCollectionPage>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(slug)}`,
        query,
        signal: params?.signal,
      })
    },

    async searchResources(params: SearchParams) {
      const query: Record<string, string | number | readonly string[] | undefined> = {
        q: params.q,
        type: params.types,
        cursor: params.cursor,
        limit: params.cursor ? undefined : params.limit,
      }
      return request<SearchPage>({
        method: 'GET',
        path: '/api/v1/search',
        query,
        headers: { Accept: 'application/json' },
        signal: params.signal,
      })
    },
  }
}
