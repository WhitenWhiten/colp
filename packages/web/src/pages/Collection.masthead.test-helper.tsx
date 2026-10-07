// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import { collectLayeredRules, readStyle } from '../styles/dashboard-stack-cascade.test-helper'
import { Collection } from './Collection'
import { ioState, mocks } from './Collection.masthead.test-mocks'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

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
): PublicCollectionNode {
  return {
    id, parentId, kind: 'bookmark', title: id, description: `${id} description`, url, position: id,
  }
}

function snapshot(
  nodes: PublicCollectionNode[] = [rootNode(), bookmark('First source')],
  access: 'public' | 'member' = 'public',
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
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 2 },
  }
}


let previousIntersectionObserver: typeof IntersectionObserver | undefined
function installMastheadHarness(): void {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('VITE_FOLLOW_ACCEPTANCE', 'true')
    delete window.__KNOWN_FLAGS__
    window.__KNOWN_FLAGS__ = { collectionFollow: false }
    mocks.isFollowingProfile.mockResolvedValue(false)
    mocks.getCollectionFollowState.mockResolvedValue({ following: false, followerCount: 3, followedAt: null })
    mocks.followCollection.mockResolvedValue({
      following: true, followerCount: 4, followedAt: '2026-08-26T01:00:00.000Z',
    })
    mocks.recordPublicCollectionInsightEvent.mockResolvedValue(undefined)
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
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = ''
    document.getElementById('masthead-clamp-test')?.remove()
    if (previousIntersectionObserver) {
      globalThis.IntersectionObserver = previousIntersectionObserver
    }
  })

}

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

function renderCollection(path = '/c/research-notes') {
  const host = document.getElementById('test-root')
    if (!host) throw new Error('test root missing')
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <SyncPath path={path} />
          <Routes>
            <Route path="/c/:slug" element={<Collection />} />
          </Routes>
        </MemoryRouter>,
      )
  }

export { mocks, ioState, rootNode, bookmark, snapshot, renderCollection, installMastheadHarness }
