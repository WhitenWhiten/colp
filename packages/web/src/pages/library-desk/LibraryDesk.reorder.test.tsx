// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { ProductApiError } from '../../api/errors'
import { clearSession } from '../../api/sessionStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot, OwnedCollectionListItem } from '../../api/types'
import { clearRouteCache } from '../../lib/routeCache'
import { LibraryDesk } from './LibraryDesk'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false, refreshSession: vi.fn(async () => undefined) },
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  loadAnnotations: vi.fn(async () => []),
  moveCollectionNode: vi.fn(),
  getMyLibraryOrder: vi.fn(),
  updateMyLibraryOrder: vi.fn(),
  collections: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as const,
    message: '',
    hasMore: false,
    isLoadingMore: false,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  },
  shared: {
    items: [] as OwnedCollectionListItem[],
    state: 'ready' as const,
    message: '',
    hasMore: false,
    isLoadingMore: false,
    reload: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
  },
  invites: {
    items: [],
    state: 'ready' as const,
    message: '',
    pendingInviteId: null,
    reload: vi.fn(async () => undefined),
    accept: vi.fn(),
    decline: vi.fn(),
  },
}))

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))
vi.mock('../../lib/useLibrary', () => ({ useLibrary: () => ({ state: mocks.collections.state, message: mocks.collections.message, reload: mocks.collections.reload,
    library: mocks.collections.items[0] ? { ...mocks.collections.items[0].collection, library: true,
      bookmarksBarId: 'library-bar', otherBookmarksId: 'library-other' } : null }) }))
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
      moveCollectionNode: mocks.moveCollectionNode,
      getMyLibraryOrder: mocks.getMyLibraryOrder,
      updateMyLibraryOrder: mocks.updateMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

function collectionItem(id: string, title: string): OwnedCollectionListItem {
  return {
    collection: {
      id,
      kind: 'bookmarks',
      title,
      summary: null,
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
  }
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}</p>
}

function mount() {
  mountTree(
    <MemoryRouter initialEntries={['/library/col-1']}>
      <LocationProbe />
      <Routes>
        <Route path="/library/:id?" element={<LibraryDesk />} />
      </Routes>
    </MemoryRouter>,
  )
}

function layeredSnapshot(id = 'col-1', title = 'Reading queue', moveNode = true): EditorSnapshot {
  const item = collectionItem(id, title)
  const caps = moveNode ? item.capabilities : { ...item.capabilities, moveNode: false }
  return {
    collection: item.collection,
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
        title: 'Work queue',
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
        id: `${id}-a`,
        collectionId: id,
        kind: 'bookmark',
        parentId: `root-${id}`,
        position: 'b',
        title: 'Alpha',
        url: 'https://alpha.example',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: `"n-${id}-a"`,
        readOnly: false,
        readOnlyReason: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
      {
        id: `${id}-b`,
        collectionId: id,
        kind: 'bookmark',
        parentId: `root-${id}`,
        position: 'c',
        title: 'Beta',
        url: 'https://beta.example',
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: `"n-${id}-b"`,
        readOnly: false,
        readOnlyReason: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
    ],
    capabilities: caps,
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

/** MoveNodeResult stub: same-parent reorder bumps the parent childrenRevision. */
function layerMoveResult(nodeId: string, parentId: string, revision: string) {
  return {
    node: { id: nodeId, parentId, position: 'z' },
    sourceParent: { id: parentId, childrenRevision: revision, childrenEtag: `"ce-${revision}"` },
    targetParent: { id: parentId, childrenRevision: revision, childrenEtag: `"ct-${revision}"` },
    fence: {
      contentRevision: revision,
      contentEtag: `"cf-${revision}"`,
      policyRevision: '1',
      policyEtag: '"pf-1"',
    },
  }
}

function layerRowIds(): string[] {
  // The sidebar rows carry data-reorder-id too, so scope to the layer list's
  // own role=list element, never the workspace wrapper.
  return [...document.querySelectorAll('[role="list"].library-layer-reorder-list [data-reorder-id]')]
    .map((el) => el.getAttribute('data-reorder-id') ?? '')
}

function layerRow(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[role="list"].library-layer-reorder-list [data-reorder-id="${id}"]`,
  )
  if (!el) throw new Error(`layer reorder row ${id} not rendered`)
  return el
}

describe('LibraryDesk layer reorder (FO-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue'),
      collectionItem('col-2', 'Second shelf'),
      collectionItem('col-3', 'Third shelf'),
    ]
    mocks.shared.items = []
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(layeredSnapshot(id)))
    mocks.getMyLibraryOrder.mockResolvedValue({
      sections: { mine: ['col-1', 'col-2', 'col-3'], shared: [], following: [] },
    })
    mocks.updateMyLibraryOrder.mockResolvedValue({ section: 'mine', collectionIds: [] })
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) =>
      layerMoveResult(nodeId, 'root-col-1', '2'))
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    document.body.innerHTML = ''
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
  })

  it('offers the Reorder chip only to owners/editors with a large enough layer', async () => {
    // Reader snapshot: no moveNode capability → no Reorder chip at all.
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(layeredSnapshot(id, 'Reading queue', false)))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-layer-reorder"]')).toBeNull()

    // Owner/editor snapshot in a fresh mount: the chip appears. The route cache
    // has to go with the unmount, or the second mount serves the reader snapshot
    // it cached for this path.
    cleanup()
    clearRouteCache()
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(layeredSnapshot(id)))
    mount()
    await waitForDom(() => document.querySelector('[data-testid="library-layer-reorder"]') != null)
    expect(document.querySelector('[data-testid="library-layer-reorder"]')).not.toBeNull()
  })

  it('moves layer rows with single clicks on the move buttons (R15-42)', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })
    expect(layerRowIds()).toEqual(['col-1-folder', 'col-1-a', 'col-1-b'])
    const moveButtons = (id: string) => [...layerRow(id).querySelectorAll<HTMLButtonElement>('[data-reorder-controls] button')]
    expect(moveButtons('col-1-b').map((b) => b.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Move .+ to top$/u),
      expect.stringMatching(/^Move .+ up$/u),
      expect.stringMatching(/^Move .+ down$/u),
    ])
    act(() => moveButtons('col-1-b')[0]!.click())
    expect(layerRowIds()).toEqual(['col-1-b', 'col-1-folder', 'col-1-a'])
    act(() => moveButtons('col-1-folder')[2]!.click())
    expect(layerRowIds()).toEqual(['col-1-b', 'col-1-a', 'col-1-folder'])
    expect(mocks.moveCollectionNode).not.toHaveBeenCalled()
  })

  it('keeps pinned bookmarks above the others, says why once, and still reorders folders around them', async () => {
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      const snap = layeredSnapshot(id)
      return Promise.resolve({ ...snap, nodes: snap.nodes.map((node) => node.id === `${id}-a` ? { ...node, pinned: true } : node) } as EditorSnapshot)
    })
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelectorAll('[data-testid="bookmark-pinned"]')).toHaveLength(1)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })
    expect(layerRowIds()).toEqual(['col-1-folder', 'col-1-a', 'col-1-b'])
    const press = (id: string, key: string) => act(() => {
      layerRow(id).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    press('col-1-b', 'ArrowUp')
    press('col-1-b', 'Home')
    expect(layerRowIds()).toEqual(['col-1-folder', 'col-1-a', 'col-1-b'])
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith('Pinned bookmarks stay above other bookmarks. Pin or unpin them in the browser extension.')
    // Folders are free to move past both.
    press('col-1-folder', 'End')
    expect(layerRowIds()).toEqual(['col-1-a', 'col-1-b', 'col-1-folder'])
  })

  it('moves rows with the keyboard and commits the exact target through moveCollectionNode', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })
    expect(layerRowIds()).toEqual(['col-1-folder', 'col-1-a', 'col-1-b'])

    act(() => {
      layerRow('col-1-folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(layerRowIds()).toEqual(['col-1-a', 'col-1-folder', 'col-1-b'])
    expect(mocks.moveCollectionNode).not.toHaveBeenCalled()

    act(() => {
      layerRow('col-1-b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(layerRowIds()).toEqual(['col-1-b', 'col-1-a', 'col-1-folder'])

    act(() => {
      layerRow('col-1-b').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(layerRowIds()).toEqual(['col-1-a', 'col-1-folder', 'col-1-b'])

    act(() => {
      layerRow('col-1-b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(layerRowIds()).toEqual(['col-1-b', 'col-1-a', 'col-1-folder'])

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder-done"]')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)

    // [folder, a, b] → [b, a, folder]: b goes before the folder, then a
    // chained after b with the refreshed children revision.
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.moveCollectionNode.mock.calls
    expect(first).toEqual([
      'col-1',
      'col-1-b',
      {
        newParentId: 'root-col-1',
        afterId: null,
        beforeId: 'col-1-folder',
        baseSourceParentRevision: '1',
        baseTargetParentRevision: '1',
      },
      '"n-col-1-b"',
      { intentId: 'layer-reorder:col-1:root-col-1:col-1-b:11111111-1111-4111-8111-111111111111' },
    ])
    expect(second).toEqual([
      'col-1',
      'col-1-a',
      {
        newParentId: 'root-col-1',
        afterId: 'col-1-b',
        beforeId: null,
        baseSourceParentRevision: '2',
        baseTargetParentRevision: '2',
      },
      '"n-col-1-a"',
      { intentId: 'layer-reorder:col-1:root-col-1:col-1-a:11111111-1111-4111-8111-111111111111' },
    ])
    expect(mocks.success).toHaveBeenCalledWith('Order saved')
    expect(document.querySelector('[data-layer-reordering]')).toBeNull()
  })

  it('drags a row through the same move client path as the keyboard', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })

    // happy-dom has no layout, so every sibling midpoint sits at zero:
    // dragging far down lands the row after every other one.
    act(() => {
      layerRow('col-1-folder').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 8, clientY: 10,
      }))
    })
    act(() => {
      layerRow('col-1-folder').dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: 8, clientY: 160,
      }))
    })
    expect(layerRowIds()).toEqual(['col-1-a', 'col-1-b', 'col-1-folder'])
    act(() => {
      layerRow('col-1-folder').dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: 8, clientY: 160,
      }))
    })

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder-done"]')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-a',
      expect.objectContaining({ newParentId: 'root-col-1', afterId: null, beforeId: 'col-1-folder' }),
      expect.any(String),
      expect.objectContaining({ intentId: expect.stringContaining('layer-reorder:col-1:root-col-1:') }),
    )
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-b',
      expect.objectContaining({ newParentId: 'root-col-1', afterId: 'col-1-a', beforeId: null }),
      expect.any(String),
      expect.objectContaining({ intentId: expect.stringContaining('layer-reorder:col-1:root-col-1:') }),
    )
  })

  it('Escape finishes through the same persist path as Done', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })
    act(() => {
      layerRow('col-1-folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-a',
      expect.objectContaining({ afterId: null, beforeId: 'col-1-folder' }),
      expect.any(String),
      expect.objectContaining({ intentId: expect.stringContaining('layer-reorder:col-1:root-col-1:col-1-a:') }),
    )
  })

  it('refreshes and retries a stale 412 move with the fresh revision and the same command id', async () => {
    const freshSnap = layeredSnapshot('col-1', 'Reading queue')
    ;(freshSnap.root as { childrenRevision: string; childrenEtag: string }).childrenRevision = '2'
    ;(freshSnap.root as { childrenEtag: string }).childrenEtag = '"root-c-col-1-2"'
    const a = freshSnap.nodes.find((node) => node.id === 'col-1-a')!
    a.etag = '"n-col-1-a-v2"'
    let snapshotCall = 0
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      snapshotCall += 1
      return Promise.resolve(snapshotCall >= 2 ? freshSnap : layeredSnapshot(id))
    })
    let firstAttempt = true
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) => {
      if (firstAttempt) {
        firstAttempt = false
        throw new ProductApiError({
          status: 412,
          code: 'precondition_failed',
          message: 'The resource ETag does not match the current representation.',
          recovery: 'refresh_and_retry',
        })
      }
      return layerMoveResult(nodeId, 'root-col-1', '2')
    })

    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })
    act(() => {
      layerRow('col-1-folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder-done"]')?.click()
    })

    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(2)
    const [stale, retried] = mocks.moveCollectionNode.mock.calls
    expect(stale![4]).toEqual({
      intentId: 'layer-reorder:col-1:root-col-1:col-1-a:11111111-1111-4111-8111-111111111111',
    })
    expect(retried).toEqual([
      'col-1',
      'col-1-a',
      {
        newParentId: 'root-col-1',
        afterId: null,
        beforeId: 'col-1-folder',
        baseSourceParentRevision: '2',
        baseTargetParentRevision: '2',
      },
      '"n-col-1-a-v2"',
      { intentId: 'layer-reorder:col-1:root-col-1:col-1-a:11111111-1111-4111-8111-111111111111' },
    ])
  })

  it('retries a network-unknown result with the same command id and never double-applies', async () => {
    let attempts = 0
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) => {
      attempts += 1
      if (attempts === 1) {
        throw new ProductApiError({
          status: 0,
          code: 'transport_error',
          message: 'The network result is unknown.',
          recovery: 'same_request',
        })
      }
      return layerMoveResult(nodeId, 'root-col-1', '2')
    })

    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder"]')?.click()
    })
    act(() => {
      layerRow('col-1-folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-layer-reorder-done"]')?.click()
    })

    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(2)
    const [lost, retried] = mocks.moveCollectionNode.mock.calls
    expect(lost![4]).toEqual({
      intentId: 'layer-reorder:col-1:root-col-1:col-1-a:11111111-1111-4111-8111-111111111111',
    })
    // Same intent id → the server receipt replay returns the same outcome
    // instead of allocating a second position.
    expect(retried![4]).toEqual(lost![4])
    expect(retried![1]).toBe('col-1-a')
    expect(mocks.success).toHaveBeenCalledWith('Order saved')
  })

})
