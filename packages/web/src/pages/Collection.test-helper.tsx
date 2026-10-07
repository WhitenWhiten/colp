/**
 * Shared scaffold for the public Collection page suites
 * (Collection.test.tsx, Collection.folders.test.tsx).
 *
 * Each test file still registers its own vi.mock(...) factories; those
 * factories `await import('./Collection.test-mocks')` (the leaf module,
 * never this one — importing this helper from a factory deadlocks the
 * module graph). `captureSearch` / `navigateBack` are live ES-module
 * bindings updated by the router probes mounted in renderCollection.
 */
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { vi } from 'vitest'
import { NavigationScrollManager } from '../components/NavigationScrollManager'
import { clearRouteCache } from '../lib/routeCache'
import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import { Collection } from './Collection'
import { cleanup, mountTree } from '../test/render'
import { ioState, mocks, type MockIntersectionObserverInstance } from './Collection.test-mocks'

export { ioState, mocks, type MockIntersectionObserverInstance } from './Collection.test-mocks'

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

export function rootNode(): PublicCollectionNode {
  return {
    id: 'root-1', parentId: null, kind: 'root', title: 'Published contents',
    description: 'A complete reading hierarchy.', url: null, position: null,
  }
}

export function bookmark(
  id: string,
  parentId = 'root-1',
  url: string | null = `https://${id}.example/path`,
): PublicCollectionNode {
  return {
    id, parentId, kind: 'bookmark', title: id, description: `${id} description`, url, position: id,
  }
}

export function snapshot(
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

export function insightPayloads() {
  return mocks.recordPublicCollectionInsightEvent.mock.calls.map(([input]) => input)
}

export function previewObservers(): MockIntersectionObserverInstance[] {
  return ioState.instances.filter((instance) => instance.options?.threshold === 0.25)
}

export let captureSearch = ''
export let navigateBack: () => void = () => {}

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

function CaptureNavigate() {
  const navigate = useNavigate()
  navigateBack = () => navigate(-1)
  return null
}

/** Page text outside the folder cards. A layer's folder cards may preview
    the bookmarks inside them; this is what the layer itself renders, so
    "a nested bookmark stays a level down" checks read it instead of body. */
export function textOutsideFolderCards(): string {
  const copy = document.body.cloneNode(true) as HTMLElement
  for (const layer of copy.querySelectorAll('[data-collection-folder-layer]')) layer.remove()
  return copy.textContent ?? ''
}

export function renderCollection(path = '/c/research-notes') {
  const host = document.getElementById('test-root')
  if (!host) throw new Error('test root missing')
  mountTree(
      <MemoryRouter initialEntries={[path]}>
        <NavigationScrollManager />
        <SyncPath path={path} />
        <CaptureSearch />
        <CaptureNavigate />
        <Routes>
          <Route path="/c/:slug" element={<Collection />} />
        </Routes>
      </MemoryRouter>,
    )
}

let previousIntersectionObserver: typeof IntersectionObserver | undefined

/** beforeEach body shared by every Collection page suite. */
export function setUpCollectionPage() {
  clearRouteCache()
  vi.clearAllMocks()
  vi.stubEnv('VITE_FOLLOW_ACCEPTANCE', 'true')
  mocks.isFollowingProfile.mockResolvedValue(false)
  mocks.recordPublicCollectionInsightEvent.mockResolvedValue(undefined)
  mocks.getCollectionFollowState.mockResolvedValue({ following: false, followerCount: 0, followedAt: null })
  mocks.getCommunityComments.mockResolvedValue({ items: [], nextCursor: null })
  ioState.instances.length = 0
  captureSearch = ''
  navigateBack = () => {}
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
}

/** afterEach body shared by every Collection page suite. */
export function tearDownCollectionPage() {
  cleanup()
  document.body.innerHTML = ''
  if (previousIntersectionObserver) {
    globalThis.IntersectionObserver = previousIntersectionObserver
  }
}
