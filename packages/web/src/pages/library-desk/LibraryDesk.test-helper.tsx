/**
 * Shared scaffold for the LibraryDesk suites
 * (LibraryDesk.test.tsx, LibraryDesk.actions.test.tsx,
 * LibraryDesk.sharing.test.tsx).
 *
 * Each test file still registers its own vi.mock(...) factories; those
 * factories `await import('./LibraryDesk.test-mocks')` (the leaf
 * module, never this one — importing this helper from a factory deadlocks
 * the module graph).
 */
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { vi } from 'vitest'
import type { EditableNodeView, EditorSnapshot, OwnedCollectionListItem } from '../../api/types'
import { NavigationScrollManager } from '../../components/NavigationScrollManager'
import { clearRouteCache } from '../../lib/routeCache'
import { LibraryDesk } from './LibraryDesk'
import { resetBookmarkAnnotationsCacheForTests } from '../../lib/useBookmarkAnnotations'
import { setUiDensity } from '../../lib/useUiDensity'
import { cleanup, mountTree } from '../../test/render'
import { mocks } from './LibraryDesk.test-mocks'

export { mocks } from './LibraryDesk.test-mocks'

export function collectionItem(
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

export function snapshotRequestedIds() {
  return mocks.loadEditorSnapshot.mock.calls.map((args) => args[0] as string)
}

export function rejectSnapshot(id: string) {
  return Promise.reject(new Error(`must not prefetch ${id}`))
}

export function extraBookmark(id: string, collectionId: string, parentId: string, position: string, title: string): EditableNodeView {
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

export function snapshot(id = 'col-1', title = 'Reading queue'): EditorSnapshot {
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
        // Non-default on purpose: copy/undo payload tests must prove these
        // travel from the source node instead of being hardcoded defaults.
        tags: ['research'],
        visibility: 'private',
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

/** MoveNodeResult stub: both parents refreshed to the given childrenRevision. */
export function moveResult(nodeId: string, sourceParentId: string, targetParentId: string, revision: string) {
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
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>
}

export function mount(path = '/library/col-1') {
  mountTree(
      <MemoryRouter initialEntries={[path]}>
        <NavigationScrollManager />
        <LocationProbe />
        <Routes>
          <Route path="/library/:id?" element={<LibraryDesk />} />
          <Route path="/library/following/:slug" element={<LibraryDesk />} />
          <Route path="/library/:id/edit" element={<p data-testid="editor-route">Editor</p>} />
          <Route path="/login" element={<p>Login</p>} />
        </Routes>
      </MemoryRouter>,
    )
}

export function openRowMenu(title: string) {
  act(() => {
    document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${title}"]`)?.click()
  })
}

export function clickMenuItem(label: string) {
  act(() => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === label)?.click()
  })
}

export function destinationButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="destination-option"]')]
}

export function pickDestination(label: string) {
  act(() => {
    destinationButtons().find((button) => button.textContent?.includes(label))?.click()
  })
}

export function bulkbarButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="library-bulkbar"] button')]
    .find((button) => button.textContent === label)
}

export function setControlValue(control: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  act(() => {
    setter.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Type into the desk filter — search renders the whole subtree flattened,
    so rows from different folders are reachable in one list. */
export function filterDesk(value: string) {
  const input = document.querySelector<HTMLInputElement>('.library-desk-search input')
  if (!input) throw new Error('desk filter input missing')
  setControlValue(input, value)
}

/** Drain the lazy annotation lookups that BookmarkArea starts for newly visible rows. */
export async function settleAnnotationReads() {
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

/** beforeEach body shared by every LibraryDesk suite. */
export function setUpLibraryDesk() {
  vi.clearAllMocks()
  clearRouteCache()
  localStorage.clear()
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
  resetBookmarkAnnotationsCacheForTests()
  mocks.loadAnnotations.mockResolvedValue([])
  mocks.loadPublicCollectionSnapshot.mockResolvedValue({
    collection: {
      id: 'col-f',
      slug: 'shared-shelf',
      title: 'Followed Shelf',
      summary: null,
      kind: 'bookmarks',
      rootNodeId: 'root-f',
      updatedAt: '2026-08-01T00:00:00.000Z',
      access: 'public',
    },
    nodes: [
      { id: 'root-f', parentId: null, kind: 'root', title: 'Root', description: null, url: null, position: null },
      { id: 'bm-f', parentId: 'root-f', kind: 'bookmark', title: 'Followed bookmark', description: null, url: 'https://followed.example', position: 'a' },
    ],
  })
  mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) =>
    moveResult(nodeId, 'root-col-1', 'col-1-folder', '2'))
  mocks.deleteCollectionNode.mockResolvedValue(undefined)
  mocks.listFollowedCollections.mockResolvedValue({ items: [], nextCursor: null })
  mocks.listFollowedReports.mockResolvedValue({ items: [], nextCursor: null })
  mocks.listMyReports.mockResolvedValue({ items: [], nextCursor: null })
  mocks.getFollowedReportIssuesPage.mockResolvedValue({ items: [], nextCursor: null })
  mocks.getMyLibraryOrder.mockResolvedValue({ sections: { mine: [], shared: [], following: [] } })
  mocks.updateMyLibraryOrder.mockResolvedValue({ section: 'mine', collectionIds: [] })
  setUiDensity('comfortable')
}

/** afterEach body shared by every LibraryDesk suite. */
export function tearDownLibraryDesk() {
  cleanup()
  document.body.innerHTML = ''
  delete window.__KNOWN_FLAGS__
}
