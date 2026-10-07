import { describe, expect, it, vi } from 'vitest'
import type { SearchPage, SearchResourceType } from './types'
import { createProductTransport } from './product-transport'

const page: SearchPage = {
  query: 'design systems',
  types: ['collection', 'node'],
  items: [{
    resourceType: 'collection',
    resourceId: 'collection-1',
    title: 'Design systems',
    snippet: 'Patterns for product teams.',
    rank: 0.75,
  }],
  page: { returnedCount: 1, hasMore: true, nextCursor: 'cursor-2' },
  consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
}

describe('generated Search Product client boundary', () => {
  it('maps the generated DTO and repeated type query to the canonical route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = createProductTransport({ baseUrl: 'https://api.known.test', fetchImpl })
    const types: SearchResourceType[] = ['collection', 'node']

    await expect(client.searchResources({ q: 'design systems', types, limit: 12 })).resolves.toEqual(page)

    const [rawUrl, init] = fetchImpl.mock.calls[0]!
    const url = new URL(String(rawUrl))
    expect(url.pathname).toBe('/api/v1/search')
    expect(url.searchParams.get('q')).toBe('design systems')
    expect(url.searchParams.getAll('type')).toEqual(['collection', 'node'])
    expect(url.searchParams.get('limit')).toBe('12')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' })
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json')
  })

  it('continues with the same query and filters while omitting limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = createProductTransport({ baseUrl: 'https://api.known.test', fetchImpl })
    await client.searchResources({ q: 'design systems', types: ['profile'], cursor: 'signed cursor', limit: 99 })

    const url = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(url.searchParams.get('cursor')).toBe('signed cursor')
    expect(url.searchParams.getAll('type')).toEqual(['profile'])
    expect(url.searchParams.has('limit')).toBe(false)
  })

  it('forwards AbortSignal and maps 401, 429 Retry-After, and 503 errors', async () => {
    const responses = [
      new Response(JSON.stringify({ error: { code: 'authentication_required', message: 'Sign in', recovery: 'user_action' } }), { status: 401 }),
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down', recovery: 'same_request', sameRequestRetrySafe: true } }), { status: 429, headers: { 'Retry-After': '3' } }),
      new Response(JSON.stringify({ error: { code: 'feature_temporarily_unavailable', message: 'Unavailable', recovery: 'same_request', sameRequestRetrySafe: true } }), { status: 503 }),
    ]
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!)
    const client = createProductTransport({ fetchImpl })
    const controller = new AbortController()

    await expect(client.searchResources({ q: 'one', signal: controller.signal })).rejects.toMatchObject({ status: 401, code: 'authentication_required' })
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    await expect(client.searchResources({ q: 'two' })).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 3 })
    await expect(client.searchResources({ q: 'three' })).rejects.toMatchObject({ status: 503, code: 'feature_temporarily_unavailable' })
  })
})
