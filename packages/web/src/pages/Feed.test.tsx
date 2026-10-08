// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { FeedPage } from '../api/types'
import { Feed, feedItemCanonicalPath, itemTitle } from './Feed'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ feed: vi.fn(), enabled: true }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, isFeedExposureEnabled: () => mocks.enabled, productClient: { ...actual.productClient, getFeedPage: mocks.feed } }
})
const actor = { profileId: 'p1', handle: 'mira.writer', displayName: 'Mira', avatarUrl: null }
const collectionItem = {
  feedItemId: 'f1', kind: 'collection_change' as const, collectionId: 'public-id', actor,
  publishedAt: '2026-07-29T08:00:00.000Z', publicationSlug: 'llm-learning-path', collectionTitle: 'LLM learning path',
  summary: 'public_collection_updated',
}
const unpublishedCollectionItem = {
  feedItemId: 'f-unpublished', kind: 'collection_change' as const, collectionId: 'public-id', actor,
  publishedAt: '2026-07-29T08:00:00.000Z', publicationSlug: null, collectionTitle: null,
}
const encodedSlugItem = {
  ...collectionItem, feedItemId: 'f-encoded', publicationSlug: 'llm/learning-path',
}
const followItem = { feedItemId: 'f2', kind: 'follow_activity' as const, collectionId: null, actor, publishedAt: '2026-07-29T07:00:00.000Z', summary: 'new_follower' }
const hiddenItem = {
  feedItemId: 'f-hidden', kind: 'collection_change' as const, collectionId: 'public-id', actor,
  publishedAt: '2026-07-29T09:00:00.000Z', publicationSlug: null, collectionTitle: 'Collection hidden',
  summary: null, hiddenPublic: true,
}
const page: FeedPage = { items: [collectionItem, followItem], nextCursor: null }
describe('Feed page', () => {
  beforeEach(() => { vi.clearAllMocks(); clearRouteCache(); mocks.enabled = true; mocks.feed.mockResolvedValue(page); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } }); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function render() { mountTree(<MemoryRouter><Feed /></MemoryRouter>) }
  it('uses public canonical paths for collection and profile activity', () => {
    expect(feedItemCanonicalPath(collectionItem)).toBe('/c/llm-learning-path')
    expect(feedItemCanonicalPath(unpublishedCollectionItem)).toBe('/u/mira.writer')
    expect(feedItemCanonicalPath(unpublishedCollectionItem)).not.toBe('/c/public-id')
    expect(feedItemCanonicalPath(encodedSlugItem)).toBe(`/c/${encodeURIComponent('llm/learning-path')}`)
    expect(feedItemCanonicalPath(followItem)).toBe('/u/mira.writer')
    expect(itemTitle(collectionItem)).toBe('Mira updated LLM learning path')
    expect(itemTitle(unpublishedCollectionItem)).toBe('Mira updated a public collection')
    expect(itemTitle(followItem)).toBe('Mira followed your work')
  })

  it('shows loading, free filters, entries, keyboard controls, and canonical copy feedback', async () => {
    const pending: ((value: FeedPage) => void)[] = []
    // A slow endpoint: every mount read is held open, so the skeleton assertion
    // is about a genuinely pending request rather than the initial state.
    mocks.feed.mockImplementation(() => new Promise<FeedPage>((done) => { pending.push(done) }))
    render()
    expect(document.querySelector('[data-feed-state="loading"]')).not.toBeNull()
    await act(async () => { for (const done of pending) done(page) }); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toMatch(/Paid|paywall/iu)
    expect(document.querySelectorAll('[data-feed-item]')).toHaveLength(2)
    expect(document.body.textContent).toContain('Resources or path order changed')
    expect(document.body.textContent).not.toContain('public_collection_updated')
    expect(document.body.textContent).not.toContain('new_follower')
    const cards = document.querySelectorAll('[data-feed-item]')
    expect(cards[0]!.querySelector('[data-testid="feed-card-body"]')?.textContent).toContain('Resources or path order changed')
    expect(cards[1]!.querySelector('[data-testid="feed-card-body"]')).toBeNull()
    expect(document.querySelector('[data-testid="feed-card-actions"]')).not.toBeNull()
    // One way to pull new items: no separate Refresh beside it.
    expect(findButtonByName('Check for new items')).toBeTruthy()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Refresh')).toBe(false)
    const share = findButtonByName('Copy public link')
    share.focus(); expect(document.activeElement).toBe(share)
    act(() => share.click()); await waitForDom(domFinishedLoading)
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.querySelector('a[href="/c/public-id"]')).toBeNull()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://localhost:3000/c/llm-learning-path')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Copied public link')
  })

  it('renders error/retry and empty states without a sample-feed escape hatch', async () => {
    // The outage is a property of the endpoint, not of one call: every StrictMode
    // mount read must fail, otherwise mount #2 paints a success state.
    mocks.feed.mockRejectedValue(new Error('offline'))
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your feed")
    expect(document.querySelector('[data-testid="feed-controls"]')).toBeNull()
    // The server recovered; only the retry click issues the next request.
    mocks.feed.mockResolvedValue({ items: [], nextCursor: null })
    act(() => findButtonByName('Try again').click()); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Your feed is quiet')
    expect(document.body.textContent).not.toContain('sample feed')
  })

  it('does not paint unknown summary tokens as Feed body copy', async () => {
    const unknownItem = { ...collectionItem, feedItemId: 'f-unknown', summary: 'please_subscribe' }
    // Endpoint description: this page is the answer to every mount read.
    mocks.feed.mockResolvedValue({ items: [unknownItem], nextCursor: null })
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toContain('please_subscribe')
    expect(document.body.textContent).not.toContain('Resources or path order changed')
    expect(document.querySelector('[data-testid="feed-card-body"]')).toBeNull()
  })

  it('renders a moderation tombstone row without a link or actions (#21)', async () => {
    // Endpoint description: the tombstone page is the answer to every mount read.
    mocks.feed.mockResolvedValue({ items: [hiddenItem], nextCursor: null })
    render(); await waitForDom(domFinishedLoading)
    const card = document.querySelector('[data-collection-hidden]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Mira updated Collection hidden')
    expect(card!.querySelector('a[href^="/c/"]')).toBeNull()
    expect(card!.querySelector('[data-testid="feed-card-actions"]')).toBeNull()
    expect(card!.querySelector('a[href="/u/mira.writer"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="feed-card-body"]')).toBeNull()
    expect(document.querySelectorAll('[data-feed-item]')).toHaveLength(1)
  })

  it('names the actor once: the title carries the name, the actor line only the handle (R12-22)', async () => {
    mocks.feed.mockResolvedValue({ items: [collectionItem], nextCursor: null })
    render(); await waitForDom(domFinishedLoading)
    const card = document.querySelector('[data-feed-item]')!
    expect(card.textContent?.match(/Mira/g)).toHaveLength(1)
    const handles = [...card.querySelectorAll('a[href="/u/mira.writer"]')].map((link) => link.textContent)
    expect(handles).toContain('@mira.writer')
  })

  it('restarts from the first page when a Feed kind filter changes', async () => {
    // The reset is about the kind the request asks for, not about call order:
    // key the page by the filter input so both mount reads see the same "All" page.
    const byKind = new Map<string, FeedPage>([
      ['all', page],
      ['collection_change', { items: [collectionItem], nextCursor: null }],
    ])
    mocks.feed.mockImplementation((query: { kind?: string }) => Promise.resolve(byKind.get(query.kind ?? 'all')!))
    render(); await waitForDom(domFinishedLoading)
    act(() => findButtonByName('Collection changes').click()); await waitForDom(domFinishedLoading)
    expect(mocks.feed).toHaveBeenLastCalledWith({ kind: 'collection_change', limit: 20 }, expect.objectContaining({ maxRetries: 0 }))
    expect(document.querySelectorAll('[data-feed-item]')).toHaveLength(1)
  })

  it('auto-loads the next cursor page when the end of the stream intersects', async () => {
    class MockIntersectionObserver {
      static instance: MockIntersectionObserver | null = null
      readonly callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        MockIntersectionObserver.instance = this
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      trigger(isIntersecting: boolean) {
        this.callback(
          [{ isIntersecting } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
      }
    }
    const previous = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
    try {
      // Cursor-keyed endpoint: the first page asks without a cursor (mount may
      // ask twice), the next page is the answer for cursor-2 specifically.
      const pages = new Map<string, FeedPage>([
        ['first', { items: [collectionItem], nextCursor: 'cursor-2' }],
        ['cursor-2', { items: [followItem], nextCursor: null }],
      ])
      mocks.feed.mockImplementation((query: { cursor?: string }) => Promise.resolve(pages.get(query.cursor ?? 'first')!))
      render(); await waitForDom(domFinishedLoading)
      expect(document.querySelectorAll('[data-feed-item]')).toHaveLength(1)
      const callsAfterMount = mocks.feed.mock.calls.length
      act(() => MockIntersectionObserver.instance?.trigger(false)); await waitForDom(domFinishedLoading)
      // A non-intersecting notification must not issue another page request.
      expect(mocks.feed.mock.calls.length).toBe(callsAfterMount)
      act(() => MockIntersectionObserver.instance?.trigger(true)); await waitForDom(domFinishedLoading)
      expect(mocks.feed).toHaveBeenLastCalledWith({ cursor: 'cursor-2' }, expect.objectContaining({ maxRetries: 0 }))
      await waitForDom(() => document.querySelectorAll('[data-feed-item]').length === 2)
      expect(document.querySelectorAll('[data-feed-item]')).toHaveLength(2)
    } finally {
      if (previous) globalThis.IntersectionObserver = previous
      else delete (globalThis as Record<string, unknown>).IntersectionObserver
    }
  })
})
