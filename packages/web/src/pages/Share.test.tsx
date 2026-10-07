// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import { ProductApiError } from '../api/errors'
import type { ExploreCollection, PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import { Share } from './Share'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({
  loadPublicCollectionSnapshot: vi.fn(),
  getExploreCollections: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: vi.fn(), error: vi.fn() }),
}))

function rootNode(): PublicCollectionNode {
  return {
    id: 'root-1', parentId: null, kind: 'root', title: 'Published contents',
    description: null, url: null, position: null,
  }
}

function bookmark(
  id: string,
  title: string,
  url: string,
  position: string,
): PublicCollectionNode {
  return {
    id, parentId: 'root-1', kind: 'bookmark', title, description: `${title} blurb`, url, position,
  }
}

function snapshot(overrides: Partial<PublicCollectionSnapshot['collection']> = {}): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-u01-01',
      slug: 'llm-learning-path',
      title: 'LLM learning path',
      summary: 'A public reading path from the snapshot.',
      kind: 'reading_path',
      rootNodeId: 'root-1',
      owner: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'lin',
        displayName: 'Lin Yichen', avatarUrl: null,
      },
      updatedAt: '2026-07-24T12:00:00.000Z',
      access: 'public',
      ...overrides,
    },
    nodes: [
      rootNode(),
      bookmark('nd-col-u01-01-001', 'Transformers paper', 'https://arxiv.org/abs/1706.03762', '00000000000000000000'),
      bookmark('nd-col-u01-01-002', 'Known repo', 'https://github.com/know-n/web', '00000000000000000001'),
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

function exploreItem(slug: string, title: string): ExploreCollection {
  return {
    id: `col-${slug}`,
    title,
    summary: `${title} summary`,
    kind: 'reading_path',
    tags: ['ML'],
    nodeCount: 16,
    updatedAt: '2026-07-24T12:00:00.000Z',
    publicationSlug: slug,
    visibility: 'public',
    creators: [{ id: 'p1', name: 'Lin Yichen', handle: 'lin', avatar: null }],
  }
}

describe('Share', () => {

  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function renderShare(path: string) {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/share" element={<Share />} />
            <Route path="/share/:slug" element={<Share />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('shows the snapshot title and does not fall back to Interface Systems', async () => {
    installPageMetaBaseline()
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="share-page"] h1')?.textContent).toBe('LLM learning path')
    expect(document.body.textContent).toContain('A public reading path from the snapshot.')
    expect(document.body.textContent).toContain('Lin Yichen')
    expect(document.querySelector('a[href="/u/lin"]')).not.toBeNull()
    expect(document.body.textContent).toContain('2 bookmarks')
    expect(document.body.textContent).toContain('Transformers paper')
    expect(document.body.textContent).toContain('arxiv.org')
    expect(document.body.textContent).toContain('Paper')
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('Mira Okada')
    expect(document.body.textContent).not.toMatch(/6,240|6240/)
    expect(document.body.textContent).not.toContain('followers')
    expect(document.body.textContent).not.toContain('0 views')
    expect(pageMetaContent('meta[name="description"]')).toBe('A public reading path from the snapshot.')
    expect(canonicalHref()).toBe('https://know-n.com/c/llm-learning-path')
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(pageMetaContent('meta[property="og:url"]')).toBe(canonicalHref())
  })

  it('hides the generic Link kind chip for ordinary web bookmarks', async () => {
    const ordinary = snapshot()
    ordinary.nodes[0] = bookmark('nd-col-u01-01-001', 'Some page', 'https://example.com/page', '00000000000000000000')
    ordinary.nodes[1] = bookmark('nd-col-u01-01-002', 'Another page', 'https://example.org/x', '00000000000000000001')
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(ordinary)
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.querySelectorAll('[data-testid="share-preview-kind"]')).toHaveLength(0)
    expect(document.querySelector('[data-testid="share-type-mix"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/\bLink · \d/)
  })

  it('renders the summary through the collapsible clamp used by the collection page', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    /* ClampedText marks its clamped paragraph with dir="auto". */
    const lede = document.querySelector('p[dir="auto"]')
    expect(lede).not.toBeNull()
    expect(lede?.textContent).toBe('A public reading path from the snapshot.')
    /* The toggle only appears when the text actually truncates (layout
       measurement); happy-dom reports no overflow, so none renders here. */
    expect(document.querySelector('div.share-hero-summary button[aria-expanded]')).toBeNull()
  })

  it('uses the same unavailable empty state as the public collection page for unknown slugs', async () => {
    installPageMetaBaseline()
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))
    renderShare('/share/missing-notes')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="share-page"]')).toBeNull()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelector('[role="status"] h1')?.textContent).toBe('Collection unavailable')
    expect(document.querySelector('[role="status"]')?.classList.contains('not-found-stage')).toBe(true)
    expect(document.body.textContent).toContain('not found, has been withdrawn, or is not available')
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('missing-notes')
    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('spotlights the first Explore collections on /share without a slug', async () => {
    installPageMetaBaseline()
    mocks.getExploreCollections.mockResolvedValue({
      items: [
        exploreItem('llm-learning-path', 'LLM learning path'),
        exploreItem('frontend-engineering', 'Frontend engineering'),
        exploreItem('rust-backends', 'Rust for backends'),
      ],
      nextCursor: null,
    })
    renderShare('/share')
    await waitForDom(domFinishedLoading)

    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).toEqual({ limit: 3 })
    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).not.toHaveProperty('sort')
    expect(document.querySelector('a[href="/share/llm-learning-path"]')).not.toBeNull()
    expect(document.querySelector('a[href="/share/frontend-engineering"]')).not.toBeNull()
    expect(document.querySelector('a[href="/share/rust-backends"]')).not.toBeNull()
    const liveShare = [...document.querySelectorAll('a')].find((anchor) => (
      anchor.textContent?.includes('See a live share page')
    ))
    expect(liveShare?.getAttribute('href')).toBe('/share/llm-learning-path')
    expect(document.querySelector('a[href="/share/interface-systems"]')).toBeNull()
    expect(document.title).toBe('Share — Know-N')
    expect(pageMetaContent('meta[name="description"]')).toBe('Share curated bookmark collections and learning paths with one Know-N link.')
    expect(canonicalHref()).toBe('https://know-n.com/share')
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
  })

  it('keeps the decorative promo stage inert and without a fake Copy control', async () => {
    renderShare('/share')
    await waitForDom(domFinishedLoading)

    const stage = document.querySelector('[inert]')
    expect(stage?.hasAttribute('inert')).toBe(true)
    expect(stage?.getAttribute('aria-hidden')).toBe('true')
    expect(stage?.querySelector('button')).toBeNull()
    expect(stage?.textContent).toContain('know-n.com/share/')
  })

  it('sends empty Spotlight CTAs to Explore instead of a hardcoded slug', async () => {
    renderShare('/share')
    await waitForDom(domFinishedLoading)

    const liveShare = [...document.querySelectorAll('a')].find((anchor) => (
      anchor.textContent?.includes('See a live share page')
    ))
    expect(liveShare?.getAttribute('href')).toBe('/explore')
    expect(document.querySelectorAll('[data-testid="share-spotlight-grid"] a')).toHaveLength(0)
  })

  it('renders the curator avatar image when the owner has an avatarUrl', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(
      snapshot({ owner: { profileId: 'p1', handle: 'lin', displayName: 'Lin Yichen', avatarUrl: 'https://cdn.example.test/lin.png' } }),
    )
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const avatar = document.querySelector<HTMLImageElement>('[data-testid="share-curator-avatar"] img')
    expect(avatar?.getAttribute('src')).toBe('https://cdn.example.test/lin.png')
  })

  it('falls back to initials in the curator card when the owner has no avatarUrl', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="share-curator-avatar"] img')).toBeNull()
    expect(document.querySelector('[data-testid="share-curator-avatar"]')?.textContent).toBe('LY')
  })

  it('hides the curator link when the collection has no owner', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot({ owner: undefined }))
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="share-curator-link"]')).toBeNull()
    expect(document.body.textContent).not.toContain(' - ')
  })

  it('renders the compact embed card instead of the full page for ?embed=1', async () => {
    installPageMetaBaseline()
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path?embed=1')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('article')).not.toBeNull()
    expect(document.querySelector('article h1')?.textContent).toBe('LLM learning path')
    expect(document.body.textContent).toContain('Transformers paper')
    const brand = document.querySelector('a.share-embed-foot-brand img')
    expect(brand?.getAttribute('alt')).toBe('Know-N')
    expect(brand?.getAttribute('src')).toBe('/brand-wordmark.svg')
    // None of the full-page chrome/sections may leak into the embed
    expect(document.querySelector('[data-testid="share-hero"]')).toBeNull()
    expect(document.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull()
    expect(document.querySelector('[data-testid="share-strip"]')).toBeNull()
    expect(document.querySelector('[data-testid="share-embed-block"]')).toBeNull()
    // Links must escape the iframe
    const open = document.querySelector<HTMLAnchorElement>('a.share-embed-foot-open')
    expect(open?.textContent).toContain('Open')
    expect(open?.getAttribute('target')).toBe('_blank')
    expect(open?.getAttribute('href')).toBe('https://know-n.com/share/llm-learning-path')
    expect(pageMetaContent('meta[name="description"]')).toBe('A public reading path from the snapshot.')
    expect(canonicalHref()).toBe('https://know-n.com/c/llm-learning-path')
  })

  it('shows a minimal unavailable state inside the embed for unknown slugs', async () => {
    installPageMetaBaseline()
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))
    renderShare('/share/missing-notes?embed=1')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="share-embed-state"]')).not.toBeNull()
    expect(document.body.textContent).toContain('This collection is not available.')
    expect(document.querySelector('[data-testid="share-hero"]')).toBeNull()
    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('embeds resource rows as links that escape the iframe', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path?embed=1')
    await waitForDom(domFinishedLoading)

    const rows = [...document.querySelectorAll('[data-testid="share-embed-row"]')]
    expect(rows.length).toBe(2)
    expect(rows[0]?.getAttribute('href')).toBe('https://arxiv.org/abs/1706.03762')
    expect(rows[0]?.getAttribute('target')).toBe('_blank')
    expect(rows[0]?.getAttribute('rel')).toBe('noreferrer')
  })

  it('scrolls the full embed list and links the overflow to the public collection', async () => {
    const crowded = snapshot()
    for (let i = 0; i < 6; i++) {
      crowded.nodes.push(
        bookmark(`nd-extra-${i}`, `Extra link ${i}`, `https://example.com/${i}`, `0000000000000000001${i}`),
      )
    }
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(crowded)
    renderShare('/share/llm-learning-path?embed=1')
    await waitForDom(domFinishedLoading)

    expect(document.querySelectorAll('[data-testid="share-embed-row"]')).toHaveLength(8)
    const list = document.querySelector('[data-testid="share-embed-list"]')
    expect(list?.className).toContain('share-embed-list--truncated')
    const more = document.querySelector<HTMLAnchorElement>('[data-testid="share-embed-more"]')
    expect(more?.textContent).toBe('+4 more links')
    expect(more?.getAttribute('href')).toBe('https://know-n.com/c/llm-learning-path')
    expect(more?.getAttribute('target')).toBe('_blank')
  })

  it('renders a favicon image for rows that carry one and a domain mark otherwise', async () => {
    const withIcon = snapshot()
    withIcon.nodes[1] = {
      ...withIcon.nodes[1]!,
      iconUrl: 'https://know-n.com/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000',
    }
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(withIcon)
    renderShare('/share/llm-learning-path?embed=1')
    await waitForDom(domFinishedLoading)

    const icons = [...document.querySelectorAll('[data-testid="share-embed-row-icon"]')]
    const img = icons[0]?.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://know-n.com/api/v1/favicon/123e4567-e89b-42d3-a456-426614174000')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(icons[1]?.querySelector('img')).toBeNull()
    /* No icon and no CDN allowance falls back to the serif domain mark. */
    expect(icons[1]?.textContent).toBe('G')
  })

  it('skins the embed for dark host pages via ?theme=dark and ignores bogus values', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path?embed=1&theme=dark')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="share-embed-page"]')?.className).toContain('share-embed-page--dark')
    expect(document.querySelector('a.share-embed-foot-brand img')?.getAttribute('src')).toBe('/brand-wordmark-dark.svg')

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path?embed=1&theme=neon')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="share-embed-page"]')?.className).not.toContain('share-embed-page--')
  })

  it('resolves ?theme=auto against the viewer OS palette', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
    try {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
      renderShare('/share/llm-learning-path?embed=1&theme=auto')
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="share-embed-page"]')?.className).toContain('share-embed-page--dark')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('copies the share link even when the Clipboard API rejects', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    const writeText = vi.fn().mockRejectedValue(new Error('Document is not focused'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })

    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const copy = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Copy share link')
    expect(copy).toBeTruthy()
    await act(async () => {
      copy!.click()
    })
    await waitForDom(domFinishedLoading)

    expect(mocks.toast).not.toHaveBeenCalled()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(copy!.textContent).toBe('Copied')
  })

  it('greets an empty collection with a follow-along message instead of a riddle', async () => {
    const empty = snapshot()
    empty.nodes = [rootNode()]
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(empty)
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('No public links yet')
    expect(document.body.textContent).not.toContain('ready to open')
  })

  it('clears the copied timer when the page unmounts before it fires', async () => {
    // copyLink schedules a 2s timer to drop the "Copied" state. Without a
    // cleanup it fires after the user has navigated away and React sets state
    // on a torn-down tree; this test unmounts inside that window and asserts
    // the timer never runs, by watching for the state update it would cause.
    // No fake timers: waitForDom depends on real setTimeout, and freezing the
    // clock makes this fail for a reason that has nothing to do with the timer
    // under test. The window is short (2s) and unmount happens immediately.
    const clearSpy = vi.spyOn(window, 'clearTimeout')
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })

    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const copy = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Copy share link')
    expect(copy).toBeTruthy()
    await act(async () => {
      copy!.click()
    })
    clearSpy.mockClear()
    cleanup()
    // The unmount cleanup must cancel the pending timer, not leave it armed.
    expect(clearSpy).toHaveBeenCalled()
  })
})
