// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExploreCollection } from '../api/types'
import { Landing } from './Landing'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getExploreCollections: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
  }
})

/**
 * Landing hero typewriter (V-02).
 *
 * First paint, prefers-reduced-motion, and capture frames that freeze CSS
 * animation must all show a complete word. Reduced-motion users get a static
 * title (no typing loop). Motion-ok still starts on the full first word so
 * FCP is a finished sentence, then cycles after a pause.
 */

const mediaQuery = (matches: boolean) => ({
  matches,
  media: '(prefers-reduced-motion: reduce)',
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
})

/** The h1's text as assistive tech reads it: aria-hidden decoration removed. */
function headingName(): string {
  const heading = document.querySelector('h1')?.cloneNode(true) as HTMLElement | undefined
  if (!heading) return ''
  for (const hidden of heading.querySelectorAll('[aria-hidden="true"], [aria-hidden=""]')) hidden.remove()
  return (heading.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

describe('Landing typewriter (M02)', () => {

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getExploreCollections.mockReturnValue(new Promise(() => {}))
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = vi.fn().mockImplementation((query: string) => mediaQuery(false))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  function render() {
    mountTree(
        <MemoryRouter>
          <Landing />
        </MemoryRouter>,
      )
  }

  it('hangs the caret outside the wrap so the typed word centers with the lead', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../styles/interactions.css'), 'utf8')
    const wrapBlock = css.slice(css.indexOf('.typewriter-wrap {'), css.indexOf('.typewriter-text {'))
    expect(wrapBlock).toMatch(/display:\s*inline-block/)
    expect(wrapBlock).toMatch(/position:\s*relative/)
    const caretBlock = css.slice(css.indexOf('.typewriter-cursor {'), css.indexOf('.typewriter-cursor.is-blinking'))
    expect(caretBlock).toMatch(/position:\s*absolute/)
    expect(caretBlock).toMatch(/left:\s*100%/)
  })

  it('shows a complete visual word on first render, before any timer runs', () => {
    render()
    // R15-39: the heading reads as one sentence (no per-letter spans, no
    // aria-label on a generic span): its name skips the aria-hidden typing.
    expect(headingName()).toBe('Your bookmarks already contain a collection.')
    expect(document.querySelector('h1 .landing-hero-lead')?.children.length ?? 0).toBe(0)
    expect(document.querySelector('h1 [aria-label]')).toBeNull()
    const h1 = document.querySelector('h1')
    expect(h1?.textContent).toContain('Your bookmarks already contain a')
    expect(h1?.textContent).toContain('collection.')
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toBe('collection.')
    const caret = document.querySelector('[data-testid="typewriter-cursor"]')
    expect(caret?.textContent).toBe('▮')
    expect(caret?.classList.contains('is-blinking')).toBe(true)
  })

  it('cycles to the next complete word after the pause', () => {
    render()
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toBe('collection.')
    act(() => {
      vi.advanceTimersByTime(2200)
    })
    for (let i = 0; i < 80; i += 1) {
      act(() => {
        vi.advanceTimersByTime(50)
      })
    }
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toContain('shared')
  })

  it('holds the complete word under reduced-motion — no typing loop (the caret blink is neutralized in CSS)', () => {
    window.matchMedia = vi.fn().mockImplementation(() => mediaQuery(true))
    render()
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toBe('collection.')
    act(() => {
      vi.advanceTimersByTime(30000)
    })
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toBe('collection.')
    expect(headingName()).toBe('Your bookmarks already contain a collection.')
    expect(document.querySelector('[data-testid="typewriter-cursor"]')?.classList.contains('is-blinking')).toBe(true)
  })

  it('offers a persisted pause for the hero motion (R15-38)', () => {
    try { localStorage.removeItem('known.landing-motion') } catch { /* ignore */ }
    render()
    const toggle = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Pause animation')!
    expect(toggle).toBeTruthy()
    act(() => toggle.click())
    expect(toggle.textContent).toBe('Play animation')
    // The typing loop stops on the whole word and the caret is gone.
    const word = 'collection.'
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toBe(word)
    expect(document.querySelector('[data-testid="typewriter-cursor"]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(30000)
    })
    expect(document.querySelector('[data-testid="typewriter-text"]')?.textContent).toBe(word)
    expect(localStorage.getItem('known.landing-motion')).toBe('paused')

    // A later visit starts paused.
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    render()
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Play animation')).toBe(true)
    localStorage.removeItem('known.landing-motion')
  })

  it('positions the homepage as an online bookmark library, not a desk', () => {
    render()
    const bodyText = document.body.textContent ?? ''
    expect(document.title).toBe('Online bookmark library — Know-N')
    expect(bodyText).toContain('online bookmark library')
    expect(bodyText).toContain('browser sync')
    expect(bodyText).toContain('Start a collection')
    const browseLink = [...document.querySelectorAll('a')].find((anchor) =>
      anchor.textContent?.includes('Explore collections'),
    )
    expect(browseLink?.getAttribute('href')).toBe('/explore')
    expect(document.querySelector('a[href="/demos"]')).toBeNull()
    expect(bodyText).not.toContain('Browse product flows')
    expect(bodyText).not.toContain('Demo hub')
    expect(bodyText).not.toContain('Core architecture is designed')
    expect(bodyText).not.toContain('tonight')
    expect(bodyText).not.toMatch(/\bdesk\b/i)
  })

  it('renders the dither-field hero and no third-party favicon URLs', () => {
    render()
    expect(document.querySelector('canvas')).not.toBeNull()
    const srcs = [...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '')
    expect(srcs.filter((src) => /a\.favicon\.im|favicon\.im|icons\.duckduckgo\.com/i.test(src))).toEqual([])
    expect(srcs.some((src) => src.includes('a.favicon.im'))).toBe(false)
    expect(srcs.some((src) => src.includes('favicon.im'))).toBe(false)
    expect(srcs.some((src) => src.includes('icons.duckduckgo.com'))).toBe(false)
    expect(document.body.innerHTML).not.toContain('a.favicon.im')
    expect(document.body.innerHTML).not.toContain('favicon.im')
    expect(document.body.innerHTML).not.toContain('icons.duckduckgo.com')
  })

  it('keeps the hero button-free (typewriter + Skip only) and does not jack native scroll', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'Landing.tsx'), 'utf8')
    expect(source).not.toMatch(/addEventListener\(\s*['"]wheel['"]/)
    expect(source).not.toMatch(/addEventListener\(\s*['"]touchmove['"]/)
    expect(source).not.toMatch(/scrollTo\(\s*0\s*,\s*0\s*\)/)
    expect(source).not.toMatch(/passive:\s*false/)

    render()
    /* R7-01 (accepted): no CTA buttons on the hero — the sticky top nav owns the
       first-paint conversion action (Log in + Get started), and the statement
       section / closing band own the in-page ones. Skip is the hero's only link. */
    expect(document.querySelector('[data-testid="landing-hero"] [data-testid="landing-cta"]')).toBeNull()
    const heroCtas = [
      ...document.querySelectorAll('[data-testid="landing-hero"] a, [data-testid="landing-hero"] button'),
    ].filter((el) => el.classList.contains('btn'))
    expect(heroCtas).toHaveLength(0)
    const skip = document.querySelector('[data-testid="landing-hero"] a[href="#landing-content"]')
    expect(skip?.getAttribute('href')).toBe('#landing-content')
    /* R12-13: a scroll cue, not a second "Skip to content" next to the
       app-wide skip link; the first viewport also names the product. */
    expect(skip?.textContent?.trim()).toBe('See how it works')
    expect(document.querySelector('[data-testid="landing-hero"]')?.textContent)
      .toContain('An online bookmark library for saved links, synced browser folders and shared collections.')
    expect(document.querySelectorAll('[data-testid="landing-hero"] a')).toHaveLength(1)
    expect(document.getElementById('landing-content')).not.toBeNull()
    /* Regression guard for the removed scroll cue: no semantic hook can assert
       a class's absence, so this stays a direct class lookup (not a CSS selector). */
    expect(document.getElementsByClassName('landing-scroll-cue')).toHaveLength(0)
  })
})

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

describe('Landing curated collections', () => {

  beforeEach(() => {
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = vi.fn().mockImplementation(() => mediaQuery(false))
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  function render() {
    mountTree(
        <MemoryRouter>
          <Landing />
        </MemoryRouter>,
      )
  }

  it('renders Explore publication slugs and does not hardcode interface-systems', async () => {
    /* The endpoint serves these two published collections on every read. */
    mocks.getExploreCollections.mockResolvedValue({
      items: [
        exploreItem('llm-learning-path', 'LLM learning path'),
        exploreItem('frontend-engineering', 'Frontend engineering'),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)

    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).toEqual({ limit: 4 })
    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).not.toHaveProperty('sort')
    const cards = [...document.querySelectorAll('[aria-label="Collections"] a')]
    for (const card of cards) {
      expect(card.textContent).not.toMatch(/\bviews\b/)
      expect(card.textContent).not.toContain('followers')
    }
    expect(cards.map((card) => card.getAttribute('href'))).toEqual([
      '/c/llm-learning-path',
      '/c/frontend-engineering',
    ])
    const liveCtas = [...document.querySelectorAll('a')].filter((anchor) => (
      anchor.textContent?.includes('Explore a live collection')
    ))
    expect(liveCtas.map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/c/llm-learning-path',
    ])
    expect(liveCtas.some((anchor) => anchor.getAttribute('href')?.includes('interface-systems'))).toBe(false)
  })

  it('sends empty live-collection CTAs to Explore', async () => {
    render()
    await waitForDom(domFinishedLoading)

    const liveCtas = [...document.querySelectorAll('a')].filter((anchor) => (
      anchor.textContent?.includes('Explore a live collection')
    ))
    expect(liveCtas.map((anchor) => anchor.getAttribute('href'))).toEqual(['/explore'])
    expect(document.querySelectorAll('[aria-label="Collections"] a')).toHaveLength(0)
    // R15-23: no empty "Collections with a point of view" band.
    expect(document.body.textContent).not.toContain('Collections with a point of view')
  })

  it('keeps a collections Explore CTA and labelled snap rows', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem('llm-learning-path', 'LLM learning path')],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)

    const browse = [...document.querySelectorAll('a')].find((anchor) =>
      anchor.textContent?.includes('Browse all collections'),
    )
    expect(browse?.getAttribute('href')).toBe('/explore')
    expect(document.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe(
      'Extensibility highlights',
    )
    expect(document.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(
      'Collections',
    )
  })
})

describe('Landing extensibility paths', () => {

  beforeEach(() => {
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = vi.fn().mockImplementation(() => mediaQuery(false))
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('gives each extensibility card a product path, listitem, and visible CTA', async () => {
    const source = readFileSync(resolve(import.meta.dirname, 'Landing.tsx'), 'utf8')
    expect(source).toContain('to="/extension"')
    expect(source).toContain('to="/sync"')
    // The embed card lands on the product share page, which picks a live public
    // collection itself; it must not hardcode a seed slug that may be absent.
    expect(source).toContain('to="/share"')
    expect(source).not.toContain('to="/share/llm-learning-path"')
    expect(source).toContain('to="/developers"')

    mountTree(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    )
    await waitForDom(domFinishedLoading)

    const list = document.querySelector('[aria-label="Extensibility highlights"]')
    expect(list?.getAttribute('role')).toBe('list')
    expect(list?.querySelectorAll('[role="listitem"]')).toHaveLength(4)

    expect(document.querySelector('a[href="/extension"]')?.textContent).toContain('Open extension')
    expect(document.querySelector('a[href="/sync"]')?.textContent).toContain('Open sync center')
    expect(document.querySelector('a[href="/share"]')?.textContent).toContain(
      'Open share and embed',
    )
    expect(document.querySelector('a[href="/developers"]')?.textContent).toContain('Open developers')
    expect(document.querySelector('a[href="/demos"]')).toBeNull()
  })
})

describe('Landing phone snap rows', () => {
  it('does not hide the collections Browse control and peeks the next card at 639px', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../styles/landing.css'), 'utf8')
    expect(css).not.toMatch(
      /\.landing-collections-section\s+\.section-head\s*>\s*\.btn\s*\{[^}]*display:\s*none/,
    )

    const mobileIdx = css.lastIndexOf('@media (max-width: 639px)')
    const mobile = css.slice(mobileIdx)
    expect(mobile).toMatch(/\.extensibility-grid/)
    expect(mobile).toMatch(/\.collection-grid\.landing-collection-grid/)
    expect(mobile).toMatch(/grid-auto-columns:\s*calc\(100% - 2\.5rem\)/)
    expect(mobile).toMatch(/padding-inline-end:\s*var\(--space-4\)/)
  })
})
