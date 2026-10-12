// @vitest-environment happy-dom
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { EditorSnapshot } from '../api/types'
import { ResourceDetail } from './ResourceDetail'
import { cleanup, mountTree, waitForDom } from '../test/render'

/* A folder has no resource page: a search hit or link that lands on one
   opens the folder on the library desk instead of a dead end. */

const mocks = vi.hoisted(() => ({
  loadEditorSnapshot: vi.fn(),
  auth: { isLoggedIn: true, bootstrapping: false },
}))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: () => false,
    productClient: { ...actual.productClient, loadEditorSnapshot: mocks.loadEditorSnapshot },
  }
})
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

const snapshot = {
  collection: { id: 'collection-1', title: 'Reading notes', kind: 'bookmarks', visibility: 'private' },
  root: { id: 'root', kind: 'folder', folderRole: 'root', parentId: null, title: 'Root' },
  nodes: [{ id: 'folder-1', parentId: 'root', kind: 'folder', title: 'Design', description: null, tags: [] }],
  capabilities: {},
  page: { hasMore: false, nextCursor: null },
} as unknown as EditorSnapshot

describe('ResourceDetail on a folder', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot)
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  it('opens the folder on the desk', async () => {
    function Desk() {
      const location = useLocation()
      return <p data-testid="desk">{location.pathname}{location.search}</p>
    }
    mountTree(
      <MemoryRouter initialEntries={['/r/folder-1?collectionId=collection-1&subjectType=node']}>
        <Routes>
          <Route path="/r/:id" element={<ResourceDetail />} />
          <Route path="/library/:collectionId" element={<Desk />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="desk"]') !== null)
    expect(document.querySelector('[data-testid="desk"]')?.textContent).toBe('/library/collection-1?folder=folder-1')
  })
})
