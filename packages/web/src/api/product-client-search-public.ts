import type { components } from '../generated/product-v1'
import { shouldRestartCursor } from './editor-session'
import { ProductApiError, wrapProductError } from './errors'
import { withSameRequestRetry, type ReadOptions } from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type {
  ExplorePage,
  ExploreParams,
  PublicCollectionPage,
  PublicCollectionSnapshot,
  PublicProfilePage,
  SearchPage,
  SearchResourceType,
} from './types'

type PublicProfileActivityPage = components['schemas']['PublicProfileActivityPage']

const DEFAULT_PUBLIC_COLLECTION_LIMIT = 100
/**
 * Page ceiling for one public collection: 1_000 pages, or 100_000 nodes at the
 * default page size. Far above any real collection, far below an unbounded
 * serial chain.
 */
export const PUBLIC_COLLECTION_MAX_PAGES = 1_000

export function createProductSearchPublicClient(transport: ProductTransport) {
  async function getPublicCollectionPage(
    slug: string,
    params?: { limit?: number; cursor?: string; includeRelations?: boolean },
    options?: ReadOptions,
  ): Promise<PublicCollectionPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getPublicCollectionPage(slug, {
          ...params,
          signal: options?.signal,
        })
      } catch (err) {
        throw wrapProductError(err)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getPublicProfilePage(
    handle: string,
    params?: { limit?: number; cursor?: string },
    options?: ReadOptions,
  ): Promise<PublicProfilePage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getPublicProfilePage(handle, {
          ...params,
          signal: options?.signal,
        })
      } catch (err) {
        throw wrapProductError(err)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getPublicProfileActivity(
    query: { handle: string; limit?: number; cursor?: string },
    options?: ReadOptions,
  ): Promise<PublicProfileActivityPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getPublicProfileActivity(query.handle, {
          ...(query.cursor ? { cursor: query.cursor } : { limit: query.limit }),
          signal: options?.signal,
        })
      } catch (err) {
        throw wrapProductError(err)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function searchResources(
    params: { q: string; types?: SearchResourceType[]; limit?: number; cursor?: string },
    options?: ReadOptions,
  ): Promise<SearchPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.searchResources({ ...params, signal: options?.signal })
      } catch (err) {
        throw wrapProductError(err)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getExploreCollections(
    params: ExploreParams = {},
    options?: ReadOptions,
  ): Promise<ExplorePage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.listExploreCollections({ ...params, signal: options?.signal })
      } catch (err) {
        throw wrapProductError(err)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function invalidPublicCursor(message: string): ProductApiError {
    return new ProductApiError({
      status: 400,
      code: 'invalid_cursor',
      message,
      recovery: 'restart_from_first_page',
      sameRequestRetrySafe: false,
    })
  }

  function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`
  }

  function assertPublicPageState(
    page: PublicCollectionPage['page'],
    expectedSequence: number,
  ): void {
    if (!Number.isSafeInteger(page.sequence) || page.sequence !== expectedSequence) {
      throw invalidPublicCursor('Public collection pagination returned a discontinuous sequence.')
    }
    const cursorIsConsistent = page.hasMore
      ? typeof page.cursor === 'string' && page.cursor.length > 0
      : page.cursor === null
    if (!cursorIsConsistent) {
      throw invalidPublicCursor('Public collection pagination returned an inconsistent continuation.')
    }
  }

  function appendUniquePublicNodes(
    target: PublicCollectionPage['nodes'],
    incoming: PublicCollectionPage['nodes'],
    seenNodeIds: Set<string>,
  ): void {
    for (const node of incoming) {
      if (seenNodeIds.has(node.id)) {
        throw invalidPublicCursor('Public collection pagination returned an overlapping node.')
      }
      seenNodeIds.add(node.id)
      target.push(node)
    }
  }

  /** Load a complete public/member tree without exposing partial page results. */
  async function loadPublicCollectionSnapshot(
    slug: string,
    options?: ReadOptions & {
      limit?: number
      includeRelations?: boolean
      maxSnapshotRestarts?: number
      onCursorRestart?: (event: {
        reason: 'snapshot_expired' | 'invalid_cursor'
        attempt: number
      }) => void
    },
  ): Promise<PublicCollectionSnapshot> {
    const limit = options?.limit ?? DEFAULT_PUBLIC_COLLECTION_LIMIT
    const maxRestarts = options?.maxSnapshotRestarts ?? 3
    let restarts = 0

    for (;;) {
      try {
        const include = options?.includeRelations ? { includeRelations: true } : {}
        const first = await getPublicCollectionPage(slug, { limit, ...include }, options)
        const collection = first.collection
        const collectionIdentity = stableJson(collection)
        const nodes: PublicCollectionPage['nodes'] = []
        const relations: NonNullable<PublicCollectionSnapshot['relations']> = []
        const seenRelationIds = new Set<string>()
        const appendRelations = (incoming: PublicCollectionPage) => {
          if (options?.includeRelations && !Array.isArray(incoming.relations)) {
            throw new Error('This server does not provide collection relations. Please update the server and retry.')
          }
          for (const relation of incoming.relations ?? []) {
            if (seenRelationIds.has(relation.id)) throw invalidPublicCursor('Public collection pagination returned an overlapping relation.')
            seenRelationIds.add(relation.id)
            relations.push(relation)
          }
        }
        appendRelations(first)
        const seenNodeIds = new Set<string>()
        const seenCursors = new Set<string>()
        let page = first.page
        let expectedSequence = 1

        assertPublicPageState(page, expectedSequence)
        appendUniquePublicNodes(nodes, first.nodes, seenNodeIds)

        // A public collection is walked cursor by cursor, so the page count is
        // the only thing standing between a large collection and an unbounded
        // serial request chain. The ceiling is a failure, not a silent
        // truncation: a half-loaded collection that looks complete is worse than
        // a loud error the caller can surface.
        let pagesFetched = 1
        while (page.hasMore) {
          pagesFetched += 1
          if (pagesFetched > PUBLIC_COLLECTION_MAX_PAGES) {
            throw invalidPublicCursor(
              `Public collection exceeds ${PUBLIC_COLLECTION_MAX_PAGES} pages; refusing to keep paging.`)
          }
          const cursor = page.cursor!
          if (seenCursors.has(cursor)) {
            throw invalidPublicCursor('Public collection pagination returned an invalid continuation.')
          }
          seenCursors.add(cursor)
          const next = await getPublicCollectionPage(slug, { limit, cursor, ...include }, options)
          if (stableJson(next.collection) !== collectionIdentity) {
            throw invalidPublicCursor('Public collection continuation changed representation.')
          }
          expectedSequence += 1
          assertPublicPageState(next.page, expectedSequence)
          appendUniquePublicNodes(nodes, next.nodes, seenNodeIds)
          appendRelations(next)
          page = next.page
        }

        return { collection, nodes, page, ...(options?.includeRelations ? { relations } : {}) }
      } catch (err) {
        const apiErr = wrapProductError(err)
        if (shouldRestartCursor(apiErr) && restarts < maxRestarts) {
          restarts += 1
          options?.onCursorRestart?.({
            reason: apiErr.code as 'snapshot_expired' | 'invalid_cursor',
            attempt: restarts,
          })
          continue
        }
        throw apiErr
      }
    }
  }

  return {
    getPublicCollectionPage,
    getPublicProfilePage,
    getPublicProfileActivity,
    searchResources,
    getExploreCollections,
    loadPublicCollectionSnapshot,
  }
}
