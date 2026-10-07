// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditableNodeView, EditorSnapshot, OwnedCollectionListItem } from '../../api/types'
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
  listFollowedCollections: vi.fn(),
  listFollowedReports: vi.fn(async () => ({ items: [], nextCursor: null })),
  listMyReports: vi.fn(async () => ({ items: [], nextCursor: null })),
  getFollowedReportIssuesPage: vi.fn(async () => ({ items: [], nextCursor: null })),
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
      moveCollectionNode: mocks.moveCollectionNode,
      listFollowedCollections: mocks.listFollowedCollections,
      listFollowedReports: mocks.listFollowedReports,
      listMyReports: mocks.listMyReports,
      getFollowedReportIssuesPage: mocks.getFollowedReportIssuesPage,
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

function extraBookmark(id: string, collectionId: string, parentId: string, position: string, title: string): EditableNodeView {
  return {
    id,
    collectionId,
    kind: 'bookmark',
    title,
    url: `https://${id}.example`,
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
  }
}

function snapshot(id = 'col-1', title = 'Reading queue'): EditorSnapshot {
  const item = collectionItem(id, title)
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
      extraBookmark(`${id}-first`, id, `${id}-folder`, 'b', 'First page item'),
      extraBookmark(`${id}-loose`, id, `root-${id}`, 'c', 'Loose bookmark'),
    ],
    capabilities: item.capabilities,
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

/** MoveNodeResult stub: both parents refreshed to the given childrenRevision. */
function moveResult(nodeId: string, sourceParentId: string, targetParentId: string, revision: string) {
  return {
    node: { id: nodeId },
    sourceParent: { id: sourceParentId, childrenRevision: revision, childrenEtag: `"ce-${revision}"` },
    targetParent: { id: targetParentId, childrenRevision: revision, childrenEtag: `"ct-${revision}"` },
    fence: {
      contentRevision: revision,
      contentEtag: `"cf-${revision}"`,
      policyRevision: '1',
      policyEtag: '"pf-1"',
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
        <Route path="/read/:resourceId" element={<p data-testid="resource-route">Resource</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Desktop media stub: hover-capable fine pointer, everything else off. */
function stubDesktopMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(hover: hover) and (pointer: fine)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  el: Element,
  options: { x: number; y: number; pointerId?: number; pointerType?: string; button?: number },
) {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: options.pointerId ?? 1,
      pointerType: options.pointerType ?? 'mouse',
      button: options.button ?? 0,
      clientX: options.x,
      clientY: options.y,
    }))
  })
}

function bookmarkRow(nodeId: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('[data-testid="library-bookmarks"] [role="listitem"]')]
    .find((el) => el.getAttribute('data-node-id') === nodeId)
  if (!row) throw new Error(`bookmark row ${nodeId} not rendered`)
  return row
}

function rowLink(nodeId: string): HTMLAnchorElement {
  const link = document.querySelector<HTMLAnchorElement>(`a[data-node-id="${nodeId}"]`)
  if (!link) throw new Error(`bookmark link ${nodeId} not rendered`)
  return link
}

function ghost(): Element | null {
  return document.querySelector('[data-testid="library-drag-ghost"]')
}

function dropTarget(): Element | null {
  return document.querySelector('[data-drop-target]')
}

function locationPath(): string {
  return document.querySelector('[data-testid="location"]')?.textContent ?? ''
}

async function expandSidebarFolders() {
  act(() => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Expand Reading queue"]')?.click()
  })
  await waitForDom(() => document.querySelector('a[data-folder-id="col-1-folder"]') != null)
}

/** Arm on a row and cross the drag threshold. */
function startDrag(nodeId: string) {
  const row = bookmarkRow(nodeId)
  pointer('pointerdown', row, { x: 100, y: 100 })
  pointer('pointermove', row, { x: 100, y: 120 })
}

function openRowMenu(title: string) {
  act(() => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${title}"]`)?.click()
  })
}

/** The subtree filter renders rows from every folder in one flat list. */
function filterDesk(value: string) {
  const input = document.querySelector<HTMLInputElement>('[data-testid="library-desk-search"] input')
  if (!input) throw new Error('desk filter input missing')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function clickMenuItem(label: string) {
  act(() => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === label)?.click()
  })
}

describe('LibraryDesk desktop bookmark drag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    document.body.removeAttribute('data-bookmark-drag')
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    stubDesktopMedia()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    window.__KNOWN_FLAGS__ = { readableReplica: true }
    mocks.collections.items = [collectionItem('col-1', 'Reading queue'), collectionItem('col-2', 'Second shelf')]
    mocks.shared.items = []
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(snapshot(id, id === 'col-2' ? 'Second shelf' : 'Reading queue')))
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) =>
      moveResult(nodeId, 'root-col-1', 'col-1-folder', '2'))
    mocks.listFollowedCollections.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getMyLibraryOrder.mockResolvedValue({ sections: { mine: [], shared: [], following: [] } })
    mocks.updateMyLibraryOrder.mockResolvedValue({ section: 'mine', collectionIds: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-bookmark-drag')
    delete window.__KNOWN_FLAGS__
  })

  it('drags a bookmark onto a sidebar folder and appends it via runMove', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    await expandSidebarFolders()

    startDrag('col-1-loose')
    expect(ghost()?.textContent).toContain('Loose bookmark')
    expect(document.body.hasAttribute('data-bookmark-drag')).toBe(true)

    const folder = document.querySelector<HTMLAnchorElement>('a[data-folder-id="col-1-folder"]')!
    pointer('pointermove', folder, { x: 20, y: 200 })
    expect(folder.hasAttribute('data-drop-target')).toBe(true)

    pointer('pointerup', folder, { x: 20, y: 200 })
    // The click generated by this gesture is swallowed: no navigation.
    act(() => rowLink('col-1-loose').click())
    expect(locationPath()).toBe('/library/col-1')
    expect(ghost()).toBeNull()
    expect(document.body.hasAttribute('data-bookmark-drag')).toBe(false)
    expect(dropTarget()).toBeNull()

    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(1)
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-loose',
      {
        newParentId: 'col-1-folder',
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: '1',
        baseTargetParentRevision: '1',
      },
      '"n-col-1-loose"',
      expect.anything(),
    )
    expect(mocks.success).toHaveBeenCalledWith('Bookmark moved', {
      action: { label: 'View in Later', to: '/library/col-1?folder=col-1-folder' },
    })
  })

  it('drops onto the current collection row to move a bookmark to the root', async () => {
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) =>
      moveResult(nodeId, 'col-1-folder', 'root-col-1', '2'))
    mount()
    await waitForDom(domFinishedLoading)
    filterDesk('example')

    startDrag('col-1-first')
    const collectionLink = document.querySelector<HTMLAnchorElement>('a[data-collection-id="col-1"]')!
    pointer('pointermove', collectionLink, { x: 20, y: 60 })
    expect(collectionLink.closest('[data-drop-target]')).not.toBeNull()

    pointer('pointerup', collectionLink, { x: 20, y: 60 })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-first',
      expect.objectContaining({ newParentId: 'root-col-1', afterId: null, beforeId: null }),
      '"n-col-1-first"',
      expect.anything(),
    )
  })

  it('keeps a sub-threshold press as a plain click that still navigates', async () => {
    mount()
    await waitForDom(domFinishedLoading)

    const link = rowLink('col-1-loose')
    pointer('pointerdown', link, { x: 100, y: 100 })
    pointer('pointermove', link, { x: 102, y: 103 })
    expect(ghost()).toBeNull()
    pointer('pointerup', link, { x: 102, y: 103 })
    act(() => link.click())

    expect(locationPath()).toBe('/read/col-1-loose')
    expect(document.querySelector('[data-testid="resource-route"]')).not.toBeNull()
    expect(mocks.moveCollectionNode).not.toHaveBeenCalled()
  })

  it('cancels the drag on Escape without moving or navigating', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    await expandSidebarFolders()

    startDrag('col-1-loose')
    const folder = document.querySelector<HTMLAnchorElement>('a[data-folder-id="col-1-folder"]')!
    pointer('pointermove', folder, { x: 20, y: 200 })
    expect(folder.hasAttribute('data-drop-target')).toBe(true)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(ghost()).toBeNull()
    expect(dropTarget()).toBeNull()
    expect(document.body.hasAttribute('data-bookmark-drag')).toBe(false)

    pointer('pointerup', folder, { x: 20, y: 200 })
    act(() => rowLink('col-1-loose').click())
    expect(locationPath()).toBe('/library/col-1')
    expect(mocks.moveCollectionNode).not.toHaveBeenCalled()
  })

  it('never highlights foreign collections or the bookmark’s current folder', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    await expandSidebarFolders()
    filterDesk('example')

    // A bookmark dragged over the folder it already lives in stays inert.
    startDrag('col-1-first')
    const ownFolder = document.querySelector<HTMLAnchorElement>('a[data-folder-id="col-1-folder"]')!
    pointer('pointermove', ownFolder, { x: 20, y: 200 })
    expect(dropTarget()).toBeNull()
    pointer('pointerup', ownFolder, { x: 20, y: 200 })
    expect(mocks.moveCollectionNode).not.toHaveBeenCalled()

    // Another collection's row is not a target either.
    startDrag('col-1-loose')
    const otherCollection = document.querySelector<HTMLAnchorElement>('a[data-collection-id="col-2"]')!
    pointer('pointermove', otherCollection, { x: 20, y: 260 })
    expect(dropTarget()).toBeNull()
    pointer('pointerup', otherCollection, { x: 20, y: 260 })
    expect(mocks.moveCollectionNode).not.toHaveBeenCalled()
  })

  it('does not start a drag from a touch press', async () => {
    mount()
    await waitForDom(domFinishedLoading)

    const row = bookmarkRow('col-1-loose')
    pointer('pointerdown', row, { x: 100, y: 100, pointerType: 'touch' })
    pointer('pointermove', row, { x: 100, y: 140, pointerType: 'touch' })
    expect(ghost()).toBeNull()
    pointer('pointerup', row, { x: 100, y: 140, pointerType: 'touch' })
  })

  it('does not start a drag while sidebar reorder is active', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-nav-mine-reorder"]')?.click()
    })
    expect(document.querySelector('[data-library-reordering]')).not.toBeNull()

    startDrag('col-1-loose')
    expect(ghost()).toBeNull()
    expect(document.body.hasAttribute('data-bookmark-drag')).toBe(false)
    pointer('pointerup', bookmarkRow('col-1-loose'), { x: 100, y: 120 })
  })

  it('blocks the sidebar long-press reorder while a bookmark drag is active', async () => {
    mount()
    await waitForDom(domFinishedLoading)

    startDrag('col-1-loose')
    expect(ghost()).not.toBeNull()

    vi.useFakeTimers()
    const navRow = document.querySelector<HTMLElement>('[data-reorder-id="col-2"]')!
    act(() => {
      navRow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 10 }))
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(document.querySelector('[data-library-reordering]')).toBeNull()
    expect(ghost()).not.toBeNull()
    vi.useRealTimers()

    pointer('pointerup', document.body, { x: 100, y: 120 })
    expect(ghost()).toBeNull()
  })

  it('drags the whole selection when the pressed row is part of it', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [...snap.nodes, extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark')]
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    const revisions: Record<string, string> = { 'col-1-loose': '2', 'col-1-third': '3' }
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) =>
      moveResult(nodeId, 'root-col-1', 'col-1-folder', revisions[nodeId]!))
    mount()
    await waitForDom(domFinishedLoading)
    await expandSidebarFolders()

    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Third bookmark"]')?.click()
    })
    expect(document.querySelector('[data-testid="library-bulkbar"]')?.textContent).toContain('2 selected')

    startDrag('col-1-loose')
    expect(ghost()?.textContent).toContain('Loose bookmark')
    expect(ghost()?.textContent).toContain('2')

    const folder = document.querySelector<HTMLAnchorElement>('a[data-folder-id="col-1-folder"]')!
    pointer('pointermove', folder, { x: 20, y: 200 })
    expect(folder.hasAttribute('data-drop-target')).toBe(true)
    pointer('pointerup', folder, { x: 20, y: 200 })

    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = mocks.moveCollectionNode.mock.calls
    expect(firstCall![1]).toBe('col-1-loose')
    expect(firstCall![2]).toMatchObject({
      newParentId: 'col-1-folder',
      baseSourceParentRevision: '1',
      baseTargetParentRevision: '1',
    })
    // The second call must chain the refreshed revisions from the first.
    expect(secondCall![1]).toBe('col-1-third')
    expect(secondCall![2]).toMatchObject({
      newParentId: 'col-1-folder',
      baseSourceParentRevision: '2',
      baseTargetParentRevision: '2',
    })
    expect(mocks.success).toHaveBeenCalledWith('Moved 2 bookmarks', {
      action: { label: 'View in Later', to: '/library/col-1?folder=col-1-folder' },
    })
  })
})
