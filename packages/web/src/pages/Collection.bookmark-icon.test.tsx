// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import { Collection } from './Collection'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  loadPublicCollectionSnapshot: vi.fn(),
  recordPublicCollectionInsightEvent: vi.fn(),
  isFollowingProfile: vi.fn(),
  followProfile: vi.fn(),
  unfollowProfile: vi.fn(),
  abandonFollowIntent: vi.fn(),
  getCollectionFollowState: vi.fn(),
  followCollection: vi.fn(),
  unfollowCollection: vi.fn(),
  abandonCollectionFollowIntent: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

type MockIntersectionObserverInstance = {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  elements: Set<Element>
  disconnected: boolean
  observe: (element: Element) => void
  unobserve: (element: Element) => void
  disconnect: () => void
  trigger: (isIntersecting?: boolean) => void
}

const ioState = vi.hoisted(() => ({
  instances: [] as MockIntersectionObserverInstance[],
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      recordPublicCollectionInsightEvent: mocks.recordPublicCollectionInsightEvent,
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
      getCollectionFollowState: mocks.getCollectionFollowState,
      followCollection: mocks.followCollection,
      unfollowCollection: mocks.unfollowCollection,
      abandonCollectionFollowIntent: mocks.abandonCollectionFollowIntent,
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

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function rootNode(): PublicCollectionNode {
  return {
    id: 'root-1', parentId: null, kind: 'root', title: 'Published contents',
    description: 'A complete reading hierarchy.', url: null, position: null,
  }
}

function bookmark(
  id: string,
  parentId = 'root-1',
  url = `https://${id}.example/path`,
  iconUrl?: string | null,
): PublicCollectionNode {
  return {
    id, parentId, kind: 'bookmark', title: id, description: `${id} description`, url, position: id,
    ...(iconUrl !== undefined ? { iconUrl } : {}),
  }
}

function snapshot(
  nodes: PublicCollectionNode[] = [rootNode(), bookmark('First source')],
  access: 'public' | 'member' = 'public',
  extras: { faviconCdnAllowed?: boolean } = {},
): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-public',
      slug: 'research-notes',
      title: 'Research notes',
      summary: 'A maintained map of primary sources and practical references.',
      kind: 'bookmarks',
      rootNodeId: 'root-1',
      owner: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'curator',
        displayName: 'Curator', avatarUrl: null,
      },
      updatedAt: '2026-07-24T00:00:00.000Z',
      access,
      ...extras,
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 2 },
  }
}

const OBJECT_ID = '01234567-89ab-4cde-8f01-23456789abcd'
const OBJECT_ICON = `https://known.example/api/v1/favicon/${OBJECT_ID}`
const GITHUB_CDN = 'https://a.favicon.im/github.com?throw-error-on-404=true'

function imgSrcs(root: ParentNode = document): string[] {
  return [...root.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '')
}

function thirdPartyFaviconSrcs(root: ParentNode = document): string[] {
  return imgSrcs(root).filter((src) => /favicon\.im|icons\.duckduckgo\.com/i.test(src))
}

function insightPayloads() {
  return mocks.recordPublicCollectionInsightEvent.mock.calls.map(([input]) => input)
}

function previewObservers(): MockIntersectionObserverInstance[] {
  return ioState.instances.filter((instance) => instance.options?.threshold === 0.25)
}

describe('public Collection bookmark icons (BF-05)', () => {
  let previousIntersectionObserver: typeof IntersectionObserver | undefined
  let captureSearch = ''

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('VITE_FOLLOW_ACCEPTANCE', 'true')
    mocks.isFollowingProfile.mockResolvedValue(false)
    mocks.recordPublicCollectionInsightEvent.mockResolvedValue(undefined)
    mocks.getCollectionFollowState.mockResolvedValue({ following: false, followerCount: 0, followedAt: null })
    ioState.instances.length = 0
    window.sessionStorage.clear()
    window.localStorage.clear()
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
    previousIntersectionObserver = globalThis.IntersectionObserver
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null
      readonly rootMargin: string
      readonly thresholds: readonly number[]
      readonly callback: IntersectionObserverCallback
      readonly options?: IntersectionObserverInit
      readonly elements = new Set<Element>()
      disconnected = false

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.callback = callback
        this.options = options
        this.rootMargin = options?.rootMargin ?? '0px'
        this.thresholds = typeof options?.threshold === 'number'
          ? [options.threshold]
          : options?.threshold ?? [0]
        ioState.instances.push(this)
      }

      observe(element: Element) {
        this.elements.add(element)
      }

      unobserve(element: Element) {
        this.elements.delete(element)
      }

      disconnect() {
        this.disconnected = true
      }

      takeRecords(): IntersectionObserverEntry[] {
        return []
      }

      trigger(isIntersecting = true) {
        const entries = [...this.elements].map((target) => ({
          isIntersecting,
          intersectionRatio: isIntersecting ? 0.5 : 0,
          target,
          time: 0,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
        })) as IntersectionObserverEntry[]
        this.callback(entries, this)
      }
    }
    globalThis.IntersectionObserver = MockIntersectionObserver
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    if (previousIntersectionObserver) {
      globalThis.IntersectionObserver = previousIntersectionObserver
    }
  })

  function SyncPath({ path }: { path: string }) {
    const navigate = useNavigate()
    const location = useLocation()
    useEffect(() => {
      const url = new URL(path, 'http://local.test')
      if (location.pathname !== url.pathname) {
        navigate(`${url.pathname}${url.search}`, { replace: true })
      }
    }, [path, location.pathname, location.search, navigate])
    return null
  }

  function CaptureSearch() {
    const location = useLocation()
    captureSearch = location.search
    return null
  }

  function renderCollection(path = '/c/research-notes') {
    const host = document.getElementById('test-root')
    if (!host) throw new Error('test root missing')
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <SyncPath path={path} />
          <CaptureSearch />
          <Routes>
            <Route path="/c/:slug" element={<Collection />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  describe('bookmark icons (BF-05)', () => {
    function viewButton(label: string): HTMLButtonElement {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === label)
      if (!button) throw new Error(`${label} button missing`)
      return button
    }

    async function showCompact() {
      await act(async () => viewButton('Compact').click())
    }

    it('hotlinks the exact CDN src when faviconCdnAllowed is true and iconUrl is missing', async () => {
      // The snapshot endpoint answers every mount with this projection:
      // StrictMode's remount re-reads it, so the fixture must not be a
      // one-shot queue.
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web')],
        'public',
        { faviconCdnAllowed: true },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      expect(imgSrcs()).toContain(GITHUB_CDN)
      expect(imgSrcs()).not.toContain('https://favicon.im/github.com')
      expect(imgSrcs().some((src) => src.includes('icons.duckduckgo.com'))).toBe(false)
    })

    it('does not hotlink CDN when faviconCdnAllowed is absent', async () => {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web')],
        'public',
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      expect(thirdPartyFaviconSrcs()).toEqual([])
      expect(document.querySelector('[data-collection-resource] span[aria-hidden]')?.textContent).toBe('G')
    })

    it('does not hotlink CDN when faviconCdnAllowed is false', async () => {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web')],
        'public',
        { faviconCdnAllowed: false },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      expect(thirdPartyFaviconSrcs()).toEqual([])
      expect(document.querySelector('[data-collection-resource] span[aria-hidden]')?.textContent).toBe('G')
    })

    it('does not hotlink CDN for a node whose owner set the icon source to none', async () => {
      // The collection allows the CDN, but this exact node carries the explicit
      // node-level opt-out. The server sends faviconCdnAllowed:false on that
      // bookmark node only; the sibling keeps the collection-level fallback.
      const optedOut: PublicCollectionNode = {
        ...bookmark('Opted out', 'root-1', 'https://github.com/know-n/web'),
        faviconCdnAllowed: false,
      }
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), optedOut, bookmark('Still allowed', 'root-1', 'https://gitlab.com/know-n/web')],
        'public',
        { faviconCdnAllowed: true },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      const srcs = thirdPartyFaviconSrcs()
      expect(srcs).toEqual(['https://a.favicon.im/gitlab.com?throw-error-on-404=true'])
      const rows = [...document.querySelectorAll('[data-collection-resource]')]
      const optedOutRow = rows.find((row) => row.textContent?.includes('Opted out'))
      expect(optedOutRow?.querySelector('span[aria-hidden]')?.textContent).toBe('G')
    })

    it('lets a node-level false override an allowed sibling response field', async () => {
      const optedOut: PublicCollectionNode = {
        ...bookmark('Opted out', 'root-1', 'https://github.com/know-n/web'),
        faviconCdnAllowed: false,
      }
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), optedOut],
        'public',
        { faviconCdnAllowed: true },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      expect(thirdPartyFaviconSrcs()).toEqual([])
    })

    it('renders a same-origin object iconUrl and not the CDN', async () => {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web', OBJECT_ICON)],
        'public',
        { faviconCdnAllowed: true },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      expect(imgSrcs()).toContain(OBJECT_ICON)
      expect(imgSrcs().some((src) => src.includes('/api/v1/favicon/'))).toBe(true)
      expect(thirdPartyFaviconSrcs()).toEqual([])
      const img = document.querySelector<HTMLImageElement>(`img[src="${OBJECT_ICON}"]`)
      expect(img?.getAttribute('alt')).toBe('')
      expect(img?.getAttribute('loading')).toBe('lazy')
      expect(img?.getAttribute('decoding')).toBe('async')
      expect(img?.getAttribute('referrerpolicy') ?? img?.referrerPolicy).toMatch(/no-referrer/i)
    })

    it('does not hotlink CDN on a member projection even with public github.com URLs', async () => {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web')],
        'member',
        { faviconCdnAllowed: false },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      expect(document.body.textContent).toContain('Shared with you')
      expect(document.body.textContent).not.toContain('Public view')
      expect(thirdPartyFaviconSrcs()).toEqual([])
      expect(document.querySelector('[data-collection-resource] span[aria-hidden]')?.textContent).toBe('G')
    })

    it('compact view has an icon slot for object, CDN, and letter', async () => {
      const cases: Array<{
        name: string
        iconUrl?: string | null
        faviconCdnAllowed?: boolean
        expectObject?: boolean
        expectCdn?: boolean
        expectLetter?: boolean
      }> = [
        { name: 'object', iconUrl: OBJECT_ICON, faviconCdnAllowed: true, expectObject: true },
        { name: 'cdn', faviconCdnAllowed: true, expectCdn: true },
        { name: 'letter', faviconCdnAllowed: false, expectLetter: true },
      ]
      for (const row of cases) {
        cleanup()
        document.body.innerHTML = '<div id="test-root"></div>'
        mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
          [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web', row.iconUrl)],
          'public',
          row.faviconCdnAllowed === undefined ? {} : { faviconCdnAllowed: row.faviconCdnAllowed },
        ))
        renderCollection()
        await waitForDom(domFinishedLoading)
        await showCompact()
        const compact = document.querySelector('[data-collection-view="compact"] .library-bookmark--compact')
        expect(compact, row.name).not.toBeNull()
        const slot = compact?.firstElementChild ?? null
        expect(slot?.classList.contains('compact-icon'), `${row.name} compact icon slot`).toBe(true)
        const srcs = imgSrcs(compact ?? document)
        if (row.expectObject) {
          expect(srcs, row.name).toContain(OBJECT_ICON)
          expect(thirdPartyFaviconSrcs(compact ?? document), row.name).toEqual([])
        }
        if (row.expectCdn) {
          expect(srcs, row.name).toContain(GITHUB_CDN)
        }
        if (row.expectLetter) {
          expect(thirdPartyFaviconSrcs(compact ?? document), row.name).toEqual([])
          expect(compact?.querySelector('span[aria-hidden]')?.textContent, row.name).toBe('G')
          expect(srcs.some((src) => src.includes('/api/v1/favicon/')), row.name).toBe(false)
        }
      }
    })

    it('object img onerror falls back to letter and never sets a CDN src', async () => {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
        [rootNode(), bookmark('Repo note', 'root-1', 'https://github.com/know-n/web', OBJECT_ICON)],
        'public',
        { faviconCdnAllowed: true },
      ))
      renderCollection()
      await waitForDom(domFinishedLoading)
      const img = document.querySelector<HTMLImageElement>(`img[src="${OBJECT_ICON}"]`)
      if (!img) throw new Error('object favicon img missing')
      await act(async () => {
        img.dispatchEvent(new Event('error'))
      })
      expect(thirdPartyFaviconSrcs()).toEqual([])
      expect(imgSrcs().filter((src) => src.includes('/api/v1/favicon/'))).toEqual([])
      expect(document.querySelector('[data-collection-resource] span[aria-hidden]')?.textContent).toBe('G')
    })

    it('compact rows use Library bookmark slots: mark, title, mid, host', async () => {
      mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
        rootNode(),
        {
          id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Foundations',
          description: null, url: null, position: 'a',
        },
        bookmark('Repo note', 'folder-1', 'https://github.com/know-n/web'),
      ]))
      // Drill-down semantics: the bookmark row lives inside its folder layer.
      renderCollection('/c/research-notes?folder=folder-1')
      await waitForDom(domFinishedLoading)
      await showCompact()
      const row = document.querySelector('[data-collection-view="compact"] .library-bookmark--compact')
      if (!row) throw new Error('compact row missing')
      const slots = [...row.children].map((node) => node.className)
      expect(slots[0]).toContain('compact-icon')
      expect(slots[1]).toContain('library-bookmark-body')
      expect(slots[2]).toContain('library-bookmark-mid')
      expect(slots[3]).toContain('library-bookmark-host')
      expect(row.textContent).not.toMatch(/•\s*PAPER/u)
      expect([...row.querySelectorAll('*')].some((el) => el.classList.contains('compact-type'))).toBe(false)
      // Direct children of the open folder repeat no path — the breadcrumb
      // above already names the layer (search results keep a relative path).
      // Slot positions were asserted above: mid is the third, host the fourth.
      expect(row.children[2]?.textContent).toBe('')
      expect(row.children[3]?.textContent).toBe('github.com')
    })
  })
})
