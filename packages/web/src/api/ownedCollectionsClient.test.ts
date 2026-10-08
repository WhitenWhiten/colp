import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnedCollectionPage } from './types'
import { createProductTransport } from './product-transport'
import { productClient } from './productClient'

afterEach(() => vi.unstubAllGlobals())

function page(id: string, hasMore: boolean, nextCursor: string | null): OwnedCollectionPage {
  return {
    items: [{
      collection: {
        id, kind: 'bookmarks', title: `Collection ${id}`, summary: null,
        visibility: 'private', allowSearchIndexing: false, publicationSlug: null,
        publishedAt: null, rootNodeId: `root-${id}`, revision: `r-${id}`,
        etag: `\"r-${id}\"`, contentRevision: `c-${id}`, contentEtag: `\"c-${id}\"`,
        policyRevision: `p-${id}`, policyEtag: `\"p-${id}\"`,
        createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
      capabilities: { updateCollection: true, managePublication: true, createNode: true,
        updateNode: true, moveNode: true, deleteNode: true },
    }],
    page: { returnedCount: 1, hasMore, nextCursor },
  }
}

describe('generated owned Collections Product client boundary', () => {
  it('sends filters and limit only on the first page, then traverses cursor-only with signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('one', true, 'signed cursor/+')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('two', false, null)), { status: 200 }))
    const transport = createProductTransport({ baseUrl: 'https://api.known.test', fetchImpl })
    const signal = new AbortController().signal

    const first = await transport.listOwnedCollections({
      kind: 'knowledge_collection', visibility: 'protected', limit: 1, signal,
    })
    const second = await transport.listOwnedCollections({
      cursor: first.page.nextCursor!, kind: 'mixed', visibility: 'public', limit: 99, signal,
    })
    expect([...first.items, ...second.items].map((item) => item.collection.id)).toEqual(['one', 'two'])

    const firstUrl = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(firstUrl.searchParams.get('kind')).toBe('knowledge_collection')
    expect(firstUrl.searchParams.get('visibility')).toBe('protected')
    expect(firstUrl.searchParams.get('limit')).toBe('1')
    const nextUrl = new URL(String(fetchImpl.mock.calls[1]![0]))
    expect(nextUrl.searchParams.get('cursor')).toBe('signed cursor/+')
    expect([...nextUrl.searchParams.keys()]).toEqual(['cursor'])
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    expect(fetchImpl.mock.calls[1]![1]?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
  })

  it('keeps create Collection transport headers and body unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      collection: page('created', false, null).items[0]!.collection,
      root: { id: 'root-created' },
    }), { status: 201, headers: { ETag: '"r-created"' } }))
    const transport = createProductTransport({ baseUrl: 'https://api.known.test', fetchImpl })
    await transport.createCollection({ kind: 'bookmarks', title: 'Created', summary: null }, {
      commandIntentId: 'owned-list-regression', csrfToken: 'csrf-token',
    })
    const [, init] = fetchImpl.mock.calls[0]!
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-token')
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'bookmarks', title: 'Created', summary: null })
  })

  it('has the canonical productClient traverse two pages without replaying first-page filters', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('one', true, 'cursor-two')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('two', false, null)), { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    const signal = new AbortController().signal
    await expect(productClient.loadOwnedCollections({ kind: 'bookmarks', limit: 1 }, { signal, maxRetries: 0 }))
      .resolves.toHaveLength(2)
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('kind=bookmarks')
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('limit=1')
    expect(String(fetchImpl.mock.calls[1]![0])).toMatch(/\/api\/v1\/collections\?cursor=cursor-two$/)
    expect(fetchImpl.mock.calls[1]![1]?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
  })
})
