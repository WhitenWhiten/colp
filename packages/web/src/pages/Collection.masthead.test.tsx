// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { PublicCollectionNode } from '../api/types'
import { collectLayeredRules, readStyle } from '../styles/layered-css.test-helper'
import { cleanup, domFinishedLoading, waitForDom } from '../test/render'

import { mocks } from './Collection.masthead.test-mocks'
import {
  bookmark, installMastheadHarness, renderCollection, rootNode, snapshot,
} from './Collection.masthead.test-helper'

installMastheadHarness()

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

describe('public Collection masthead', () => {
  it('renders public and member projections while allowing only safe external links', async () => {
    const nodes: PublicCollectionNode[] = [
      rootNode(),
      {
        id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Foundations',
        description: 'Start here.', url: null, position: 'a',
      },
      bookmark('<script>unsafe title</script>', 'folder-1', 'https://example.com/reference'),
      bookmark('Blocked script link', 'folder-1', 'javascript:alert(1)'),
      bookmark('Blocked credentials', 'folder-1', 'https://user:secret@example.com/private'),
    ]
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(nodes, 'member'))

    // Drill-down semantics: the bookmarks render inside their folder layer.
    renderCollection('/c/research-notes?folder=folder-1')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Shared with you')
    expect(document.body.textContent).not.toContain('Public view')
    const masthead = document.querySelector('header')
    expect(masthead).not.toBeNull()
    expect(masthead?.classList.contains('page-head--editorial')).toBe(true)
    expect(document.querySelector('[data-testid="collection-toolbar"]')).not.toBeNull()
    expect(document.querySelector('[role="radiogroup"][aria-label="View mode"]')).not.toBeNull()
    expect(document.querySelector('[data-collection-field="followers"]')).toBeNull()
    expect(document.body.textContent).not.toContain('0 followers')
    expect(document.body.textContent).not.toContain('0 views')
    expect(document.querySelector('[data-collection-field="bookmarks"]')).not.toBeNull()
    expect(document.body.textContent).toContain('1 folder')
    expect(document.querySelector('[data-collection-field="curator"]')?.textContent).toBe('Curator')
    expect(document.querySelector('[data-collection-field="paid"]')).toBeNull()
    expect(document.querySelector('[data-collection-field="subscription"]')).toBeNull()
    expect(document.querySelector('[data-testid="collection-follow"]')).toBeNull()
    // No paid-subscription CTA, and "Subscribe to bookmarks" waits for D8.
    expect([...document.querySelectorAll('button')].some((candidate) => candidate.textContent?.includes('Subscribe'))).toBe(false)
    expect(document.body.textContent).toContain('<script>unsafe title</script>')
    expect(document.querySelector('script')).toBeNull()
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-resource-link]')]
    expect(links).toHaveLength(1)
    expect(links[0]?.href).toBe('https://example.com/reference')
    expect(links[0]?.target).toBe('_blank')
    expect(links[0]?.rel).toContain('noopener')
    expect(links[0]?.rel).toContain('noreferrer')
    expect(document.body.textContent?.match(/Link unavailable/gu)).toHaveLength(2)
  })

  it('omits the byline when the owner is missing and does not invent a public-view chip', async () => {
    const published = snapshot()
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...published,
      collection: { ...published.collection, owner: undefined },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).not.toContain('Public view')
    expect(document.body.textContent).toContain('Bookmarks')
    expect(document.querySelector('[data-collection-field="curator"]')).toBeNull()
    expect(document.querySelector('header')?.textContent ?? '').not.toMatch(/\bby\b/)
  })

  it('compacts the masthead inside a folder while keeping monetization fields out', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      {
        id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Foundations',
        description: 'Start here.', url: null, position: 'a',
      },
      bookmark('Direct note', 'folder-1'),
    ]))
    renderCollection('/c/research-notes?folder=folder-1')
    await waitForDom(domFinishedLoading)

    // The page flags the drill-down state; collection.css compacts from it.
    expect(document.querySelector('[data-testid="public-collection-page"]')?.hasAttribute('data-in-folder')).toBe(true)
    // The compact form hides via CSS only — the DOM keeps stats and the
    // monetization guarantees unchanged.
    expect(document.querySelector('[data-collection-field="bookmarks"]')).not.toBeNull()
    expect(document.querySelector('[data-collection-field="paid"]')).toBeNull()
    expect(document.querySelector('[data-collection-field="subscription"]')).toBeNull()

    const rules = collectLayeredRules(readStyle('collection.css'))
    const title = rules.find((rule) => (
      rule.selector === '.collection-page[data-in-folder] .collection-masthead .display' && !rule.media
    ))
    expect(title, 'compact masthead title rule must exist').toBeTruthy()
    expect(title!.body).toMatch(/-webkit-line-clamp:\s*1/)
    expect(title!.body).toMatch(/line-height:\s*var\(--leading-clamp\)/)
    expect(title!.body).toMatch(/overflow-wrap:\s*anywhere/)

    const hiddenSelectors = rules
      .filter((rule) => !rule.media && /display:\s*none/.test(rule.body))
      .map((rule) => rule.selector)
    expect(hiddenSelectors).toEqual(expect.arrayContaining([
      '.collection-page[data-in-folder] .collection-masthead .eyebrow',
      '.collection-page[data-in-folder] .collection-masthead-summary',
    ]))

    // ≤639 inside a folder the figures wait at the root; the action row stays.
    const mobileHidden = rules
      .filter((rule) => rule.media?.max === 639 && /display:\s*none/.test(rule.body))
      .map((rule) => rule.selector)
    expect(mobileHidden).toContain('.collection-page[data-in-folder] .page-head-stats')
    expect(mobileHidden).not.toContain('.collection-page[data-in-folder] .page-head-actions')
  })

  it('keeps the social actions in the masthead on a phone inside a folder', async () => {
    /* The cluster mounts once, in the header, at every width and depth —
       the toolbar only carries the filter and the order/view rails. */
    const hadMatchMedia = 'matchMedia' in window
    const previous = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
        rootNode(),
        {
          id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Foundations',
          description: 'Start here.', url: null, position: 'a',
        },
        bookmark('Direct note', 'folder-1'),
      ]))
      renderCollection('/c/research-notes?folder=folder-1')
      await waitForDom(domFinishedLoading)

      expect(document.querySelector('[data-testid="collection-toolbar"] a[href="/graph/research-notes"]')).toBeNull()
      expect(document.querySelectorAll('a[href="/graph/research-notes"]')).toHaveLength(1)
      expect(document.querySelector('header a[href="/graph/research-notes"]')).not.toBeNull()
    } finally {
      if (hadMatchMedia) window.matchMedia = previous
      else delete (window as { matchMedia?: unknown }).matchMedia
    }
  })

  it('keeps the full masthead at the root and for unknown folder ids', async () => {
    const nodes: PublicCollectionNode[] = [
      rootNode(),
      {
        id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Foundations',
        description: null, url: null, position: 'a',
      },
      bookmark('Direct note', 'folder-1'),
    ]
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(nodes))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="public-collection-page"]')?.hasAttribute('data-in-folder')).toBe(false)

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(nodes))
    renderCollection('/c/research-notes?folder=not-a-folder')
    await waitForDom(domFinishedLoading)
    // Stale/foreign folder ids fall back to the root view — masthead included.
    expect(document.querySelector('[data-testid="public-collection-page"]')?.hasAttribute('data-in-folder')).toBe(false)
  })

  it.each(['bookmarks', 'reading_path'] as const)('links Graph and no path reader for %s collections', async (kind) => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, kind },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('a[href="/path/research-notes"]')).toBeNull()
    expect(document.querySelector('a[href="/graph/research-notes"]')).not.toBeNull()
  })
})
