// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExploreCollection, OwnedCollectionListItem } from '../api/types'
import { dashboardModules } from '../api/mock-data'
// Cascade participants, same relative order as main.tsx. Vite does not inject
// these into happy-dom; injectDashboardCascadeStyles flattens @layer so
// getComputedStyle sees components beat pages (the production cascade).
import '../styles/tokens.css'
import '../styles/cards.css'
import '../styles/dashboard.css'
import '../styles/dashboard-desk.css'
import '../styles/widget-search.css'
import '../styles/widget-sticky.css'
import '../styles/widget-todo.css'
import '../styles/widget-weather.css'
import '../styles/widget-collection-list.css'
import '../styles/widget-pomodoro.css'
import '../styles/widget-clock.css'
import '../styles/widget-quicklinks.css'
import '../styles/widget-habits.css'
import '../styles/widget-reading.css'
import '../styles/widget-ssh.css'
import '../styles/widget-heatmap.css'
import '../styles/widget-aichat.css'
import '../styles/widget-wordbook.css'
import {
  flattenLayeredCssForHappyDom,
  injectDashboardCascadeStyles,
  replaceDashboardCascadeStyles,
} from '../styles/dashboard-stack-cascade.test-helper'
import dashboardSource from './Dashboard.tsx?raw'
import { Dashboard } from './Dashboard'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getExploreCollections: vi.fn(),
  owned: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as const,
    message: 'Sign in to view your collections',
    hasMore: false,
    isLoadingMore: false,
    reload: async () => undefined,
    loadMore: async () => undefined,
  },
}))

vi.mock('../components/CanvasBoard', () => ({
  CanvasBoard: () => <div data-testid="canvas-stub" />,
}))

vi.mock('../components/widgets/WeatherWidget', () => ({
  WeatherWidget: ({ resourceId }: { resourceId: string }) => <div data-resource={resourceId} />,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    isLoggedIn: false,
    bootstrapping: false,
  }),
}))

vi.mock('../lib/useOwnedCollections', () => ({
  useOwnedCollections: () => mocks.owned,
}))

function ownedItem(
  id: string,
  title: string,
  publicationSlug: string | null,
): OwnedCollectionListItem {
  return {
    collection: {
      id,
      kind: 'bookmarks',
      title,
      summary: null,
      visibility: publicationSlug ? 'public' : 'private',
      allowSearchIndexing: false,
      publicationSlug,
      publishedAt: publicationSlug ? '2026-08-01T00:00:00.000Z' : null,
      rootNodeId: `root-${id}`,
      revision: 'r',
      etag: '"r"',
      contentRevision: 'c',
      contentEtag: '"c"',
      policyRevision: 'p',
      policyEtag: '"p"',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: true,
      managePublication: Boolean(publicationSlug),
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
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

function defaultOwnedItems(): OwnedCollectionListItem[] {
  return [
    ownedItem('col-owned-public', 'Public notes', 'notes/systems'),
    ownedItem('col-owned-private', 'Private inbox', null),
  ]
}

function pinChips() {
  return [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="dashboard-rail-chips"] a[href^="/c/"]')]
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

function assertStackedTilesInDocumentFlow(width: number) {
  const tiles = [...document.querySelectorAll<HTMLElement>('[aria-label="Start page modules"] > [role="listitem"]')]
  expect(tiles.length, `${width}px must mount stacked tiles`).toBeGreaterThan(0)
  for (const tile of tiles) {
    const style = getComputedStyle(tile)
    expect(
      style.position,
      `${width}px: stack tiles must leave canvas absolute positioning (pages-layer-only reset loses to .tile)`,
    ).toBe('relative')
    expect(style.transform, `${width}px`).toBe('none')
    expect(style.width, `${width}px must not keep the 720px canvas search tile`).not.toBe('720px')
  }
}

describe('Dashboard', () => {

  beforeEach(() => {
    mocks.owned.items = defaultOwnedItems()
    mocks.owned.state = 'ready'
    mocks.owned.message = 'Sign in to view your collections'
    mocks.getExploreCollections.mockReset()
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    localStorage.clear()
    injectDashboardCascadeStyles()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
    // Stacked viewport (<1476): board uses the module list.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    document.documentElement.classList.remove('dashboard-is-fullscreen')
    injectDashboardCascadeStyles(document, true)
  })

  function renderDashboard() {
    mountTree(
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>,
      )
  }

  it('does not reject small screens and keeps collection modules on first run', async () => {
    renderDashboard()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain(
      'This board is an experimental start page with demo modules, not live library analytics.',
    )
    expect(document.querySelector('[role="status"]')?.textContent).toContain('experimental start page')
    expect(document.body.textContent).not.toMatch(/mobile app/i)
    expect(document.body.textContent).not.toMatch(/needs a larger screen/i)
    expect(document.body.textContent).not.toContain('Go to Today')
    expect(document.querySelector('[aria-label="Start page modules"]')).not.toBeNull()
    assertStackedTilesInDocumentFlow(800)
    expect(document.querySelector('[data-testid="canvas-stub"]')).toBeNull()
    expect(document.body.textContent).toContain('Search')
    expect(document.body.textContent).toContain('Reading queue')
    expect(document.body.textContent).toContain('Quick links')
    expect(document.querySelector('[data-resource="d-pomodoro"]')).toBeNull()
    expect(document.querySelector('[data-resource="d-weather"]')).toBeNull()
    expect(document.querySelector('[data-resource="d-ssh"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem('known.dashboard.module-ids.v12') ?? '[]')).toEqual(
      expect.arrayContaining(['d-search', 'd-reading', 'd-quicklinks']),
    )
    const firstRun = JSON.parse(localStorage.getItem('known.dashboard.module-ids.v12') ?? '[]') as string[]
    expect(firstRun).not.toContain('d-weather')
    expect(firstRun).not.toContain('d-pomodoro')
    expect(firstRun).not.toContain('d-sticky')
    expect(firstRun).not.toContain('d-ssh')
  })

  it('keeps a previously saved layout that includes toys', async () => {
    localStorage.setItem(
      'known.dashboard.module-ids.v11',
      JSON.stringify(['d-search', 'd-weather', 'd-pomodoro']),
    )
    renderDashboard()
    await waitForDom(domFinishedLoading)
    const saved = JSON.parse(localStorage.getItem('known.dashboard.module-ids.v12') ?? '[]')
    expect(saved).toEqual(['d-search', 'd-weather', 'd-pomodoro'])
    expect(document.querySelector('[data-resource="d-weather"]')).not.toBeNull()
    expect(document.querySelector('[data-resource="d-pomodoro"]')).not.toBeNull()
  })

  it('does not push catalog toys when a v12 layout exists and seen-seeds is missing', async () => {
    localStorage.setItem(
      'known.dashboard.module-ids.v12',
      JSON.stringify(['d-search', 'd-reading']),
    )
    renderDashboard()
    await waitForDom(domFinishedLoading)
    const saved = JSON.parse(localStorage.getItem('known.dashboard.module-ids.v12') ?? '[]') as string[]
    expect(saved).toEqual(['d-search', 'd-reading'])
    expect(document.querySelector('[data-resource="d-weather"]')).toBeNull()
    expect(document.querySelector('[data-resource="d-pomodoro"]')).toBeNull()
    expect(document.querySelector('[data-resource="d-ssh"]')).toBeNull()
    const seen = JSON.parse(localStorage.getItem('known.dashboard.seen-seeds.v1') ?? '[]') as string[]
    expect(seen).toEqual(dashboardModules.map((m) => m.id))
  })

  it('does not push catalog toys when seen-seeds is an empty array', async () => {
    localStorage.setItem(
      'known.dashboard.module-ids.v12',
      JSON.stringify(['d-search', 'd-reading']),
    )
    localStorage.setItem('known.dashboard.seen-seeds.v1', '[]')
    renderDashboard()
    await waitForDom(domFinishedLoading)
    const saved = JSON.parse(localStorage.getItem('known.dashboard.module-ids.v12') ?? '[]') as string[]
    expect(saved).toEqual(['d-search', 'd-reading'])
    expect(document.querySelector('[data-resource="d-weather"]')).toBeNull()
    const seen = JSON.parse(localStorage.getItem('known.dashboard.seen-seeds.v1') ?? '[]') as string[]
    expect(seen).toEqual(dashboardModules.map((m) => m.id))
  })

  it('still offers a catalog seed that is absent from both the layout and seen-seeds', async () => {
    const allIds = dashboardModules.map((m) => m.id)
    localStorage.setItem('known.dashboard.module-ids.v12', JSON.stringify(['d-search']))
    localStorage.setItem(
      'known.dashboard.seen-seeds.v1',
      JSON.stringify(allIds.filter((id) => id !== 'd-weather')),
    )
    renderDashboard()
    await waitForDom(domFinishedLoading)
    const saved = JSON.parse(localStorage.getItem('known.dashboard.module-ids.v12') ?? '[]') as string[]
    expect(saved).toEqual(['d-search', 'd-weather'])
    expect(document.querySelector('[data-resource="d-weather"]')).not.toBeNull()
    expect(document.querySelector('[data-resource="d-pomodoro"]')).toBeNull()
    const seen = JSON.parse(localStorage.getItem('known.dashboard.seen-seeds.v1') ?? '[]') as string[]
    expect(seen).toEqual(expect.arrayContaining(allIds))
  })

  it('toggles the board-tools chrome label instead of offering a "canvas tools" control', async () => {
    /* chromeOpen only feeds CanvasBoard, so the chip stays hidden in the
       stacked layout — it needs a desktop-width viewport to exist. */
    setViewportWidth(1600)
    renderDashboard()
    await waitForDom(domFinishedLoading)
    const toggle = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="dashboard-rail-chips"] button')]
      .find((button) => /board tools/i.test(button.textContent ?? ''))
    expect(toggle()?.textContent?.trim()).toBe('Show board tools')
    expect(document.body.textContent).not.toContain('canvas tools')
    act(() => toggle()?.click())
    expect(toggle()?.textContent?.trim()).toBe('Hide board tools')
    act(() => toggle()?.click())
    expect(toggle()?.textContent?.trim()).toBe('Show board tools')
  })

  it('pins only the owned publication slug and never /c/{id}', async () => {
    renderDashboard()
    await waitForDom(domFinishedLoading)

    const chips = pinChips()
    expect(chips).toHaveLength(1)
    expect(chips[0]?.getAttribute('href')).toBe('/c/notes%2Fsystems')
    expect(chips[0]?.textContent).toBe('Public notes')
    expect(
      [...(chips[0]?.querySelectorAll('*') ?? [])].some((el) => el.classList.contains('meta')),
    ).toBe(false)
    expect(document.querySelector('a[href="/c/col-owned-public"]')).toBeNull()
    expect(document.querySelector('a[href="/c/col-owned-private"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Private inbox')
    expect(document.querySelector('a[href="/classify"]')?.textContent?.trim()).toBe('Classify inbox')
    expect(document.querySelector('a[href="/library/new"]')?.textContent?.trim()).toBe('New collection')
  })

  it('asks Explore for more pins without sort on the first argument', async () => {
    renderDashboard()
    await waitForDom(domFinishedLoading)

    // StrictMode double-invokes the mount effect, so the same single request is
    // issued twice. What matters is the REQUEST — one shape, no second page —
    // and that every call carries an abort signal.
    const requests = mocks.getExploreCollections.mock.calls.map((call) => JSON.stringify(call[0]))
    expect(new Set(requests).size).toBe(1)
    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).toEqual({ limit: 8 })
    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).not.toHaveProperty('sort')
    expect(mocks.getExploreCollections.mock.calls[0]?.[0]).not.toHaveProperty('signal')
    expect(mocks.getExploreCollections.mock.calls[0]?.[1]).toEqual({
      signal: expect.any(AbortSignal),
    })
  })

  it('fills remaining pins from Explore and skips an already-owned slug', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [
        exploreItem('notes/systems', 'Owned again'),
        exploreItem('notes/systems', 'Owned again copy'),
        exploreItem('llm-learning-path', 'LLM learning path'),
        exploreItem('frontend-engineering', 'Frontend engineering'),
      ],
      nextCursor: null,
    })
    renderDashboard()
    await waitForDom(domFinishedLoading)

    const chips = pinChips()
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual([
      '/c/notes%2Fsystems',
      '/c/llm-learning-path',
    ])
    expect(chips.map((chip) => chip.textContent)).toEqual(['Public notes', 'LLM learning path'])
    expect(document.body.textContent).not.toContain('Owned again')
    expect(document.body.textContent).not.toContain('Frontend engineering')
  })

  it('keeps Library and Sync ghost chips when Explore fails and no owned path is public', async () => {
    mocks.owned.items = [ownedItem('col-owned-private', 'Private inbox', null)]
    mocks.getExploreCollections.mockRejectedValue(new Error('network'))
    renderDashboard()
    await waitForDom(domFinishedLoading)

    expect(pinChips()).toHaveLength(0)
    expect(document.querySelector('a[href="/library"]')?.textContent).toBe('Library')
    expect(document.querySelector('a[href="/sync"]')?.textContent).toBe('Sync')
    /* At 800px the layout is stacked and chromeOpen reaches nothing, so the
       board-tools chip stays hidden rather than toggling dead state. */
    expect(document.body.textContent).not.toContain('Show board tools')
    expect(document.body.textContent).not.toContain('canvas tools')
    expect(document.body.textContent).not.toContain('interface-systems')
    expect(document.body.textContent).not.toContain('ml-ops-field-notes')
    expect(document.querySelector('a[href^="/c/"]')).toBeNull()
  })

  it('does not fetch Explore once two public owned pins are available', async () => {
    mocks.owned.items = [
      ownedItem('col-one', 'First published', 'first-published'),
      ownedItem('col-two', 'Second published', 'second-published'),
      ownedItem('col-three', 'Third published', 'third-published'),
    ]
    renderDashboard()
    await waitForDom(domFinishedLoading)

    expect(mocks.getExploreCollections).not.toHaveBeenCalled()
    expect(pinChips().map((chip) => chip.getAttribute('href'))).toEqual([
      '/c/first-published',
      '/c/second-published',
    ])
    expect(document.body.textContent).not.toContain('Third published')
  })

  it('DS-10: stacked tiles compute position:relative at 390/768/899', async () => {
    for (const width of [390, 768, 899] as const) {
      cleanup()
      document.body.innerHTML = '<div id="root"></div>'
      setViewportWidth(width)
      renderDashboard()
      await waitForDom(domFinishedLoading)
      assertStackedTilesInDocumentFlow(width)
    }
  })

  it('lets a pages-layer stack reset beat the components .tile base (pages sit above components)', async () => {
    // Negative control for the cascade emulation: with `components < pages`
    // a route rule must win over component chrome, and an absolute tile
    // would only survive if the emulation still importantized components.
    replaceDashboardCascadeStyles(
      flattenLayeredCssForHappyDom([
        `@layer components { .tile { position: absolute; width: var(--w); transform: translate3d(var(--x), var(--y), 0); } }`,
        `@layer pages { .dashboard-stack .tile { position: relative; width: 100%; transform: none; } }`,
      ]),
    )
    setViewportWidth(390)
    renderDashboard()
    await waitForDom(domFinishedLoading)
    const tiles = [...document.querySelectorAll<HTMLElement>('[aria-label="Start page modules"] > [role="listitem"]')]
    expect(tiles.length).toBeGreaterThan(0)
    for (const tile of tiles) {
      expect(getComputedStyle(tile).position).toBe('relative')
    }
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps the board on the reviewed barrels with the retired mock slugs gone', () => {
      /* The rendered probes above cover the reachable half of the old source
         scan: the experimental-page notice, the Show/Hide board-tools toggle,
         the Classify/New collection links and the mock people are asserted on
         the DOM. What a render cannot show is (a) a retired slug sitting in a
         branch no test drives, and (b) which module owns the Explore read —
         the page deliberately keeps the demo module catalog from mock-data and
         reaches Explore through the api barrel rather than the client
         singleton. Those are asserted on specifiers and symbols, so renaming a
         local binding cannot make them red. */
      expect(dashboardSource).not.toContain('interface-systems')
      expect(dashboardSource).not.toContain('ml-ops-field-notes')
      expect(dashboardSource).toMatch(/from ['"]\.\.\/api['"]/u)
      expect(dashboardSource).toMatch(/from ['"]\.\.\/api\/mock-data['"]/u)
      expect(dashboardSource).not.toMatch(/\bproductClient\b/u)
    })
  })
})
