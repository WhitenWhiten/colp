// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { applyMeView, applySessionView, clearSession } from '../../api/sessionStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot, OwnedCollectionListItem } from '../../api/types'
import { clearRouteCache } from '../../lib/routeCache'
import { LibraryDesk } from './LibraryDesk'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../../test/render'

const EMPTY_ORDER = { sections: { mine: [] as string[], shared: [] as string[], following: [] as string[] } }

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false, refreshSession: vi.fn(async () => undefined) },
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  loadAnnotations: vi.fn(async () => []),
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
    ],
    capabilities: item.capabilities,
    page: {
      snapshotId: `snap-${id}`,
      contentRevision: '1',
      policyRevision: '1',
      comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z',
      returnedCount: 0,
      hasMore: false,
      nextCursor: null,
    },
  } as EditorSnapshot
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

function mineIds(): string[] {
  return [...document.querySelectorAll('[data-testid="library-nav-mine"] [data-reorder-id]')]
    .map((el) => el.getAttribute('data-reorder-id') ?? '')
}

function isReordering(): boolean {
  return document.querySelector('[data-testid="library-nav"][data-library-reordering]') != null
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`)
  if (!el) throw new Error(`row ${id} not rendered`)
  return el
}

function pointerDown(el: HTMLElement, clientY = 10) {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY }))
  })
}

function pointerMove(el: HTMLElement, clientY: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 5, clientY }))
  })
}

function pointerUp(el: HTMLElement, clientY: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 5, clientY }))
  })
}

function longPress(el: HTMLElement) {
  pointerDown(el)
  act(() => {
    vi.advanceTimersByTime(500)
  })
}

describe('LibraryDesk sidebar reorder accessibility', () => {
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
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(snapshot(id)))
    mocks.listFollowedCollections.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getMyLibraryOrder.mockResolvedValue(EMPTY_ORDER)
    mocks.updateMyLibraryOrder.mockResolvedValue({ section: 'mine', collectionIds: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    document.body.innerHTML = ''
  })

  it('uses list semantics while idle: no tree roles, rows reached by their links (R15-44)', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const section = document.querySelector('[data-testid="library-nav-mine"]')!
    // R13 D-25 option B: no tree, treeitem or group roles outside reorder mode.
    expect(section.querySelector('[role="tree"], [role="treeitem"], [role="group"]')).toBeNull()
    const list = section.querySelector('[role="list"][aria-label="Collection folders"]')
    expect(list).not.toBeNull()
    const wrappers = [...section.querySelectorAll<HTMLElement>('[data-reorder-id]')]
    expect(wrappers.length).toBe(3)
    for (const wrapper of wrappers) {
      expect(wrapper.getAttribute('role')).toBe('listitem')
      expect(wrapper.tabIndex).toBe(-1)
      expect(wrapper.querySelector('a[data-collection-id]')).not.toBeNull()
    }
  })

  it('makes the focused sortable wrapper a complete treeitem while inner rows stay inert', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    vi.useFakeTimers()
    longPress(row('col-1'))

    const wrapper = row('col-1')
    expect(wrapper.closest('[role="tree"]')).not.toBeNull()
    expect(wrapper.getAttribute('role')).toBe('treeitem')
    expect(wrapper.tabIndex).toBe(0)
    expect(wrapper.getAttribute('aria-label')).toBe('Reading queue')
    expect(wrapper.getAttribute('aria-selected')).toBe('false')
    expect(wrapper.getAttribute('aria-level')).toBe('1')
    expect(wrapper.getAttribute('aria-posinset')).toBe('1')
    expect(wrapper.getAttribute('aria-setsize')).toBe('3')
    expect(wrapper.querySelector('[inert]')).not.toBeNull()
    expect(wrapper.querySelector('[inert] a[data-collection-id]')).not.toBeNull()

    act(() => {
      wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(mineIds()).toEqual(['col-2', 'col-1', 'col-3'])
    expect(row('col-1').getAttribute('role')).toBe('treeitem')
    expect(row('col-1').getAttribute('aria-posinset')).toBe('2')
    expect(row('col-2').getAttribute('aria-posinset')).toBe('1')
    expect(row('col-1').tabIndex).toBe(0)
  })

  it('reorders with single clicks on the move buttons, no drag (R15-42)', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    vi.useFakeTimers()
    longPress(row('col-1'))

    const button = (id: string, name: string) =>
      row(id).querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
    expect(button('col-1', 'Move Reading queue up')?.disabled).toBe(true)
    expect(button('col-1', 'Move Reading queue to top')?.disabled).toBe(true)
    act(() => button('col-1', 'Move Reading queue down')!.click())
    expect(mineIds()).toEqual(['col-2', 'col-1', 'col-3'])
    // Focus follows the moved row's button.
    expect(document.activeElement).toBe(button('col-1', 'Move Reading queue down'))

    act(() => button('col-3', 'Move Third shelf to top')!.click())
    expect(mineIds()).toEqual(['col-3', 'col-2', 'col-1'])
    // At the top the "to top" button is disabled, so focus rests on the row.
    expect(document.activeElement).toBe(row('col-3'))
  })

  it('collapses expanded folder trees when reorder starts', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    // Sidebar-scoped: the desk folder layer also carries data-folder-id rows.
    const navFolder = () =>
      document.querySelector('[data-testid="library-nav"] [data-folder-id="col-1-folder"]')
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Expand Reading queue"]')?.click()
    })
    await waitForDom(() => navFolder() != null)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-nav-mine-reorder"]')?.click()
    })
    expect(isReordering()).toBe(true)
    expect(navFolder()).toBeNull()
  })

})
