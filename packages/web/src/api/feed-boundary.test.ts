// @vitest-environment happy-dom
/* P5-14 Feed frontend boundary.
 *
 * Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the Feed workflow reaches the Product API through the
 *    canonical client (never a hand-rolled request), passes the accepted
 *    query, cancels the in-flight request on unmount, surfaces a failure
 *    instead of falling back to mock rows, and shares only the public
 *    canonical URL. Proven by driving the real hook/page with the client
 *    mocked.
 *
 * 2. Architecture — an *absent* import (no mock/legacy fallback, no copied
 *    Feed DTO, no commercial surface) and *endpoint ownership* (the feed
 *    route string lives in the generated runtime, not in this tree). Neither
 *    is falsifiable by running code: an unused import changes no observable
 *    behaviour until the fallback is actually taken, and the endpoint a
 *    request lands on is identical whether the URL was built by the generated
 *    runtime or copied by hand. Those assertions are therefore kept, but
 *    anchored on module specifiers and route literals rather than on
 *    arbitrary substrings of formatting.
 */
import { act, createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import { Feed } from '../pages/Feed'
import { useProductFeed } from '../lib/useProductFeed'
import feedWorkflowSource from '../lib/useProductFeed.ts?raw'
import feedPageSource from '../pages/Feed.tsx?raw'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'
import { FEATURE_FLAGS, isFeedExposureEnabled, isLive } from './featureFlags'
import featureFlagsSource from './featureFlags.ts?raw'
import mockSource from './mock-data.ts?raw'
import productClientSource from './productClient.ts?raw'
import { installFetchMock } from './test-helpers'
import type { FeedItem, FeedPage } from './types'

const mocks = vi.hoisted(() => ({ enabled: true, feed: vi.fn() }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    /* The page reads the exposure switch through the api barrel; the switch
       itself is asserted against the real featureFlags module below. */
    isFeedExposureEnabled: () => mocks.enabled,
    productClient: { ...actual.productClient, getFeedPage: mocks.feed },
  }
})

/* Production client modules only. `productClient.ts` owns the singleton and
   `product-client-*.ts` are the domain bridges. */
const clientDomainSources = Object.values(import.meta.glob('./product-client-*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const clientSources = [productClientSource, ...clientDomainSources].join('\n')

const actor = { profileId: 'p1', handle: 'mira.writer', displayName: 'Mira', avatarUrl: null }
const publishedItem: FeedItem = {
  feedItemId: 'feed-1',
  kind: 'collection_change',
  collectionId: 'private-collection-id',
  actor,
  publishedAt: '2026-07-29T08:00:00.000Z',
  publicationSlug: 'llm-learning-path',
  collectionTitle: 'LLM learning path',
  summary: 'public_collection_updated',
}
const page: FeedPage = { items: [publishedItem], nextCursor: null }

describe('P5-14 Feed frontend boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    mocks.enabled = true
    mocks.feed.mockResolvedValue(page)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  describe('Feed workflow behaviour', () => {
    let current!: ReturnType<typeof useProductFeed>

    function Probe({ enabled = true, kind }: { enabled?: boolean; kind?: FeedItem['kind'] }) {
      current = useProductFeed({ enabled, kind, limit: 12 })
      return null
    }
    function renderProbe(enabled = true, kind?: FeedItem['kind']) {
      /* createElement rather than JSX: this suite is a `.ts` boundary scan and
         keeping the extension keeps the collected suite identity stable. */
      mountTree(createElement(Probe, { enabled, kind }))
    }
    const settledFeed = () => current != null
      && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking'

    it('loads the first page through the canonical Product client, never a raw fetch', async () => {
      const rawFetch = installFetchMock(() => {
        throw new Error('the Feed boundary must not issue its own request')
      })
      try {
        renderProbe(true, 'collection_change')
        await waitForDom(settledFeed)
        expect(mocks.feed).toHaveBeenCalledWith(
          { kind: 'collection_change', limit: 12 },
          expect.objectContaining({ maxRetries: 0 }),
        )
        /* Every call carries the caller's cancellation signal. */
        for (const call of mocks.feed.mock.calls) {
          expect(call[1]?.signal).toBeInstanceOf(AbortSignal)
        }
        expect(current.items.map((item) => item.feedItemId)).toEqual(['feed-1'])
        /* A hand-rolled fetch to /api/v1/feed would show up here. */
        expect(rawFetch.calls).toEqual([])
      } finally {
        rawFetch.restore()
      }
    })

    it('aborts the in-flight Feed request on unmount', async () => {
      const signals: AbortSignal[] = []
      mocks.feed.mockImplementation((_query: unknown, options: { signal?: AbortSignal }) => {
        signals.push(options.signal!)
        return new Promise<FeedPage>(() => {})
      })
      renderProbe()
      await waitForDom(() => signals.length > 0)
      expect(signals[signals.length - 1]!.aborted).toBe(false)
      cleanup()
      expect(signals.length).toBeGreaterThan(0)
      for (const signal of signals) expect(signal.aborted).toBe(true)
    })

    it('surfaces a failed load as an error instead of substituting mock rows', async () => {
      mocks.feed.mockRejectedValue(new Error('network down'))
      renderProbe()
      await waitForDom(settledFeed)
      expect(current.state).toBe('error')
      expect(current.items).toEqual([])
      expect(current.hasMore).toBe(false)
    })
  })

  describe('Feed page behaviour', () => {
    function renderFeed() {
      mountTree(createElement(MemoryRouter, null, createElement(Feed)))
    }

    it('copies the public canonical URL and never the private locator', async () => {
      renderFeed()
      await waitForDom(() => document.querySelector('[data-feed-item]') !== null)
      const copy = findButtonByName('Copy public link')
      act(() => copy.click())
      await waitForDom(() => (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls.length > 0)
      const [copied] = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(copied).toBe(new URL('/c/llm-learning-path', window.location.origin).href)
      /* The private collection id, the feed item id and any cursor must not
         travel with the shared link. */
      expect(copied).not.toContain('private-collection-id')
      expect(copied).not.toContain('feed-1')
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('ships the accepted rollout live with an acceptance override', () => {
      /* Behavioural half: the switch the pages call really is on. */
      expect(FEATURE_FLAGS.feed).toBe(true)
      expect(isLive('feed')).toBe(true)
      expect(isFeedExposureEnabled()).toBe(true)
      /* The VITE_FEED_ACCEPTANCE override short-circuits behind the live flag,
         so no run can observe it from outside; assert the wiring by name. */
      expect(featureFlagsSource).toContain('VITE_FEED_ACCEPTANCE')
    })

    it('keeps the Feed endpoint owned by the generated runtime', () => {
      /* The boundary is that the web tree never spells the feed route: the URL
         is built by @known/product-v1-client. Asserting the route literal is
         gone is rename-proof and catches a hand-rolled request that the old
         `fetch(...)` regex missed (template literals, URL objects, helpers). */
      expect(clientSources).not.toMatch(/\/api\/v1\/feed/u)
      expect(clientSources).toContain('createProductFeedClient')
      expect(clientSources).toContain('ProductFeedPage')
    })

    it('keeps mock, legacy and commercial fallbacks out of the Feed surface', () => {
      /* An unused import cannot be observed by running code, so assert the
         module specifier and the exact fallback mechanism (`mockOrLive`). A
         rename of an unrelated identifier cannot break this; adding a real
         mock/legacy fallback always does. */
      const forbiddenFallback = /from ['"][^'"]*(?:mock-data|legacy-demo)[^'"]*['"]|\bmockOrLive\b|\bsocialFeed\b/u
      const forbiddenCommercial = /\b(?:billing|checkout|monetization|paid|payment|paywall|pricing|revenue|payouts?|subscriptions?)\b/iu
      for (const [name, source] of [['Feed page', feedPageSource], ['useProductFeed', feedWorkflowSource]] as const) {
        expect(source, name).not.toMatch(forbiddenFallback)
        expect(source, name).not.toMatch(forbiddenCommercial)
      }
      /* Demo data must not reach back into the live Feed page. */
      expect(mockSource).not.toMatch(/from ['"][^'"]*pages\/Feed['"]/u)
    })

    it('keeps the Feed page out of cursor, grant and private-URL plumbing', () => {
      /* The page hands pagination to the hook and shares only the canonical
         path built from `window.location.origin` (proven behaviourally above).
         Widening it to the current private URL, a grant token, or the cursor
         is an absence in the module, not a reachable state. */
      expect(feedPageSource).not.toMatch(/access.?grant|social.?token|window\.location\.href|searchParams/iu)
      expect(feedPageSource).not.toContain('nextCursor')
      expect(feedPageSource).toContain('feedItemCanonicalPath')
    })
  })
})
