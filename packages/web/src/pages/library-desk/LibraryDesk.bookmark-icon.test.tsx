// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../../api/featureFlags'
import type { EditableNodeView, EditorSnapshot, OwnedCollectionListItem } from '../../api/types'
import { LibraryDesk } from './LibraryDesk'
import librarySource from './LibraryDesk.tsx?raw'
import bookmarkItemSource from './bookmarkItem.tsx?raw'
import { setUiDensity } from '../../lib/useUiDensity'
import { resetLinkPreviewRequestsForTests } from '../../lib/useLinkPreviewRequests'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false, refreshSession: vi.fn(async () => undefined) },
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  loadAnnotations: vi.fn(async () => []),
  createCollectionNode: vi.fn(),
  requestLinkPreviews: vi.fn(async () => ({ enqueued: 1 })),
  collections: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    hasMore: false,
    isLoadingMore: false,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  },
  shared: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    hasMore: false,
    isLoadingMore: false,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  },
  invites: {
    items: [] as Array<{
      inviteId: string
      collectionId: string
      collectionTitle: string
      role: 'editor' | 'viewer'
      email: string
      expiresAt: string
      invitedAt: string
    }>,
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: '',
    pendingInviteId: null as string | null,
    reload: vi.fn(async () => undefined),
    accept: vi.fn(async () => ({ collectionId: 'col-shared', subjectId: 'sub-b', role: 'editor' as const, grantedAt: '2026-08-19T00:00:00.000Z', policyEtag: '"p-2"' })),
    decline: vi.fn(async () => undefined),
  },
}))

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))
vi.mock('../../lib/useOwnedCollections', () => ({ useOwnedCollections: () => mocks.collections }))
vi.mock('../../lib/useSharedCollections', () => ({ useSharedCollections: () => mocks.shared }))
vi.mock('../../lib/useMyCollaborationInvites', () => ({ useMyCollaborationInvites: () => mocks.invites }))
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadAnnotations: mocks.loadAnnotations,
      createCollectionNode: mocks.createCollectionNode,
      requestLinkPreviews: mocks.requestLinkPreviews,
      listFollowedCollections: vi.fn(async () => ({ items: [], nextCursor: null })),
      listFollowedReports: vi.fn(async () => ({ items: [], nextCursor: null })),
      listMyReports: vi.fn(async () => ({ items: [], nextCursor: null })),
      getFollowedReportIssuesPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      getMyLibraryOrder: vi.fn(async () => ({ sections: { mine: [], shared: [], following: [] } })),
      updateMyLibraryOrder: vi.fn(async () => ({ section: 'mine', collectionIds: [] })),
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

function collectionItem(
  id: string,
  title: string,
  overrides?: Pick<OwnedCollectionListItem, 'bookmarkCount'>,
): OwnedCollectionListItem {
  return {
    collection: {
      id,
      kind: 'bookmarks',
      title,
      summary: 'Saved research',
      visibility: 'private',
      allowSearchIndexing: false,
      publicationSlug: null,
      publishedAt: null,
      rootNodeId: `root-${id}`,
      revision: '1',
      etag: `"c-${id}"`,
      contentRevision: '1',
      contentEtag: `"cc-${id}"`,
      policyRevision: '1',
      policyEtag: `"p-${id}"`,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    ...overrides,
  }
}

function snapshotRequestedIds() {
  return mocks.loadEditorSnapshot.mock.calls.map((args) => args[0] as string)
}

function rejectSnapshot(id: string) {
  return Promise.reject(new Error(`must not prefetch ${id}`))
}

function extraBookmark(
  id: string,
  collectionId: string,
  parentId: string,
  position: string,
  title: string,
  url?: string,
  iconUrl?: string | null,
): EditableNodeView {
  return {
    id,
    collectionId,
    kind: 'bookmark',
    title,
    url: url ?? `https://${id}.example`,
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: '1',
    etag: `"n-${id}"`,
    parentId,
    position,
    readOnly: false,
    readOnlyReason: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    ...(iconUrl !== undefined ? { iconUrl } : {}),
  }
}

function thirdPartyFaviconSrcs(root: ParentNode = document): string[] {
  return [...root.querySelectorAll('img')]
    .map((img) => img.getAttribute('src') ?? '')
    .filter((src) => /a\.favicon\.im|favicon\.im|icons\.duckduckgo\.com/i.test(src))
}

function snapshot(id = 'col-1', title = 'Reading queue'): EditorSnapshot {
  return {
    collection: collectionItem(id, title).collection,
    root: {
      id: `root-${id}`,
      collectionId: id,
      kind: 'folder',
      folderRole: 'root',
      parentId: null,
      position: null,
      title: 'Root',
      description: null,
      tags: [],
      visibility: 'inherit',
      revision: '1',
      etag: `"root-${id}"`,
      readOnly: false,
      readOnlyReason: null,
      childrenRevision: '1',
      childrenEtag: `"root-c-${id}"`,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    nodes: [
      {
        id: `${id}-folder`,
        collectionId: id,
        kind: 'folder',
        folderRole: null,
        parentId: `root-${id}`,
        position: 'a',
        title: 'Later',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: `"f-${id}"`,
        readOnly: false,
        readOnlyReason: null,
        childrenRevision: '1',
        childrenEtag: `"fc-${id}"`,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
      {
        id: `${id}-first`,
        collectionId: id,
        kind: 'bookmark',
        title: 'First page item',
        url: 'https://first.example',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: `"n-${id}"`,
        parentId: `${id}-folder`,
        position: 'b',
        readOnly: false,
        readOnlyReason: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
      {
        id: `${id}-loose`,
        collectionId: id,
        kind: 'bookmark',
        title: 'Loose bookmark',
        url: 'https://loose.example',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: `"l-${id}"`,
        parentId: `root-${id}`,
        position: 'c',
        readOnly: false,
        readOnlyReason: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
    ],
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: {
      snapshotId: `snap-${id}`,
      contentRevision: '1',
      policyRevision: '1',
      comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z',
      returnedCount: 3,
      hasMore: false,
      nextCursor: null,
    },
  } as EditorSnapshot
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}</p>
}

function mount(path = '/library/col-1') {
  mountTree(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/library/:id?" element={<LibraryDesk />} />
          <Route path="/library/:id/edit" element={<p data-testid="editor-route">Editor</p>} />
          <Route path="/login" element={<p>Login</p>} />
        </Routes>
      </MemoryRouter>,
    )
}

function setControlValue(control: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  act(() => {
    setter.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function settleAnnotationReads() {
  await act(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const count = mocks.loadAnnotations.mock.results.length
      await Promise.all(mocks.loadAnnotations.mock.results.map((result) => Promise.resolve(result.value)))
      await Promise.resolve()
      if (mocks.loadAnnotations.mock.results.length === count) return
    }
    throw new Error('annotation reads did not settle')
  })
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the private library renders host letters and never emits a
 *    third-party favicon request, including when the node carries a
 *    third-party `iconUrl` or a public `github.com` page URL. Probed against
 *    the real `LibraryDesk` with the client mocked; this is what the browser
 *    would actually fetch.
 *
 * 2. Architecture — the *explicit* opt-out at the call site and the absence of
 *    a hardcoded CDN host in this tree. `faviconCdnAllowed: undefined` renders
 *    identically to `false` today, so no probe can distinguish them — but the
 *    day the default flips to allowed, `undefined` starts leaking private
 *    hosts while `false` does not. That difference is invisible to any render
 *    and is exactly what the literal pins.
 */
describe('LibraryDesk bookmark icons (BF-05) behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    delete window.__KNOWN_FLAGS__
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.collections.items = [collectionItem('col-1', 'Reading queue'), collectionItem('col-2', 'Second shelf')]
    mocks.collections.state = 'ready'
    mocks.collections.message = ''
    mocks.shared.items = []
    mocks.shared.state = 'ready'
    mocks.shared.message = ''
    mocks.invites.items = []
    mocks.invites.state = 'ready'
    mocks.invites.message = ''
    mocks.invites.pendingInviteId = null
    mocks.invites.accept.mockResolvedValue({
      collectionId: 'col-shared', subjectId: 'sub-b', role: 'editor',
      grantedAt: '2026-08-19T00:00:00.000Z', policyEtag: '"p-2"',
    })
    mocks.invites.decline.mockResolvedValue(undefined)
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === 'col-2' ? 'Second shelf' : id === 'col-shared' ? 'Live Shared Shelf' : 'Reading queue')))
    setUiDensity('comfortable')
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  it('LP-07: Gallery shows same-origin covers and asks only for the missing ones', async () => {
    resetLinkPreviewRequestsForTests()
    mocks.requestLinkPreviews.mockClear()
    const cover = { url: `${window.location.origin}/api/v1/link-preview/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`, width: 1200, height: 630 }
    const owned = snapshot('col-2', 'Second shelf')
    owned.nodes = [
      owned.nodes[0]!,
      { ...extraBookmark('with', 'col-2', 'root-col-2', 'b', 'Covered item', 'https://news.example.test/a'), previewImage: cover } as EditableNodeView,
      { ...extraBookmark('without', 'col-2', 'root-col-2', 'c', 'Plain item', 'https://blog.example.test/b'), previewImage: null } as EditableNodeView,
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(id === 'col-2' ? owned : snapshot(id, 'Reading queue')))
    // col-2: the desk caches trees by id, and later tests reuse col-1.
    try {
      mount('/library/col-2')
      await waitForDom(domFinishedLoading)
      const gallery = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="View"] button')]
        .find((button) => button.textContent?.trim() === 'Gallery')
      expect(gallery).toBeDefined()
      act(() => gallery!.click())
      await waitForDom(() => document.querySelector('[data-testid="library-bookmarks"] [data-gallery-card]') !== null)
      const covered = document.querySelector('[data-gallery-card][data-node-id="with"]')
      expect(covered?.querySelector('img')?.getAttribute('src')).toBe(cover.url)
      expect(document.querySelector('[data-gallery-card][data-node-id="without"] img')).toBeNull()
      await waitForDom(() => mocks.requestLinkPreviews.mock.calls.length > 0)
      expect(mocks.requestLinkPreviews.mock.calls[0]!.slice(0, 2)).toEqual(['col-2', ['without']])
      expect(thirdPartyFaviconSrcs()).toEqual([])
      expect(window.localStorage.getItem('known.library.gallery.v1')).toBe('true')
    } finally {
      window.localStorage.removeItem('known.library.gallery.v1')
    }
  })

  it('does not hotlink favicon.im or DuckDuckGo for intranet or github bookmarks', async () => {
    const owned = snapshot('col-1', 'Reading queue')
    owned.nodes = [
      owned.nodes[0]!,
      extraBookmark('gh', 'col-1', 'col-1-folder', 'b', 'GitHub item', 'https://github.com/know-n/web'),
      extraBookmark('intra', 'col-1', `root-col-1`, 'c', 'Intranet item', 'https://intranet.example.test/board'),
      /* Two adversarial rows: a node that already carries a third-party CDN
         icon URL, and one whose public page URL a CDN fallback would happily
         serve. With `faviconCdnAllowed: false` both must fall back to the host
         letter; flipping that flag to true makes the first render leak
         `a.favicon.im` here. */
      extraBookmark(
        'cdn-object', 'col-1', 'col-1-folder', 'd', 'CDN icon item',
        'https://github.com/know-n/cdn', 'https://a.favicon.im/github.com?throw-error-on-404=true',
      ),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      if (id === 'col-1') return Promise.resolve(owned)
      return Promise.resolve(snapshot(id, id === 'col-shared' ? 'Live Shared Shelf' : 'Reading queue'))
    })
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    // The subtree filter flattens both rows (root + folder) into one list.
    setControlValue(document.querySelector<HTMLInputElement>('[data-testid="library-desk-search"] input')!, 'item')
    expect(FEATURE_FLAGS.collectionFollow).toBe(true)
    expect(document.body.textContent).toContain('GitHub item')
    expect(document.body.textContent).toContain('Intranet item')
    expect(document.body.textContent).toContain('CDN icon item')
    expect(thirdPartyFaviconSrcs()).toEqual([])
    /* The adversarial row really rendered, and it really used the letter
       fallback instead of the CDN URL it was handed. */
    const bookmarkRows = () => [...document.querySelectorAll('[data-node-id]')]
    const cdnRow = bookmarkRows()
      .find((row) => row.textContent?.includes('CDN icon item'))
    expect(cdnRow).toBeDefined()
    expect(cdnRow?.querySelector('[data-testid="library-host-letter"]')).not.toBeNull()
    expect(cdnRow?.querySelector('img')).toBeNull()
    /* Every rendered row uses the letter fallback — the loop is over the real
       rows, so a single row that started emitting a favicon request fails. */
    const renderedRows = bookmarkRows()
    expect(renderedRows.length).toBeGreaterThanOrEqual(3)
    for (const row of renderedRows) {
      expect(row.querySelector('img'), row.textContent ?? '').toBeNull()
    }
    expect(document.querySelector('[data-testid="library-host-letter"]')).not.toBeNull()
    expect(document.querySelector('img[src*="a.favicon.im"]')).toBeNull()
    expect(document.querySelector('img[src*="favicon.im"]')).toBeNull()
    expect(document.querySelector('img[src*="icons.duckduckgo.com"]')).toBeNull()
    expect(document.querySelector('img[src*="/api/v1/favicon/"]')).toBeNull()
    act(() => setUiDensity('compact'))
    await waitForDom(domFinishedLoading)
    expect(thirdPartyFaviconSrcs()).toEqual([])
    expect(document.querySelector('[data-density="compact"] [data-testid="library-host-letter"]')).not.toBeNull()
  })

  it('does not hotlink third-party favicons on a shared collection with public github URLs', async () => {
    mocks.shared.items = [collectionItem('col-shared', 'Team research')]
    const shared = snapshot('col-shared', 'Live Shared Shelf')
    shared.nodes = [
      shared.nodes[0]!,
      extraBookmark('gh', 'col-shared', 'col-shared-folder', 'b', 'Shared GitHub', 'https://github.com/org/repo'),
      extraBookmark('intra', 'col-shared', `root-col-shared`, 'c', 'Shared intranet', 'https://intranet.example.test/wiki'),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      if (id === 'col-shared') return Promise.resolve(shared)
      return Promise.resolve(snapshot(id, 'Reading queue'))
    })
    mount('/library/col-shared')
    await waitForDom(domFinishedLoading)
    // The subtree filter flattens both rows (root + folder) into one list.
    setControlValue(document.querySelector<HTMLInputElement>('[data-testid="library-desk-search"] input')!, 'Shared')
    await settleAnnotationReads()
    expect(document.body.textContent).toContain('Shared GitHub')
    expect(thirdPartyFaviconSrcs()).toEqual([])
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('passes an explicit third-party-favicon opt-out and keeps the CDN host out of this tree', () => {
    /* The reachable half is proven behaviourally above: with the adversarial
       rows in place no third-party favicon request is emitted. What a render
       cannot show is the difference between `faviconCdnAllowed: false` and an
       omitted/undefined flag — both produce the host letter today, and both
       keep this suite green — while only the explicit `false` survives a
       future change of `bookmarkIconSrc`'s default. The CDN host literal
       belongs to lib/bookmarkIcon.ts alone; a copy of it in the library desk
       would only matter on a branch the probe does not take. Asserted on the
       call-site literal and the host names, so renaming anything else is
       irrelevant. */
    expect(FEATURE_FLAGS.collectionFollow).toBe(true)
    /* Both sources are concatenated below, so a `?raw` import that resolved to
       an empty string would leave the presence check passing on the other
       file and silently narrow the absence scan. */
    expect(librarySource.length).toBeGreaterThan(8_000)
    expect(bookmarkItemSource.length).toBeGreaterThan(1_500)
    expect(librarySource + bookmarkItemSource).toContain('faviconCdnAllowed: false')
    expect(librarySource + bookmarkItemSource).not.toMatch(/a\.favicon\.im|favicon\.im|icons\.duckduckgo\.com/)
  })
})
