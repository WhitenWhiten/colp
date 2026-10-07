import { describe, expect, it, vi } from 'vitest'
import type { FeedPage } from './types'
import { productClient } from './productClient'

const page: FeedPage = {
  items: [{
    feedItemId: 'feed-1', kind: 'collection_change', collectionId: 'collection-1',
    actor: { profileId: 'profile-1', handle: 'mira', displayName: 'Mira', avatarUrl: null },
    publishedAt: '2026-07-29T08:00:00.000Z',
  }],
  nextCursor: 'private-cursor',
}

describe('generated Feed Product client boundary', () => {
  it('maps first-page filters and credentials through the generated runtime', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(page), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const controller = new AbortController()
    await expect(productClient.getFeedPage({ kind: 'collection_change', limit: 12 }, { maxRetries: 0, signal: controller.signal })).resolves.toEqual(page)
    const [rawUrl, init] = fetchMock.mock.calls[0]!
    const url = new URL(String(rawUrl))
    expect(url.pathname).toBe('/api/v1/feed')
    expect(url.searchParams.get('kind')).toBe('collection_change')
    expect(url.searchParams.get('limit')).toBe('12')
    expect(init).toMatchObject({ credentials: 'omit' })
    expect(init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    fetchMock.mockRestore()
  })

  it('continues with only the opaque cursor and maps Product errors without fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'feature_temporarily_unavailable', message: 'Unavailable', recovery: 'same_request', sameRequestRetrySafe: true },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    await expect(productClient.getFeedPage({ cursor: 'sealed cursor' }, { maxRetries: 0 })).rejects.toMatchObject({
      status: 503, code: 'feature_temporarily_unavailable',
    })
    const url = new URL(String(fetchMock.mock.calls[0]![0]))
    expect([...url.searchParams.keys()]).toEqual(['cursor'])
    fetchMock.mockRestore()
  })
})
