/**
 * Shared scaffold for the Library page suites (Library.test.tsx,
 * Library.publication.test.tsx).
 *
 * Each suite still registers its own vi.mock(...) factories; those factories
 * `await import('./Library.test-mocks')` (the leaf module, never this one).
 */
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import type { EditorSnapshot, OwnedCollectionListItem } from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { setUiDensity } from '../lib/useUiDensity'
import { cleanup, mountTree } from '../test/render'
import { Library } from './Library'
import { mocks } from './Library.test-mocks'

export { mocks } from './Library.test-mocks'

export function entry(id: string, title: string, canEdit = true): OwnedCollectionListItem {
  return {
    collection: {
      id, kind: 'bookmarks', title, summary: 'Private working set', visibility: 'private',
      allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: `root-${id}`,
      revision: 'r', etag: '"r"', contentRevision: 'c', contentEtag: '"c"', policyRevision: 'p',
      policyEtag: '"p"', createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: canEdit, managePublication: false, createNode: false,
      updateNode: false, moveNode: false, deleteNode: false,
    },
  }
}

export function snapshot(id = 'one', title = 'One'): EditorSnapshot {
  return {
    collection: entry(id, title).collection,
    root: {
      id: `root-${id}`, collectionId: id, kind: 'folder', folderRole: 'root', parentId: null, position: null,
      title: title, description: null, tags: [], visibility: 'inherit', revision: '1', etag: '"root"',
      readOnly: false, readOnlyReason: null, childrenRevision: '1', childrenEtag: '"root-c"',
      createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
    },
    nodes: [
      {
        id: `${id}-folder`, collectionId: id, kind: 'folder', folderRole: null, parentId: `root-${id}`, position: '1',
        title: 'Design', description: null, tags: [], visibility: 'inherit', revision: '1', etag: '"f"',
        readOnly: false, readOnlyReason: null, childrenRevision: '1', childrenEtag: '"fc"',
        createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
      {
        id: `${id}-bm`, collectionId: id, kind: 'bookmark', parentId: `${id}-folder`, position: '1',
        title: `${title} bookmark`, url: 'https://example.test/item', description: 'A saved page',
        tags: [], visibility: 'inherit', revision: '1', etag: '"b"',
        readOnly: false, readOnlyReason: null,
        createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
    ],
    capabilities: {
      updateCollection: true, managePublication: true, createNode: true,
      updateNode: true, moveNode: true, deleteNode: true,
    },
    page: {
      snapshotId: `snap-${id}`, contentRevision: '1', policyRevision: '1', comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z', returnedCount: 2, hasMore: false, nextCursor: null,
    },
  } as EditorSnapshot
}

export function publicSnapshot(slug = 'design-notes', title = 'Design notes') {
  return {
    collection: {
      id: `pub-${slug}`, slug, title, summary: 'Curated public shelf', kind: 'bookmarks' as const,
      rootNodeId: `pub-root-${slug}`, updatedAt: '2026-08-26T01:00:00.000Z', access: 'public' as const,
      owner: { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'curator', displayName: 'Ada Curator', avatarUrl: null },
    },
    nodes: [
      { id: `pub-root-${slug}`, parentId: null, kind: 'root' as const, title, description: null, url: null, position: null, iconUrl: null },
      { id: `pub-folder-${slug}`, parentId: `pub-root-${slug}`, kind: 'folder' as const, title: 'Reading', description: null, url: null, position: '1', iconUrl: null },
      { id: `pub-bm-${slug}`, parentId: `pub-folder-${slug}`, kind: 'bookmark' as const, title: 'Public bookmark', description: 'Shared find', url: 'https://example.test/public', position: '1', iconUrl: null },
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

export function mount(path = '/library') {
  mountTree(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library/following/:slug" element={<Library />} />
          <Route path="/library/:id?" element={<Library />} />
          <Route path="/library/:id/edit" element={<p data-testid="editor-route">Editor</p>} />
          <Route path="/login" element={<p>Login</p>} />
        </Routes>
      </MemoryRouter>,
    )
}

export function setUpLibrary() {
  vi.clearAllMocks()
  // The desk cache survives mounts; without this, a test that expanded a
  // collection leaks that expansion (and its tree loads) into later tests.
  clearRouteCache()
  document.body.innerHTML = '<div id="root"></div>'
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.isLive.mockImplementation((flag: string) => ['collectionList', 'savedResources', 'readingProgress'].includes(flag))
  mocks.auth.isLoggedIn = true
  mocks.auth.bootstrapping = false
  mocks.auth.sessionState = 'ready'
  mocks.collections = { items: [], state: 'ready', message: '', hasMore: false, isLoadingMore: false, reload: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined) }
  mocks.shared = { items: [], state: 'ready', message: '', hasMore: false, isLoadingMore: false, reload: vi.fn(async () => undefined), loadMore: vi.fn(async () => undefined) }
  mocks.invites = { items: [], state: 'ready', message: '', pendingInviteId: null, accept: vi.fn(async () => ({ collectionId: '' })), decline: vi.fn(async () => undefined) }
  mocks.saved = { items: [], state: 'ready', message: '', reload: vi.fn() }
  mocks.progress = { items: [], state: 'ready', message: '', reload: vi.fn() }
  mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === 'two' ? 'Two' : 'One')))
  mocks.loadPublicCollectionSnapshot.mockReset()
  mocks.loadPublicCollectionSnapshot.mockImplementation(async (slug: string) => publicSnapshot(slug))
  mocks.listFollowedCollections.mockReset()
  mocks.listFollowedCollections.mockResolvedValue({ items: [], nextCursor: null })
  mocks.getMyLibraryOrder.mockReset()
  mocks.getMyLibraryOrder.mockResolvedValue({ sections: { mine: [], shared: [], following: [] } })
  delete window.__KNOWN_FLAGS__
  setUiDensity('comfortable')
}

export function tearDownLibrary() {
  cleanup()
  document.body.innerHTML = ''
  delete window.__KNOWN_FLAGS__
}
