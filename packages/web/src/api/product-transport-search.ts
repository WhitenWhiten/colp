import type { components } from '../generated/product-v1'
import type { ProductTransportHttp } from './product-transport-http'
import type {
  PublicCollectionPageParams,
  PublicProfilePageParams,
  SearchParams,
} from './product-transport-types'
import type { ExplorePage, ExploreParams, PublicCollectionPage, PublicProfilePage, SearchPage } from './types'

type PublicProfileActivityPage = components['schemas']['PublicProfileActivityPage']

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

    async getPublicProfilePage(handle: string, params?: PublicProfilePageParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.limit != null) {
        query.limit = params.limit
      }
      if (params?.cursor) {
        query.cursor = params.cursor
      }
      return request<PublicProfilePage>({
        method: 'GET',
        path: `/api/v1/profiles/${encodeURIComponent(handle)}`,
        query,
        signal: params?.signal,
      })
    },

    async getPublicProfileActivity(handle: string, params?: PublicProfilePageParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else if (params?.limit != null) {
        query.limit = params.limit
      }
      return request<PublicProfileActivityPage>({
        method: 'GET',
        path: `/api/v1/profiles/${encodeURIComponent(handle)}/activity`,
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

    async listExploreCollections(params?: ExploreParams) {
      const query: Record<string, string | number | undefined> = {
        q: params?.q,
        tag: params?.tag,
        sort: params?.sort,
        language: params?.language,
        limit: params?.limit,
        cursor: params?.cursor,
      }
      return request<ExplorePage>({
        method: 'GET',
        path: '/api/v1/explore/collections',
        query,
        headers: { Accept: 'application/json' },
        signal: params?.signal,
      })
    },
  }
}
