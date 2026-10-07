// @vitest-environment happy-dom
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { EditorSnapshot, PublicCollectionSnapshot } from '../api/types'
import { ResourceDetail } from './ResourceDetail'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

/* R15-07: the bookmark detail page must never hotlink the third-party
   favicon CDN for a private (editor) projection; a public projection with
   the collection gate open still may. */

const NODE_ID = 'nd-private-1'
const mocks = vi.hoisted(() => ({
  loadEditorSnapshot: vi.fn(), loadPublicCollectionSnapshot: vi.fn(),
  auth: { isLoggedIn: true, bootstrapping: false },
}))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: () => false,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

const bookmark = {
  id: NODE_ID, collectionId: 'collection-1', kind: 'bookmark', title: 'Internal runbook',
  url: 'https://wiki.private-host.example/runbook', iconUrl: null, description: null, tags: [],
  visibility: 'inherit', revision: 'n1', etag: '"n1"', parentId: 'root', position: 'a',
  readOnly: false, readOnlyReason: null,
  createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
}

function editor(): EditorSnapshot {
  return {
    collection: {
      id: 'collection-1', title: 'Private', kind: 'bookmarks', summary: '', visibility: 'private',
      allowSearchIndexing: false, rootNodeId: 'root', publicationSlug: null, publishedAt: null,
      revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '',
    },
    root: {
      id: 'root', collectionId: 'collection-1', kind: 'folder', folderRole: 'root', parentId: null,
      position: null, title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr',
      etag: '"rr"', readOnly: false, readOnlyReason: null, childrenRevision: 'cr', childrenEtag: '"cr"',
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    },
    nodes: [bookmark],
    capabilities: {
      updateCollection: true, managePublication: true, createNode: true,
      updateNode: true, moveNode: true, deleteNode: true,
    },
    page: {
      snapshotId: 's', contentRevision: 'cc1', policyRevision: 'p1', comparatorVersion: 'v1',
      expiresAt: '', returnedCount: 1, hasMore: false, nextCursor: null,
    },
  } as EditorSnapshot
}

function publicSnapshot(faviconCdnAllowed: boolean, nodeCdnAllowed?: boolean): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'collection-1', title: 'Public', kind: 'bookmarks', slug: 'public', rootNodeId: 'root',
      faviconCdnAllowed,
    },
    nodes: [{
      ...bookmark,
      url: 'https://public.example/post',
      ...(nodeCdnAllowed === undefined ? {} : { faviconCdnAllowed: nodeCdnAllowed }),
    }],
    page: { hasMore: false, nextCursor: null },
  } as unknown as PublicCollectionSnapshot
}

function mountAt(path: string) {
  mountTree(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
    </MemoryRouter>,
  )
}

function markSrcs(): string[] {
  return [...document.querySelectorAll('[data-testid="domain-mark"] img')].map((img) => img.getAttribute('src') ?? '')
}

describe('ResourceDetail favicon CDN gate', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  it('never requests favicon.im for a private editor-snapshot bookmark without a stored icon', async () => {
    mountAt(`/r/${NODE_ID}?collectionId=collection-1&subjectType=node`)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="domain-mark"]')).not.toBeNull()
    expect(markSrcs()).toEqual([])
    expect(document.body.innerHTML).not.toContain('favicon.im')
    // A private desk bookmark is the viewer's own; nothing to report.
    expect(document.querySelector('[data-testid="report-bookmark"]')).toBeNull()
  })

  it('still uses the CDN on a public projection with the collection gate open', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(publicSnapshot(true))
    mountAt(`/r/${NODE_ID}?slug=public`)
    await waitForDom(domFinishedLoading)
    expect(markSrcs()).toEqual(['https://a.favicon.im/public.example?throw-error-on-404=true'])
    // R15-11: public bookmark pages carry a report path.
    expect(document.querySelector('[data-testid="report-bookmark"]')?.textContent).toBe('Report')
  })

  it('honours the collection gate and the per-node opt-out on public projections', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(publicSnapshot(false))
    mountAt(`/r/${NODE_ID}?slug=public`)
    await waitForDom(domFinishedLoading)
    expect(markSrcs()).toEqual([])
    cleanup()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(publicSnapshot(true, false))
    mountAt(`/r/${NODE_ID}?slug=public`)
    await waitForDom(domFinishedLoading)
    expect(markSrcs()).toEqual([])
  })
})
