// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionSnapshot } from '../api/types'
import { collectLayeredRules, readStyle } from '../styles/dashboard-stack-cascade.test-helper'
import { cleanup, domFinishedLoading, findButtonByName, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'
import {
  bookmark,
  captureSearch,
  deferred,
  insightPayloads,
  mocks,
  previewObservers,
  renderCollection,
  rootNode,
  setUpCollectionPage,
  snapshot,
  tearDownCollectionPage,
} from './Collection.test-helper'

const communityGate = vi.hoisted(() => ({ enabled: false }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks } = await import('./Collection.test-mocks')
  return {
    ...actual,
    isCommunityExposureEnabled: () => communityGate.enabled,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      recordPublicCollectionInsightEvent: mocks.recordPublicCollectionInsightEvent,
      getPublicProfilePage: mocks.getPublicProfilePage,
      getFollowersPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getFollowingPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      createCollectionNode: mocks.createCollectionNode,
      getCollectionFollowState: mocks.getCollectionFollowState,
      followCollection: mocks.followCollection,
      unfollowCollection: mocks.unfollowCollection,
      abandonCollectionFollowIntent: mocks.abandonCollectionFollowIntent,
      resolveCommunityTarget: mocks.resolveCommunityTarget,
      setCommunityVote: mocks.setCommunityVote,
      abandonCommunityVoteIntent: mocks.abandonCommunityVoteIntent,
      getCommunityComments: mocks.getCommunityComments,
    },
  }
})

vi.mock('../lib/useOwnedCollections', () => ({
  useOwnedCollections: () => ({
    state: 'ready' as const,
    items: [
      {
        collection: { id: 'col-own-aaaaaaaaaaaaA', title: 'My shelf' },
        capabilities: { createNode: true },
        bookmarkCount: 3,
      },
    ] as unknown as import('../api').OwnedCollectionListItem[],
    message: '',
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
  }),
}))

vi.mock('../components/AppToast', async () => {
  const { mocks } = await import('./Collection.test-mocks')
  return {
    useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

describe('public Collection page', () => {
  beforeEach(setUpCollectionPage)
  beforeEach(() => { communityGate.enabled = false })
  afterEach(tearDownCollectionPage)

  it('keeps the tree hidden until the complete snapshot resolves, including during restart', async () => {
    installPageMetaBaseline({
      description: 'Origin-injected collection description.',
      canonical: 'https://know-n.com/c/research-notes',
      ogUrl: 'https://know-n.com/c/research-notes',
      ogTitle: 'Origin-injected collection — Know-N',
    })
    const pending = deferred<PublicCollectionSnapshot>()
    // The endpoint reports the cursor restart on every read and keeps the same
    // request pending: StrictMode's remount must see the restarting state too.
    mocks.loadPublicCollectionSnapshot.mockImplementation((_slug, options) => {
      options.onCursorRestart({ reason: 'snapshot_expired', attempt: 1 })
      return pending.promise
    })

    renderCollection()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Refreshing the collection snapshot')
    expect(document.body.textContent).not.toContain('First source')
    expect(document.querySelector('[data-testid="public-collection-page"]')).toBeNull()
    expect(pageMetaContent('meta[name="description"]')).toBe('Origin-injected collection description.')
    expect(canonicalHref()).toBe('https://know-n.com/c/research-notes')
    expect(pageMetaContent('meta[property="og:url"]')).toBe('https://know-n.com/c/research-notes')
    expect(robotsContents()).toEqual([])
    expect(document.head.querySelector('[data-page-meta-owned="true"]')).toBeNull()

    await act(async () => pending.resolve(snapshot()))
    expect(document.body.textContent).toContain('Research notes')
    expect(document.body.textContent).toContain('First source')
  })

  it('uses the same concealed state for not-found and withdrawn collections', async () => {
    installPageMetaBaseline()
    // A withdrawn collection stays withdrawn however many times the endpoint
    // is re-read: StrictMode remounts, so this must not be a one-shot rejection.
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))

    renderCollection('/c/withdrawn-slug')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Collection unavailable')
    expect(document.body.textContent).toContain('not found, has been withdrawn, or is not available')
    expect(document.querySelector('[role="status"] h1')?.textContent).toBe('Collection unavailable')
    expect(document.querySelector('[role="status"]')?.classList.contains('not-found-stage')).toBe(true)
    expect([...document.querySelectorAll('[data-testid="not-found-corner"]')].map((node) => node.textContent)).toEqual(['Collection', 'Page', 'Not', 'Here'])
    expect(document.body.textContent).not.toContain('withdrawn-slug')
    expect(mocks.recordPublicCollectionInsightEvent).not.toHaveBeenCalled()
    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('uses the published summary and collection canonical in the runtime head', async () => {
    installPageMetaBaseline()
    // The snapshot endpoint answers every mount with this projection:
    // StrictMode's remount re-reads it, so the fixture must not be a one-shot
    // queue (a dried-up queue leaves the page loading forever).
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(pageMetaContent('meta[name="description"]')).toBe('A maintained map of primary sources and practical references.')
    expect(canonicalHref()).toBe('https://know-n.com/c/research-notes')
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(pageMetaContent('meta[property="og:description"]')).toBe(pageMetaContent('meta[name="description"]'))
    expect(pageMetaContent('meta[property="og:url"]')).toBe(canonicalHref())
    expect(robotsContents()).toEqual([])
  })

  it('renders an explicit empty state when only the published root is visible', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([rootNode()]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Nothing published yet')
    expect(document.querySelector('[data-collection-field="bookmarks"]')?.textContent).toBe('0')
  })

  it('restores view switching and client-side filtering without replacing API data', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('Alpha reference'),
      bookmark('Beta reference'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const listButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'List')
    if (!listButton) throw new Error('List button missing')
    await act(async () => listButton.click())
    expect(listButton.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-collection-view="list"]')).not.toBeNull()
    expect(document.querySelector('[data-collection-view="list"] .library-bookmark--comfort')).not.toBeNull()

    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter bookmarks"]')
    if (!input) throw new Error('Filter input missing')
    expect(input.placeholder).toBe('Filter by title, description, host, or folder…')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'beta')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('Alpha reference')
    expect(document.body.textContent).toContain('Beta reference')
    expect(captureSearch).toContain('view=list')
    expect(captureSearch).toContain('q=beta')
  })

  it('LP-06: Gallery renders same-origin covers in curated order and keeps other cards text-only', async () => {
    const cover = { url: `${window.location.origin}/api/v1/link-preview/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`, width: 1200, height: 630 }
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { ...bookmark('Alpha'), previewImage: cover },
      { ...bookmark('Beta'), previewImage: null },
      // A foreign URL must never become a hotlinked cover.
      { ...bookmark('Gamma'), previewImage: { url: 'https://evil.example/x.png', width: 400, height: 200 } },
    ]))
    renderCollection('/c/research-notes?view=gallery')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="public-collection-page"]')?.getAttribute('data-view')).toBe('gallery')
    const cards = [...document.querySelectorAll<HTMLElement>('[data-collection-view="gallery"] [role="list"] > [data-gallery-card]')]
    expect(cards.map((card) => card.getAttribute('data-node-id'))).toEqual(['Alpha', 'Beta', 'Gamma'])
    const images = [...document.querySelectorAll<HTMLImageElement>('[data-gallery-cover] img')]
    expect(images).toHaveLength(1)
    expect(images[0]!.getAttribute('src')).toBe(cover.url)
    expect(images[0]!.getAttribute('width')).toBe('1200')
    expect(images[0]!.getAttribute('height')).toBe('630')
    expect(images[0]!.getAttribute('loading')).toBe('lazy')
    expect(images[0]!.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(cards[0]!.contains(images[0]!)).toBe(true)

    const galleryButton = await findButtonByName('Gallery')
    expect(galleryButton.getAttribute('aria-checked')).toBe('true')
    const boardButton = await findButtonByName('Board')
    await act(async () => boardButton.click())
    expect(document.querySelector('[data-gallery-cover]')).toBeNull()
    await act(async () => galleryButton.click())
    expect(captureSearch).toContain('view=gallery')
  })

  it('renders public tldr/note snippets when snapshot nodes carry them', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('First source'),
      {
        ...bookmark('Marked source'),
        tldr: 'One-sentence takeaway a reader can trust',
        note: 'Why this one matters, from the curator',
      },
    ]))
    renderCollection('/c/research-notes?view=list')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-collection-view="list"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="bookmark-tldr"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="bookmark-note"]')).not.toBeNull()
    expect(document.body.textContent).toContain('One-sentence takeaway a reader can trust')
    expect(document.body.textContent).toContain('Why this one matters, from the curator')
    // The unmarked sibling keeps no snippet blocks.
    expect(document.body.textContent).toContain('First source')
  })

  it('renders a moderation-hidden bookmark as an inert tombstone in place', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('First source', 'root-1', 'https://example.com/reference'),
      /* The server nulls url/description and swaps the title (S1b) — the
         client renders the placeholder, never the original. */
      { ...bookmark('Bookmark hidden', 'root-1', null), description: null, state: 'hidden' },
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    // Board: the tombstone card stays in position, muted, with no detail link.
    expect(document.body.textContent).toContain('Bookmark hidden')
    const tombstoneCard = document.querySelector('article[data-resource-hidden]')
    expect(tombstoneCard).not.toBeNull()
    expect(tombstoneCard?.textContent).toContain('Bookmark hidden')
    expect(tombstoneCard?.textContent).not.toContain('Link unavailable')
    expect(tombstoneCard?.querySelector('a')).toBeNull()
    const detailHrefs = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-resource-detail]')]
      .map((link) => link.getAttribute('href'))
    expect(detailHrefs).toEqual(['/r/First%20source?subjectType=node&slug=research-notes'])
    expect(document.querySelectorAll('[data-collection-resource-link]')).toHaveLength(1)

    // List rows: the tombstone is an inert span; the sibling keeps its link.
    const listButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'List')
    if (!listButton) throw new Error('List button missing')
    await act(async () => listButton.click())
    const listLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-view="list"] a.library-bookmark')]
    expect(listLinks.map((row) => row.getAttribute('href'))).toEqual([
      '/r/First%20source?subjectType=node&slug=research-notes',
    ])
    const tombstoneRow = document.querySelector('[data-collection-view="list"] [data-resource-hidden]')
    expect(tombstoneRow?.querySelector('a')).toBeNull()
    expect(tombstoneRow?.textContent).toContain('Bookmark hidden')
  })

  it('returns to board after list or compact without leaving a view query', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('Alpha reference'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const viewButton = (label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === label)
      if (!button) throw new Error(`${label} button missing`)
      return button
    }

    await act(async () => viewButton('List').click())
    expect(document.querySelector('[data-collection-view="list"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="public-collection-page"]')?.getAttribute('data-view')).toBe('list')
    expect(captureSearch).toContain('view=list')

    await act(async () => viewButton('Board').click())
    expect(viewButton('Board').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-collection-view="board"]')).not.toBeNull()
    expect(captureSearch).not.toContain('view=')

    await act(async () => viewButton('Compact').click())
    expect(document.querySelector('[data-collection-view="compact"]')).not.toBeNull()

    await act(async () => viewButton('Board').click())
    expect(viewButton('Board').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-collection-view="board"]')).not.toBeNull()
    expect(captureSearch).not.toContain('view=')
  })

  it('hydrates view and filter from the URL', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('Alpha reference'),
      bookmark('Beta reference'),
    ]))
    renderCollection('/c/research-notes?view=list&q=Beta')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-collection-view="list"]')).not.toBeNull()
    expect(document.querySelector<HTMLInputElement>('[aria-label="Filter bookmarks"]')?.value).toBe('Beta')
    expect(document.body.textContent).not.toContain('Alpha reference')
    expect(document.body.textContent).toContain('Beta reference')
  })

  it('records exactly one collection_view when the snapshot is ready', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="public-collection-page"]')).not.toBeNull()
    expect(insightPayloads().filter((payload) => payload.eventType === 'collection_view')).toEqual([
      { slug: 'research-notes', eventType: 'collection_view' },
    ])
  })

  it('does not ingest when the page unmounts before the snapshot is ready', async () => {
    const pending = deferred<PublicCollectionSnapshot>()
    // Still-pending on every read, so the remount observes the same in-flight load.
    mocks.loadPublicCollectionSnapshot.mockImplementation(() => pending.promise)
    renderCollection()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Assembling the complete collection')
    expect(document.querySelector('[data-testid="public-collection-loading"] h1')?.textContent).toBe('Loading collection')
    expect(document.querySelector('[data-testid="public-collection-loading"] .section-label')?.textContent).toBe('Public collection')

    act(() => {
      cleanup()
          })
    await act(async () => pending.resolve(snapshot()))
    await waitForDom(domFinishedLoading)

    expect(mocks.recordPublicCollectionInsightEvent).not.toHaveBeenCalled()
  })

  it('paints a masthead-shaped skeleton with visible bones while loading', async () => {
    const pending = deferred<PublicCollectionSnapshot>()
    // Still-pending on every read, so the remount paints the same skeleton.
    mocks.loadPublicCollectionSnapshot.mockImplementation(() => pending.promise)
    renderCollection()
    await waitForDom(domFinishedLoading)

    // Masthead-height placeholder: bones for title/lede/stats plus card
    // frames, so the resolved snapshot does not jump the layout.
    expect(document.querySelector('[data-testid="public-collection-loading"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="public-collection-loading"] .collection-skeleton-masthead .collection-skeleton-title')).not.toBeNull()
    expect(document.querySelectorAll('[data-testid="public-collection-loading"] .collection-skeleton-board .collection-skeleton-card').length).toBeGreaterThan(2)
    expect(document.querySelector('[data-testid="public-collection-loading"] [role="status"]')?.getAttribute('role')).toBe('status')

    // Bones are the shared .skeleton-block, painted at a visible grey (not
    // the old near-white shimmer) — the same bone as the route fallback.
    const board = document.querySelector('[data-testid="public-collection-loading"] [data-testid="collection-skeleton-board"]')!
    expect([...board.children].every((card) => card.classList.contains('skeleton-block'))).toBe(true)
    const bone = collectLayeredRules(readStyle('skeleton.css'))
      .find((rule) => rule.selector === '.skeleton-block')
    expect(bone, 'shared skeleton bone rule must exist in skeleton.css').toBeTruthy()
    expect(bone!.body).toMatch(/color-mix\(in srgb, var\(--ink\) 6%, var\(--paper\)\)/)

    await act(async () => pending.resolve(snapshot()))
    expect(document.querySelector('[data-testid="public-collection-loading"]')).toBeNull()
    expect(document.body.textContent).toContain('First source')
  })

  it('does not ingest when the collection is unavailable', async () => {
    // Unavailable is the endpoint's answer, not a per-mount event.
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))
    renderCollection('/c/missing-notes')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Collection unavailable')
    expect(mocks.recordPublicCollectionInsightEvent).not.toHaveBeenCalled()
  })

  it('shows an error card, not the absence poster, when the snapshot fails to load', async () => {
    // StrictMode replays the mount effect, so the rejection must persist.
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new Error('network'))
    renderCollection('/c/flaky-notes')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[role="alert"] h1')?.textContent).toBe("Couldn't load this collection")
    expect(findButtonByName('Try again')).toBeTruthy()
    expect(document.querySelector('[data-testid="absence-stage"]')).toBeNull()
    expect(mocks.recordPublicCollectionInsightEvent).not.toHaveBeenCalled()
  })

  it('records one preview_open the first time the resource list intersects', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)

    const observer = previewObservers().at(-1)
    if (!observer) throw new Error('preview observer missing')
    expect(document.querySelector('[data-collection-resources]')).not.toBeNull()

    await act(async () => observer.trigger(true))
    await waitForDom(domFinishedLoading)
    await act(async () => observer.trigger(true))
    await waitForDom(domFinishedLoading)

    expect(insightPayloads().filter((payload) => payload.eventType === 'preview_open')).toEqual([
      { slug: 'research-notes', eventType: 'preview_open' },
    ])
  })

  it('beacons resource_open on the external affordance click without preventing navigation', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('First source', 'root-1', 'https://example.com/reference'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const link = document.querySelector<HTMLAnchorElement>('[data-collection-resource-link]')
    if (!link) throw new Error('resource link missing')
    expect(link.getAttribute('href')).toBe('https://example.com/reference')
    // Keep happy-dom hermetic: it performs a real network navigation for an
    // untrusted synthetic click, unlike browsers. The href contract is asserted
    // above; remove it only while exercising the delegated insight handler.
    link.removeAttribute('href')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(() => {
      link.dispatchEvent(event)
    })
    await waitForDom(domFinishedLoading)

    expect(event.defaultPrevented).toBe(false)
    expect(insightPayloads().filter((payload) => payload.eventType === 'resource_open')).toEqual([
      { slug: 'research-notes', eventType: 'resource_open', nodeId: 'First source' },
    ])
  })

  it('routes the primary bookmark click to the in-app detail and keeps the external ↗ secondary', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      bookmark('First source', 'root-1', 'https://example.com/reference'),
      bookmark('Unsafe source', 'root-1', 'javascript:alert(1)'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    /* Board: title links carry the public slug (guests and signed-in
       non-members resolve /r/:id from the public snapshot). collectionId
       must stay out — it would route logged-in visitors to the member-only
       editor snapshot. */
    const detailLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-resource-detail]')]
    expect(detailLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/r/First%20source?subjectType=node&slug=research-notes',
      '/r/Unsafe%20source?subjectType=node&slug=research-notes',
    ])
    expect(detailLinks.every((link) => !link.getAttribute('href')?.includes('collectionId'))).toBe(true)
    // Unsafe URLs keep the detail link but never an external affordance.
    expect(document.querySelectorAll('[data-collection-resource-link]')).toHaveLength(1)

    // List rows: internal row link, external ↗ in the actions slot.
    const listButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'List')
    if (!listButton) throw new Error('List button missing')
    await act(async () => listButton.click())
    const rows = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-view="list"] a.library-bookmark')]
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/r/First%20source?subjectType=node&slug=research-notes',
      '/r/Unsafe%20source?subjectType=node&slug=research-notes',
    ])
    const external = document.querySelector<HTMLAnchorElement>(
      '[data-collection-view="list"] .library-bookmark-actions [data-collection-resource-link]',
    )
    expect(external?.getAttribute('href')).toBe('https://example.com/reference')
    expect(external?.getAttribute('target')).toBe('_blank')
    expect(external?.rel).toContain('noopener')
    expect(external?.rel).toContain('noreferrer')

    // Compact keeps the same split.
    const compactButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Compact')
    if (!compactButton) throw new Error('Compact button missing')
    await act(async () => compactButton.click())
    const compactRow = document.querySelector<HTMLAnchorElement>('[data-collection-view="compact"] a.library-bookmark')
    expect(compactRow?.getAttribute('href')).toBe('/r/First%20source?subjectType=node&slug=research-notes')
    expect(document.querySelector(
      '[data-collection-view="compact"] .library-bookmark-actions [data-collection-resource-link]',
    )).not.toBeNull()
  })

  it('keeps the ready snapshot visible and does not toast when ingest rejects with 429', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    mocks.recordPublicCollectionInsightEvent.mockRejectedValue(
      new ProductApiError({ status: 429, code: 'rate_limited', message: 'Too many requests' }),
    )
    renderCollection()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="public-collection-page"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Research notes')
    expect(document.body.textContent).toContain('First source')
    expect([...document.querySelectorAll('*')].some((el) => el.classList.contains('toast'))).toBe(false)
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('disconnects the previous preview observer when switching slugs', async () => {
    mocks.loadPublicCollectionSnapshot.mockImplementation(async (slug: string) => {
      if (slug === 'other-notes') {
        return {
          ...snapshot([rootNode(), bookmark('Second source')]),
          collection: {
            ...snapshot().collection,
            slug: 'other-notes',
            title: 'Other notes',
          },
        }
      }
      return snapshot()
    })

    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Research notes')

    const previous = previewObservers().at(-1)
    if (!previous) throw new Error('first preview observer missing')
    await act(async () => previous.trigger(true))
    await waitForDom(domFinishedLoading)
    expect(insightPayloads().filter((payload) => payload.eventType === 'preview_open')).toHaveLength(1)

    renderCollection('/c/other-notes')
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Other notes')
    expect(document.body.textContent).toContain('Second source')

    await act(async () => previous.trigger(true))
    await waitForDom(domFinishedLoading)

    expect(insightPayloads().filter((payload) => (
      payload.eventType === 'preview_open' && payload.slug === 'research-notes'
    ))).toHaveLength(1)
    expect(insightPayloads().filter((payload) => (
      payload.eventType === 'preview_open' && payload.slug === 'other-notes'
    ))).toHaveLength(0)
  })

  it('labels board cards from the host instead of a generic Article chip', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { ...bookmark('Repo note', 'root-1', 'https://github.com/know-n/web'), position: '00000000000000000000' },
      { ...bookmark('Paper note', 'root-1', 'https://arxiv.org/abs/1234'), position: '00000000000000000001' },
      { ...bookmark('Site note', 'root-1', 'https://example.com/post'), position: '00000000000000000002' },
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)
    const kinds = [...document.querySelectorAll('[data-resource-kind]')].map((node) => node.getAttribute('data-resource-kind'))
    expect(kinds).toEqual(['Repo', 'Paper'])
    const site = [...document.querySelectorAll('[data-collection-resource]')]
      .find((node) => node.textContent?.includes('Site note'))
    expect(site?.hasAttribute('data-resource-kind')).toBe(false)
    expect(site?.textContent).not.toContain('Link')
    expect(document.querySelector('[data-collection-view="board"] .result-card-top')?.textContent).not.toContain('Article')
  })

  it('orders board bookmarks by sibling position, not snapshot insertion order', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      {
        id: 'nd-b', parentId: 'root-1', kind: 'bookmark', title: 'Inserted first',
        description: null, url: 'https://b.example/', position: '00000000000000000001',
      },
      {
        id: 'nd-a', parentId: 'root-1', kind: 'bookmark', title: 'Inserted second',
        description: null, url: 'https://a.example/', position: '00000000000000000000',
      },
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const titles = [...document.querySelectorAll('[data-collection-resource-title]')].map((element) => element.textContent)
    expect(titles).toEqual(['Inserted second', 'Inserted first'])
  })

  it('saves a public bookmark into an owned collection as a real node (R7-07)', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    mocks.loadEditorSnapshot.mockResolvedValue({
      collection: { id: 'col-own-aaaaaaaaaaaaA', title: 'My shelf' },
      root: { id: 'own-root' },
      nodes: [],
    })
    mocks.createCollectionNode.mockResolvedValue({})

    renderCollection()
    await waitForDom(domFinishedLoading)

    const saveButton = document.querySelector<HTMLButtonElement>('[data-collection-resource-save]')
    expect(saveButton?.getAttribute('aria-label')).toBe('Copy First source to one of your collections')
    expect(saveButton?.getAttribute('title')).toBe('Copy to my collection')
    expect(saveButton?.querySelector('[data-icon="fork"]')).not.toBeNull()
    expect(saveButton?.querySelector('[data-testid="save-mark"]')).toBeNull()
    await act(async () => saveButton?.click())

    // Copy-mode destination picker: pick the owned collection, then Top level.
    expect(document.querySelector('[data-testid="destination-picker"]')?.getAttribute('data-mode')).toBe('copy')
    const collectionOption = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="destination-option"]')]
      .find((option) => option.textContent?.includes('My shelf'))
    await act(async () => collectionOption?.click())
    const topLevel = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="destination-option"]')]
      .find((option) => option.textContent?.includes('Top level'))
    await act(async () => topLevel?.click())

    expect(mocks.createCollectionNode).toHaveBeenCalledWith(
      'col-own-aaaaaaaaaaaaA',
      expect.objectContaining({
        parentId: 'own-root',
        node: expect.objectContaining({
          kind: 'bookmark',
          title: 'First source',
          url: 'https://First source.example/path',
        }),
      }),
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    expect(mocks.success).toHaveBeenCalledWith('Saved to “My shelf”')
    expect(document.querySelector('[data-testid="destination-picker"]')).toBeNull()
  })
})
