import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import {
  createMemorySessionStorage,
  installFetchMock,
  installSessionStorage,
  jsonResponse,
  productErrorBody,
  requestHeaders,
  requestPathAndSearch,
  resetProductSession,
} from './test-helpers'

const { getPublicProfileActivity } = productClient

const activityPage = {
  items: [{
    activityId: 'activity-1',
    kind: 'collection_change' as const,
    collectionId: 'collection-1',
    collectionTitle: 'Systems notes',
    publicationSlug: 'systems-notes',
    publishedAt: '2026-07-24T00:00:00.000Z',
    summary: null,
  }],
  nextCursor: 'activity-cursor-2',
}

describe('public Profile Activity Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    restoreFetch = undefined
    resetProductSession()
  })

  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
    vi.unstubAllEnvs()
  })

  it('loads generated public Profile activity with an encoded handle and bound cursor', async () => {
    const mock = installFetchMock(() => jsonResponse(activityPage))
    restoreFetch = mock.restore

    await expect(getPublicProfileActivity(
      { handle: 'mira chen', limit: 24 },
      { maxRetries: 0 },
    )).resolves.toEqual(activityPage)
    await expect(getPublicProfileActivity(
      { handle: 'mira chen', limit: 24, cursor: 'activity-cursor-2' },
      { maxRetries: 0 },
    )).resolves.toEqual(activityPage)

    const first = requestPathAndSearch(mock.calls[0]!)
    expect(first.pathname).toBe('/api/v1/profiles/mira%20chen/activity')
    expect(first.searchParams.get('limit')).toBe('24')
    expect(first.searchParams.has('cursor')).toBe(false)
    const continuation = requestPathAndSearch(mock.calls[1]!)
    expect(continuation.pathname).toBe('/api/v1/profiles/mira%20chen/activity')
    expect(continuation.searchParams.get('cursor')).toBe('activity-cursor-2')
    expect(continuation.searchParams.has('limit')).toBe(false)
    expect([...continuation.searchParams.keys()]).toEqual(['cursor'])
    expect(mock.calls.every((call) => call.init?.credentials === 'omit')).toBe(true)
    expect(mock.calls.every((call) => requestHeaders(call).get('Known-Command-Id') === null)).toBe(true)
    expect(mock.calls.every((call) => requestHeaders(call).get('X-CSRF-Token') === null)).toBe(true)
  })

  it('forwards abort signals and maps Product errors without a demo fallback', async () => {
    const mock = installFetchMock(() => jsonResponse(productErrorBody({
      code: 'feature_temporarily_unavailable',
      message: 'temporarily unavailable',
    }), { status: 503 }))
    restoreFetch = mock.restore
    const controller = new AbortController()

    await expect(getPublicProfileActivity(
      { handle: 'mira', cursor: 'sealed cursor' },
      { maxRetries: 0, signal: controller.signal },
    )).rejects.toMatchObject({
      status: 503,
      code: 'feature_temporarily_unavailable',
    })
    const request = requestPathAndSearch(mock.calls[0]!)
    expect(request.pathname).toBe('/api/v1/profiles/mira/activity')
    expect([...request.searchParams.keys()]).toEqual(['cursor'])
    expect(mock.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
  })
})
