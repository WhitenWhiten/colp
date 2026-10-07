import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProductSearchPublicClient, PUBLIC_COLLECTION_MAX_PAGES } from './product-client-search-public'
import { createProductTransport } from './product-transport'
import { getApiBaseUrl } from './config'

/**
 * The public-collection walk is serial by construction — each cursor comes from
 * the previous page — so the page count is the only bound standing between a
 * large collection and an unbounded chain of requests. The ceiling must fail
 * loudly: a truncated collection that looks complete is worse than an error.
 */
describe('public collection pagination ceiling', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('refuses to keep paging past the ceiling', async () => {
    const client = createProductSearchPublicClient(createProductTransport({ baseUrl: getApiBaseUrl() }))
    let pages = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // Honour the caller's cursor so the fixture is a coherent pager: sequence
      // must advance by one and node ids must not repeat, or a validation
      // before the ceiling rejects it first and the ceiling stays untested.
      const cursor = new URL(url, 'https://known.test').searchParams.get('cursor')
      pages = cursor === null ? 1 : Number(cursor.slice(2)) + 1
      return new Response(JSON.stringify({
        collection: { id: 'col-1', slug: 'research-notes', title: 'T', kind: 'bookmarks',
          rootNodeId: 'r', updatedAt: '2026-01-01T00:00:00.000Z', access: 'public' },
        nodes: [{ id: `n-${pages}`, parentId: 'r', kind: 'bookmark', title: 'x',
          url: 'https://e.test', position: 'a', description: null }],
        page: { cursor: `c-${pages}`, hasMore: true, sequence: pages },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    await expect(client.loadPublicCollectionSnapshot('research-notes'))
      .rejects.toThrow(new RegExp(`exceeds ${PUBLIC_COLLECTION_MAX_PAGES} pages`, 'u'))
    // It stopped rather than walking forever: the ceiling, not the data, ended it.
    expect(pages).toBeLessThanOrEqual(PUBLIC_COLLECTION_MAX_PAGES + 1)
  })
})


describe('public graph snapshot', () => {
  afterEach(() => vi.unstubAllGlobals())
  const collection = { id: 'c', slug: 'graph', title: 'Graph', rootNodeId: 'root', access: 'public' }
  const relation = { id: 'r', fromNodeId: 'a', toNodeId: 'b', type: 'supports', label: 'Evidence' }
  it('assembles relations after node pages and sends include on every continuation', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const query = new URL(url, 'https://known.test').searchParams
      expect(query.get('include')).toBe('relations')
      const second = query.has('cursor')
      return new Response(JSON.stringify({ collection, nodes: second ? [] : [{ id: 'a' }, { id: 'b' }],
        relations: second ? [relation] : [], page: { sequence: second ? 2 : 1, hasMore: !second, cursor: second ? null : 'next' },
      }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const client = createProductSearchPublicClient(createProductTransport({ baseUrl: getApiBaseUrl() }))
    const result = await client.loadPublicCollectionSnapshot('graph', { includeRelations: true, maxRetries: 0 })
    expect(result.relations).toEqual([relation])
    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects repeated relation IDs instead of publishing a partial graph', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ collection, nodes: [], relations: [relation, relation],
      page: { sequence: 1, hasMore: false, cursor: null },
    }), { headers: { 'content-type': 'application/json' } })))
    const client = createProductSearchPublicClient(createProductTransport({ baseUrl: getApiBaseUrl() }))
    await expect(client.loadPublicCollectionSnapshot('graph', { includeRelations: true, maxSnapshotRestarts: 0 })).rejects.toMatchObject({ code: 'invalid_cursor' })
  })
  it('does not misrepresent a legacy response as an empty graph', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ collection, nodes: [], page: { sequence: 1, hasMore: false, cursor: null } }), { headers: { 'content-type': 'application/json' } })))
    const client = createProductSearchPublicClient(createProductTransport({ baseUrl: getApiBaseUrl() }))
    await expect(client.loadPublicCollectionSnapshot('graph', { includeRelations: true, maxRetries: 0 })).rejects.toThrow('This server does not provide collection relations.')
    expect((await client.loadPublicCollectionSnapshot('graph')).relations).toBeUndefined()
  })
  it('discards earlier relations when a changed snapshot requires a restart', async () => {
    let request = 0
    const onCursorRestart = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 2) return new Response(JSON.stringify({ error: {
        code: 'snapshot_expired', message: 'changed', recovery: 'restart_from_first_page', sameRequestRetrySafe: false,
      } }), { status: 409, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ collection, nodes: [{ id: 'a' }, { id: 'b' }],
        relations: [{ ...relation, id: request === 1 ? 'obsolete' : 'current' }],
        page: { sequence: 1, hasMore: request === 1, cursor: request === 1 ? 'old-cursor' : null },
      }), { headers: { 'content-type': 'application/json' } })
    }))
    const client = createProductSearchPublicClient(createProductTransport({ baseUrl: getApiBaseUrl() }))
    const result = await client.loadPublicCollectionSnapshot('graph', { includeRelations: true, maxRetries: 0, maxSnapshotRestarts: 1, onCursorRestart })
    expect(result.relations?.map((edge) => edge.id)).toEqual(['current'])
    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(onCursorRestart).toHaveBeenCalledExactlyOnceWith({ reason: 'snapshot_expired', attempt: 1 })
    expect(request).toBe(3)
  })

})
