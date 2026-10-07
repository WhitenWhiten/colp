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

describe('Share embed snippet', () => {
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

  it('ships a hardened embed snippet: lazy, sandboxed, neutral border', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const code = document.querySelector('[data-testid="share-embed-code"]')?.textContent ?? ''
    expect(code).toContain('src="https://know-n.com/share/llm-learning-path?embed=1"')
    expect(code).toContain('loading="lazy"')
    expect(code).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"')
    expect(code).toContain('referrerpolicy="strict-origin-when-cross-origin"')
    /* A neutral gray border reads on both light and dark host pages. */
    expect(code).toContain('rgba(128 128 128 / 0.35)')
  })

  it('configures the embed snippet (theme, size, height) from the menus', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const code = () => document.querySelector('[data-testid="share-embed-code"]')?.textContent ?? ''
    const live = () => document.querySelector<HTMLIFrameElement>('[data-testid="share-embed-live"]')
    const pickSegment = async (label: string, option: string) => {
      const group = document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${label}"]`)!
      const radio = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((o) => o.textContent === option)!
      act(() => radio.click())
      await waitForDom(domFinishedLoading)
    }
    expect(code()).not.toContain('theme=')
    expect(code()).not.toContain('compact')
    expect(live()?.getAttribute('src')).toBe('/share/llm-learning-path?embed=1')

    await pickSegment('Embed theme', 'Dark')
    expect(code()).toContain('theme=dark')
    expect(live()?.getAttribute('src')).toContain('theme=dark')

    await pickSegment('Embed size', 'Compact')
    expect(code()).toContain('compact')
    expect(code()).toContain(`height="${140 + 2 * 33}"`)
    expect(live()?.getAttribute('src')).toContain('compact')
  })

  it('copies an agent prompt that points at the guide and carries the chosen card URL', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)
    const dark = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Embed theme"] [role="radio"]')].find((o) => o.textContent === 'Dark')!
    act(() => dark.click())
    const copy = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy agent prompt')!
    await act(async () => { copy.click() })
    expect(writeText).toHaveBeenCalledTimes(1)
    const prompt = writeText.mock.calls[0]![0] as string
    expect(prompt).toContain('https://know-n.com/embed-guide.md')
    expect(prompt).toContain('https://know-n.com/share/llm-learning-path?embed=1&theme=dark')
    expect(prompt).toContain('[your website URL or project folder]')
  })

  it('applies appearance to the card without removing attribution or changing destinations', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path?embed=1&bg=%23ffffff&text=%23ffffff&metaFont=mono&divider=dotted&decoration=checker&hideBrand=true')
    await waitForDom(domFinishedLoading)
    const page = document.querySelector<HTMLElement>('[data-testid="share-embed-page"]')!
    expect(page.style.getPropertyValue('--surface')).toBe('#ffffff')
    expect(page.style.getPropertyValue('--embed-brand-ink')).toBe('#000000')
    expect(page.dataset.decoration).toBe('checker')
    // Attribution is the drawn wordmark (R12-17); a light custom ground keeps the ink variant.
    expect(document.querySelector('footer a img')?.getAttribute('alt')).toBe('Know-N')
    expect(document.querySelector('footer a img')?.getAttribute('src')).toBe('/brand-wordmark.svg')
    expect(document.querySelector('footer a:last-child')?.getAttribute('href')).toContain('/share/llm-learning-path')
  })

  it('keeps appearance controls, preview and copied URL synchronized and resets overrides', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Body font"]')!
    act(() => {
      select.value = 'mono'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.querySelector('[data-testid="share-embed-live"]')?.getAttribute('src')).toContain('font=mono')
    expect(document.querySelector('[data-testid="share-embed-code"]')?.textContent).toContain('font=mono')
    const reset = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reset appearance')!
    act(() => reset.click())
    expect(document.querySelector('[data-testid="share-embed-live"]')?.getAttribute('src')).toBe('/share/llm-learning-path?embed=1')
  })

  it('names appearance options in words and previews valid hex colors (R12-18)', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)
    // Human labels; the contract values (and so the URL) are unchanged.
    const decoration = document.querySelector<HTMLSelectElement>('select[aria-label="Decoration"]')!
    expect([...decoration.options].map((option) => [option.value, option.textContent])).toEqual([['none', 'None'], ['checker', 'Checker']])
    const font = document.querySelector<HTMLSelectElement>('select[aria-label="Body font"]')!
    expect([...font.options].map((option) => option.textContent)).toEqual(['Default', 'Sans', 'Serif', 'Mono'])
    // Every control is named by a visible label.
    expect(document.querySelector<HTMLLabelElement>(`label[for="${font.id}"]`)?.textContent).toBe('Body font')

    const background = document.querySelector<HTMLInputElement>('input[aria-label="Background hex color"]')!
    const swatch = () => background.parentElement?.querySelector<HTMLElement>('[data-testid="share-appearance-swatch"]')
    const setInput = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(background, value)
      background.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(swatch()).toBeNull()
    setInput('#12345')
    expect(swatch()).toBeNull()
    setInput('#123456')
    expect(swatch()?.style.getPropertyValue('--swatch')).toBe('#123456')
  })

  it('copies a parseable safe iframe with customized colors, geometry and an untrusted title', async () => {
    const title = '\"><img src=x onerror=alert(1)> & collection'
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot({ title }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)
    const setInput = (input: HTMLInputElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    setInput(document.querySelector<HTMLInputElement>('input[aria-label="Background hex color"]')!, '#123456')
    setInput(document.querySelector<HTMLInputElement>('input[aria-label="Border color hex color"]')!, '#abcdef')
    const radiusLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find(label => label.textContent?.includes('Corner radius'))!
    const radius = document.getElementById(radiusLabel.htmlFor) as HTMLInputElement
    setInput(radius, '0')
    const live = document.querySelector<HTMLIFrameElement>('[data-testid="share-embed-live"]')!
    const wrap = live.parentElement as HTMLElement
    expect(new URL(live.src).searchParams.get('bg')).toBe('#123456')
    expect(wrap.style.borderRadius).toBe('0px')
    const copy = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy embed code')!
    await act(async () => { copy.click() })
    expect(writeText).toHaveBeenCalledTimes(1)
    const html = new DOMParser().parseFromString(writeText.mock.calls[0]![0] as string, 'text/html')
    expect(html.body.children.length).toBe(1)
    expect(html.querySelector('script, img, [onload], [onerror]')).toBeNull()
    const frame = html.querySelector('iframe')!
    expect(frame.title).toBe(title)
    expect(new URL(frame.src).searchParams.get('line')).toBe('#abcdef')
    expect(frame.style.cssText).toBe(live.style.cssText)
    expect(frame.getAttribute('sandbox')).toBe(live.getAttribute('sandbox'))
    setInput(radius, '999')
    expect(new URL(live.src).searchParams.has('radius')).toBe(false)
    expect(wrap.style.borderRadius).toBe('8px')
  })

  it.each(['light', 'dark'])('keeps custom colors on %s and does not forward styling into data requests', async theme => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare(`/share/llm-learning-path?embed=1&theme=${theme}&bg=%23abcdef&text=%23123456&font=mono`)
    await waitForDom(domFinishedLoading)
    const page = document.querySelector<HTMLElement>('[data-testid="share-embed-page"]')!
    expect(page.style.getPropertyValue('--surface')).toBe('#abcdef')
    expect(page.style.getPropertyValue('--ink')).toBe('#123456')
    for (const call of mocks.loadPublicCollectionSnapshot.mock.calls) {
      expect(call[0]).toBe('llm-learning-path')
      expect(call[1]).not.toHaveProperty('bg')
      expect(call[1]).not.toHaveProperty('font')
    }
  })

  it('compacts the embed card: every row scrolls, no summary or curator', async () => {
    const crowded = snapshot()
    for (let i = 0; i < 6; i++) {
      crowded.nodes.push(
        bookmark(`nd-compact-${i}`, `Compact link ${i}`, `https://example.com/${i}`, `0000000000000000003${i}`),
      )
    }
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(crowded)
    renderShare('/share/llm-learning-path?embed=1&compact')
    await waitForDom(domFinishedLoading)

    expect(document.querySelectorAll('[data-testid="share-embed-row"]').length).toBe(8)
    expect(document.querySelector('[data-testid="share-embed-more"]')?.textContent).toBe('+5 more links')
    expect(document.querySelector('p.share-embed-summary')).toBeNull()
    expect(document.querySelector('span.share-embed-curator')).toBeNull()
  })

  it('reports its suggested height to an embedding host via postMessage', async () => {
    const postMessage = vi.fn()
    const original = Object.getOwnPropertyDescriptor(window, 'parent')
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage } })
    try {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
      renderShare('/share/llm-learning-path?embed=1')
      await waitForDom(domFinishedLoading)
      /* 200px chrome + 2 preview rows × 33px. */
      expect(postMessage).toHaveBeenCalledWith({ type: 'known:embed-resize', height: 266 }, '*')
    } finally {
      if (original) Object.defineProperty(window, 'parent', original)
    }
  })

  it('shows the real og:image in the social preview, or hides the block entirely', async () => {
    installPageMetaBaseline({ ogImage: 'https://know-n.com/og/collections/llm-learning-path.png' })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const art = document.querySelector<HTMLImageElement>('img.share-og-art')
    expect(art?.getAttribute('src')).toBe('https://know-n.com/og/collections/llm-learning-path.png')
    expect(art?.getAttribute('alt')).toBe('')

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    installPageMetaBaseline()
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('img.share-og-art')).toBeNull()
  })

  it('places embed options before the live iframe', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)

    const live = document.querySelector('[data-testid="share-embed-live"]')
    const wrap = live?.parentElement
    const options = wrap?.previousElementSibling
    expect(options).not.toBeNull()
    expect(options!.compareDocumentPosition(wrap!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('tracks live OS palette flips under ?theme=auto', async () => {
    const listeners = new Set<(event: { matches: boolean }) => void>()
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, cb: (event: { matches: boolean }) => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: (event: { matches: boolean }) => void) => listeners.delete(cb),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
    try {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
      renderShare('/share/llm-learning-path?embed=1&theme=auto')
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="share-embed-page"]')?.className).not.toContain('--dark')
      await act(async () => {
        for (const cb of listeners) cb({ matches: true })
      })
      expect(document.querySelector('[data-testid="share-embed-page"]')?.className).toContain('share-embed-page--dark')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('escapes a hostile collection title inside the embed snippet', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot({ title: 'A "quoted" <path>' }))
    renderShare('/share/llm-learning-path')
    await waitForDom(domFinishedLoading)
    const code = document.querySelector('[data-testid="share-embed-code"]')?.textContent ?? ''
    expect(code).toContain('title="A &quot;quoted&quot; &lt;path&gt;"')
    expect(code).not.toContain('title="A "quoted"')
  })
})
