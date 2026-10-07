// @vitest-environment happy-dom
/* Resource-node resolution boundary (the /r/:id reader).
 *
 * Behaviour — driven against the real hook with the Product client mocked:
 * which endpoint each visit uses (desk editor snapshot vs public snapshot),
 * the abort signal and retry budget every read carries, abort on unmount, the
 * stale-while-revalidate cache, and every empty state (folder, missing
 * collection context, auth-required, unavailable, error). None of this is read
 * from source text.
 *
 * Architecture — the module graph: the hook must reach the API through the
 * public barrel and must not carry a catalog fallback (mock-data,
 * featured-resources, medium.com rows). A fallback import that the driven path
 * never reaches would still ship, so its absence is asserted on the module.
 */
import { act } from 'react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from './routeCache'
import { ProductApiError } from '../api/errors'
import type { EditorSnapshot, PublicCollectionSnapshot } from '../api/types'
import hookSource from './useResourceNode.ts?raw'
import { resourcePrimaryTarget, useResourceNode } from './useResourceNode'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false },
  loadEditorSnapshot: vi.fn(),
  loadPublicCollectionSnapshot: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})

const NODE_ID = 'nd-col-u01-01-001'
const NEXT_ID = 'nd-col-u01-01-002'
const FOLDER_ID = 'nd-col-u01-01-f01'

describe('resource primary target', () => {
  const query = { collectionId: 'col/a', subjectType: 'node' }

  it('uses Reader only while the shared exposure gate is enabled', () => {
    expect(resourcePrimaryTarget('node/a', 'https://example.com', query, true)).toEqual({
      kind: 'internal',
      to: '/read/node%2Fa?collectionId=col%2Fa&subjectType=node',
    })
  })

  it('opens safe originals and falls back to details while Reader is off', () => {
    expect(resourcePrimaryTarget('node/a', 'https://example.com/article', query, false)).toEqual({
      kind: 'external',
      href: 'https://example.com/article',
    })
    expect(resourcePrimaryTarget('node/a', 'javascript:alert(1)', query, false)).toEqual({
      kind: 'internal',
      to: '/r/node%2Fa?collectionId=col%2Fa&subjectType=node',
    })
    expect(resourcePrimaryTarget('node/a', null, query, false)).toEqual({
      kind: 'internal',
      to: '/r/node%2Fa?collectionId=col%2Fa&subjectType=node',
    })
  })
})

function editor(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    collection: {
      id: 'col-u01-01', title: 'LLM learning path', kind: 'reading_path', summary: '',
      visibility: 'public', allowSearchIndexing: true, rootNodeId: 'nd-col-u01-01-root',
      publicationSlug: 'llm-learning-path', publishedAt: '2026-07-25T00:00:00.000Z',
      revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '',
    },
    root: {
      id: 'nd-col-u01-01-root', collectionId: 'col-u01-01', kind: 'folder', folderRole: 'root',
      parentId: null, position: null, title: 'Root', description: null, tags: [],
      visibility: 'inherit', revision: 'rr', etag: '"rr"', readOnly: false, readOnlyReason: null,
      childrenRevision: 'cr', childrenEtag: '"cr"', createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
    nodes: [
      {
        id: FOLDER_ID, collectionId: 'col-u01-01', kind: 'folder', folderRole: null,
        parentId: 'nd-col-u01-01-root', position: 'a', title: 'Videos', description: null, tags: [],
        visibility: 'inherit', revision: 'f1', etag: '"f1"', readOnly: false, readOnlyReason: null,
        childrenRevision: 'fc', childrenEtag: '"fc"', createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
      {
        id: NODE_ID, collectionId: 'col-u01-01', kind: 'bookmark',
        title: '3Blue1Brown · 神经网络可视化', url: 'https://www.youtube.com/@3blue1brown',
        description: 'Course entry', tags: ['youtube'], visibility: 'inherit', revision: 'n1',
        etag: '"n1"', parentId: FOLDER_ID, position: 'b', readOnly: false, readOnlyReason: null,
        createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
      },
      {
        id: NEXT_ID, collectionId: 'col-u01-01', kind: 'bookmark',
        title: 'Next bookmark', url: 'https://example.test/next', description: null, tags: [],
        visibility: 'inherit', revision: 'n2', etag: '"n2"', parentId: FOLDER_ID, position: 'c',
        readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    ],
    capabilities: {
      updateCollection: true, managePublication: true, createNode: true,
      updateNode: true, moveNode: true, deleteNode: true,
    },
    page: {
      snapshotId: 's', contentRevision: 'cc1', policyRevision: 'p1', comparatorVersion: 'v1',
      expiresAt: '', returnedCount: 3, hasMore: false, nextCursor: null,
    },
    ...overrides,
  } as EditorSnapshot
}

function published(): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-u01-01', slug: 'llm-learning-path', title: 'LLM learning path',
      summary: 'Public path', kind: 'reading_path', rootNodeId: 'nd-col-u01-01-root',
      owner: { profileId: 'p', handle: 'lin', displayName: 'Lin', avatarUrl: null },
      updatedAt: '2026-07-25T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'nd-col-u01-01-root', parentId: null, kind: 'root', title: 'Root', description: null, url: null, position: null },
      { id: NODE_ID, parentId: 'nd-col-u01-01-root', kind: 'bookmark', title: '3Blue1Brown · 神经网络可视化', description: 'Course entry', url: 'https://www.youtube.com/@3blue1brown', position: 'a' },
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

function Harness() {
  const { id = '' } = useParams()
  const load = useResourceNode(id)
  return (
    <div data-status={load.status}>
      {load.status === 'ready' && (
        <>
          <h1>{load.node.title}</h1>
          <span data-testid="host">{load.node.host}</span>
          <span data-testid="slug">{load.publicationSlug}</span>
          <span data-testid="next">{load.next?.id ?? ''}</span>
        </>
      )}
      {load.status === 'folder' && <p>{load.title}</p>}
      {load.status === 'error' && <p>{load.message}</p>}
    </div>
  )
}

describe('useResourceNode', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(published())
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function render(path: string) {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/r/:id" element={<Harness />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  describe('resource resolution behaviour', () => {
    it('loads a bookmark from the editor snapshot by OpaqueId', async () => {
      render(`/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`)
      await waitForDom(domFinishedLoading)
      /* Every desk read carries the caller's cancellation signal and no retry
         budget: a superseded read must be abortable, not retried behind it. */
      expect(mocks.loadEditorSnapshot).toHaveBeenCalledWith(
        'col-u01-01',
        expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
      )
      expect(mocks.loadPublicCollectionSnapshot).not.toHaveBeenCalled()
      expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
      expect(document.querySelector('[data-testid="host"]')?.textContent).toBe('www.youtube.com')
      expect(document.querySelector('[data-testid="slug"]')?.textContent).toBe('llm-learning-path')
      expect(document.querySelector('[data-testid="next"]')?.textContent).toBe(NEXT_ID)
      expect(document.body.textContent).not.toContain('Suggested reading path')
      expect(document.body.textContent).not.toContain('Spacing as a system')
    })

    it('aborts the in-flight snapshot read when the reader unmounts', async () => {
      const signals: AbortSignal[] = []
      mocks.loadEditorSnapshot.mockImplementation((_id: string, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        return new Promise<EditorSnapshot>(() => {})
      })
      render(`/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`)
      await waitForDom(() => signals.length > 0)
      /* StrictMode aborts its first mount's read; the surviving read is live. */
      expect(signals.at(-1)?.aborted).toBe(false)
      cleanup()
      expect(signals.length).toBeGreaterThan(0)
      for (const signal of signals) expect(signal.aborted).toBe(true)
    })

    it('paints the resolved node from cache when a route round trip remounts it', async () => {
      const path = `/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`
      render(path)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')

      cleanup()
          document.body.innerHTML = '<div id="root"></div>'
      render(path)

      // First frame back: the resource is there, no loading state.
      expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
      expect(document.body.textContent).not.toContain('Loading resource')
      await waitForDom(domFinishedLoading)
    })

    it('keeps the cached node when the revalidating read fails', async () => {
      const path = `/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`
      render(path)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')

      cleanup()
          document.body.innerHTML = '<div id="root"></div>'
      mocks.loadEditorSnapshot.mockRejectedValue(new Error('network down'))
      render(path)
      await settled()
      /* Stale-while-revalidate: the failed refresh must not blank the reader
         back to an error shell. */
      expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
      expect(document.body.textContent).not.toContain('Could not load resource')
    })

    it('uses the public snapshot when signed out with a publication slug', async () => {
      mocks.auth.isLoggedIn = false
      render(`/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node&slug=llm-learning-path`)
      await waitForDom(domFinishedLoading)
      expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
      expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalledWith(
        'llm-learning-path',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
    })

    it('does not treat collection OpaqueId as a public slug', async () => {
      render(`/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`)
      await waitForDom(domFinishedLoading)
      expect(mocks.loadPublicCollectionSnapshot).not.toHaveBeenCalled()
      expect(mocks.loadPublicCollectionSnapshot.mock.calls.some((args) => args[0] === 'col-u01-01')).toBe(false)
    })

    it('shows a folder empty state instead of treating folders as bookmarks', async () => {
      render(`/r/${FOLDER_ID}?collectionId=col-u01-01&subjectType=node`)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-status="folder"]')).not.toBeNull()
      expect(document.body.textContent).toContain('Videos')
      expect(document.querySelector('h1')).toBeNull()
    })

    it('asks for a collection context when query params are missing', async () => {
      render(`/r/${NODE_ID}`)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-status="needs-collection"]')).not.toBeNull()
      expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
      expect(mocks.loadPublicCollectionSnapshot).not.toHaveBeenCalled()
    })

    it('asks to sign in when a collectionId is present without a session or slug', async () => {
      mocks.auth.isLoggedIn = false
      render(`/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-status="auth-required"]')).not.toBeNull()
      expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
    })

    it('maps 401 to auth-required and 404 to unavailable', async () => {
      // Rejected for as long as the endpoint is failing: StrictMode's two mount
      // effects both issue the request, and a one-shot rejection would let the
      // second one paint a success over the state under test.
      mocks.loadEditorSnapshot.mockRejectedValue(new ProductApiError({
        status: 401, code: 'authentication_required', message: 'auth',
      }))
      render(`/r/${NODE_ID}?collectionId=col-u01-01&subjectType=node`)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-status="auth-required"]')).not.toBeNull()

      cleanup()
      mocks.auth.isLoggedIn = false
      mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({
        status: 404, code: 'resource_not_found', message: 'missing',
      }))
      render(`/r/${NODE_ID}?slug=missing-notes`)
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-status="unavailable"]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('Suggested reading path')
    })

    it('does not fall back to a catalog id when the node is absent from the snapshot', async () => {
      render('/r/medium?collectionId=col-u01-01&subjectType=node')
      await waitForDom(domFinishedLoading)
      /* A literal catalog locator ("medium", a featured-resources slug) is
         requested and still resolves to `unavailable`: the hook has no
         name-based fallback path. */
      expect(document.querySelector('[data-status="unavailable"]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('Spacing as a system')
      expect(document.body.textContent).not.toContain('Suggested reading path')
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps catalog fallbacks out of the resource-node hook', () => {
      /* The driven path above proves an unknown id paints no catalog row, but a
         fallback import that no test visits would still ship: the hook must not
         hold mock collections or featured-resource rows at all. Asserting the
         module specifiers and the catalog symbols is rename-proof, while the
         old `not.toContain('medium')` also matched the ordinary English word. */
      expect(hookSource).toMatch(/from ['"]\.\.\/api['"]/u)
      expect(hookSource).not.toMatch(/from ['"][^'"]*(?:mock-data|featured-resources|catalog)[^'"]*['"]/u)
      expect(hookSource).not.toMatch(/\bfeaturedResources\b/u)
      expect(hookSource).not.toMatch(/\bmedium\.com\b/u)
    })
  })
})
