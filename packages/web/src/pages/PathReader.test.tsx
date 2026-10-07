// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import { PathReader } from './PathReader'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({
  loadPublicCollectionSnapshot: vi.fn(),
  toast: vi.fn(),
  error: vi.fn(),
  isLive: vi.fn<(flag: string) => boolean>(() => false),
  toggleComplete: vi.fn(),
  auth: { isLoggedIn: true, bootstrapping: false },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: (flag: string) => mocks.isLive(flag),
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})

vi.mock('../lib/useReadingProgress', () => ({
  /* The hook is exercised in useReadingProgress.test.tsx; here it is a
     stub so the outcome branches of markDone/markUndone are observable. */
  useReadingProgress: () => ({
    progress: 0,
    status: 'in_progress',
    complete: false,
    saveState: 'saved',
    message: '',
    setProgress: vi.fn(),
    toggleComplete: mocks.toggleComplete,
    retry: vi.fn(),
    flush: vi.fn(),
    reload: vi.fn(),
  }),
  useReadingProgressList: () => ({ items: [], state: 'ready', message: '', reload: vi.fn() }),
}))

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: vi.fn(), error: mocks.error }),
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))

function rootNode(): PublicCollectionNode {
  return {
    id: 'root-1', parentId: null, kind: 'root', title: 'Published contents',
    description: null, url: null, position: null,
  }
}

function bookmark(
  id: string,
  title: string,
  url: string,
  position: string,
  parentId = 'root-1',
): PublicCollectionNode {
  return {
    id, parentId, kind: 'bookmark', title, description: `${title} notes`, url, position,
  }
}

function snapshot(
  kind: PublicCollectionSnapshot['collection']['kind'] = 'reading_path',
  nodes: PublicCollectionNode[] = [
    rootNode(),
    bookmark('nd-col-u01-01-002', 'Known repo', 'https://github.com/know-n/web', '00000000000000000001'),
    bookmark('nd-col-u01-01-001', 'Transformers paper', 'https://arxiv.org/abs/1706.03762', '00000000000000000000'),
  ],
): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-u01-01',
      slug: 'llm-learning-path',
      title: 'LLM learning path',
      summary: 'A public reading path from the snapshot.',
      kind,
      rootNodeId: 'root-1',
      owner: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'lin',
        displayName: 'Lin Yichen', avatarUrl: null,
      },
      updatedAt: '2026-07-24T12:00:00.000Z',
      access: 'public',
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

describe('PathReader', () => {

  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    /* clearAllMocks keeps implementations; flag + outcome defaults reset here. */
    mocks.isLive.mockImplementation(() => false)
    mocks.toggleComplete.mockResolvedValue('saved')
    mocks.auth.isLoggedIn = true
    window.localStorage.clear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function renderPath(path: string) {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/path/:slug" element={<PathReader />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  function stageTitle(): string {
    return document.querySelector('h2')?.textContent ?? ''
  }

  function markCompleteButton(): HTMLButtonElement {
    return findButtonByName(/Mark complete/)
  }

  it('uses snapshot bookmark order and opens the Library resource URL', async () => {
    installPageMetaBaseline()
    /* The endpoint's answer is the snapshot, not call N of a queue: StrictMode
       mounts the load effect twice (mount → cleanup/abort → mount), so both
       reads must see the same published snapshot. */
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot('reading_path', [
      rootNode(),
      bookmark('nd-col-u01-01-002', 'Known repo', 'https://github.com/know-n/web', '00000000000000000001'),
      bookmark('nd-col-u01-01-001', 'Transformers paper', 'https://arxiv.org/abs/1706.03762', '00000000000000000000'),
      bookmark('nd-col-u01-01-003', 'Plain page', 'https://example.web/page', '00000000000000000002'),
    ]))
    renderPath('/path/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('h1')?.textContent).toBe('LLM learning path')
    const titles = [...document.querySelectorAll('[aria-label="Path steps"] button strong')].map((node) => node.textContent)
    expect(titles).toEqual(['Transformers paper', 'Known repo', 'Plain page'])
    const stepList = document.querySelector('[aria-label="Path steps"]')
    expect(stepList?.textContent).toContain('example.web')
    expect(stepList?.textContent).not.toContain('· Link')
    const crumbs = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a')]
    expect(crumbs[1]?.textContent).toBe('LLM learning path')
    expect(crumbs[1]?.getAttribute('href')).toBe('/c/llm-learning-path')
    const open = [...document.querySelectorAll('a')].find((anchor) => (
      anchor.textContent?.includes('Open bookmark')
    ))
    expect(open?.getAttribute('href')).toBe(
      '/r/nd-col-u01-01-001?collectionId=col-u01-01&subjectType=node&slug=llm-learning-path',
    )
    expect(open?.getAttribute('target')).toBeNull()
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toMatch(/\bmin\b/)
    expect(document.body.textContent).not.toContain('radix-ui')
    expect(pageMetaContent('meta[name="description"]')).toBe('A public reading path from the snapshot.')
    expect(canonicalHref()).toBe('https://know-n.com/c/llm-learning-path')
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(pageMetaContent('meta[property="og:url"]')).toBe(canonicalHref())
  })

  it('shows unavailable instead of Interface Systems when the snapshot is missing', async () => {
    installPageMetaBaseline()
    /* A withdrawn slug answers 404 for every read, not just the first. */
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))
    renderPath('/path/missing-notes')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelector('[role="status"] h1')?.textContent).toBe('Collection unavailable')
    expect(document.querySelector('[role="status"]')?.classList.contains('not-found-stage')).toBe(true)
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('missing-notes')
    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('advances to the next step only after the progress write lands', async () => {
    mocks.isLive.mockImplementation((flag: string) => flag === 'readingProgress')
    mocks.toggleComplete.mockResolvedValue('saved')
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderPath('/path/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(stageTitle()).toBe('Transformers paper')
    await act(async () => { markCompleteButton().click() })
    expect(mocks.toggleComplete).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith('Completed · Transformers paper')
    expect(stageTitle()).toBe('Known repo')
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('stays on the step and reports when the progress write fails', async () => {
    /* The check must not vanish with the step change: a failed write keeps
       the current step and toasts instead of silently advancing. */
    mocks.isLive.mockImplementation((flag: string) => flag === 'readingProgress')
    mocks.toggleComplete.mockResolvedValue('error')
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderPath('/path/llm-learning-path')
    await waitForDom(domFinishedLoading)

    await act(async () => { markCompleteButton().click() })
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('Could not save progress'))
    expect(stageTitle()).toBe('Transformers paper')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('stays silent when a newer write superseded this one', async () => {
    /* 'skipped' = the write was aborted or a newer generation won — it may
       still have landed, so an error toast would misreport it. */
    mocks.isLive.mockImplementation((flag: string) => flag === 'readingProgress')
    mocks.toggleComplete.mockResolvedValue('skipped')
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderPath('/path/llm-learning-path')
    await waitForDom(domFinishedLoading)

    await act(async () => { markCompleteButton().click() })
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(stageTitle()).toBe('Transformers paper')
  })

  it('lets a guest keep progress on this device without a progress write', async () => {
    mocks.isLive.mockImplementation((flag: string) => flag === 'readingProgress')
    mocks.auth.isLoggedIn = false
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderPath('/path/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Progress stays on this device.')
    expect(stageTitle()).toBe('Transformers paper')
    await act(async () => { markCompleteButton().click() })
    expect(mocks.toggleComplete).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('Completed · Transformers paper')
    expect(stageTitle()).toBe('Known repo')
  })

  it('explains non-reading-path collections and links back to the board', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot('bookmarks'))
    renderPath('/path/llm-learning-path')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[aria-label="Path steps"]')).toBeNull()
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.body.textContent).toMatch(/not a reading path/i)
    expect(document.body.textContent).not.toContain('Open bookmark')
  })
})
