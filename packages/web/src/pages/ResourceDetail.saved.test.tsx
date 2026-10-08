// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { EditorSnapshot } from '../api/types'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { ResourceDetail } from './ResourceDetail'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, robotsContents } from '../test/pageMeta'

const NODE_ID = 'nd-col-u01-01-001'
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), unsave: vi.fn(), loadEditorSnapshot: vi.fn() }))
vi.mock('../api', async (importOriginal) => { const actual = await importOriginal<typeof import('../api')>(); return { ...actual,
  isLive: (flag: string) => flag === 'savedResources', productClient: { ...actual.productClient,
    loadSavedResources: mocks.load, saveResource: mocks.save, unsaveResource: mocks.unsave,
    loadEditorSnapshot: mocks.loadEditorSnapshot,
    abandonSavedResourceIntent: vi.fn(), newCommandId: () => 'command-1', mutationIntentKey: (a: string, b: string) => `${a}:${b}` } } })
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

function editor(): EditorSnapshot {
  return {
    collection: {
      id: 'collection-1', title: 'Saved', kind: 'bookmarks', summary: '', visibility: 'private',
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
    nodes: [{
      id: NODE_ID, collectionId: 'collection-1', kind: 'bookmark', title: '3Blue1Brown · 神经网络可视化',
      url: 'https://www.youtube.com/@3blue1brown', description: null, tags: [], visibility: 'inherit',
      revision: 'n1', etag: '"n1"', parentId: 'root', position: 'a', readOnly: false, readOnlyReason: null,
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    }],
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

describe('Resource Detail Saved control', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks(); localStorage.clear(); mocks.load.mockResolvedValue([]); mocks.save.mockResolvedValue({})
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
    applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
    applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
    document.body.innerHTML = '<div id="root"></div>'; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })
  it('uses the real Saved workflow without legacy localStorage fallback', async () => {
    installPageMetaBaseline()
    mountTree(<MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-1&subjectType=node`]}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>)
    await waitForDom(domFinishedLoading); const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Save')!
    act(() => button.click()); expect(button.getAttribute('aria-pressed')).toBe('true'); await waitForDom(domFinishedLoading)
    expect(mocks.save).toHaveBeenCalledWith('node', NODE_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(localStorage.length).toBe(0)
    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('shows a visible read failure with an explicit reload action', async () => {
    mocks.load.mockRejectedValue(new Error('Saved service unavailable'))
    mountTree(<MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-1&subjectType=node`]}><Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes></MemoryRouter>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const alert = document.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain("Couldn't load the saved state")
    expect(alert.classList.contains('visually-hidden')).toBe(false)
    // A retry must issue a fresh read. The exact call count measured React's
    // mount behaviour (StrictMode mounts the tree twice), not the retry.
    const beforeRetry = mocks.load.mock.calls.length
    act(() => ([...document.querySelectorAll('button')].find((item) => item.textContent === 'Retry saved state') as HTMLButtonElement).click())
    await waitForDom(domFinishedLoading)
    expect(mocks.load.mock.calls.length).toBeGreaterThan(beforeRetry)
  })
})
