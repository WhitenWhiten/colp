// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './Library'
import { PathReader } from './PathReader'
import { Reader } from './Reader'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const progress = vi.hoisted(() => ({
  state: { progress: 0.65, status: 'in_progress', saveState: 'saved', message: 'Progress saved', setProgress: vi.fn(), toggleComplete: vi.fn(), retry: vi.fn(), flush: vi.fn(), reload: vi.fn() },
  list: { items: [{ resourceType: 'node', resourceId: 'nd-col-u01-01-001', status: 'completed', progress: 1, completedAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z', etag: '"r1"', target: { availability: 'available', collectionId: 'c1', title: 'Reading item', url: 'https://reading.test' } }], state: 'ready', message: '', reload: vi.fn() },
  loadPublicCollectionSnapshot: vi.fn(),
  loadEditorSnapshot: vi.fn(),
  getNodeReadableReplica: vi.fn(),
  readable: false,
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: (flag: string) => ['savedResources', 'readingProgress'].includes(flag),
    isReadableReplicaExposureEnabled: () => progress.readable,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: progress.loadPublicCollectionSnapshot,
      loadEditorSnapshot: progress.loadEditorSnapshot,
      getNodeReadableReplica: progress.getNodeReadableReplica,
      getMyLibraryOrder: vi.fn(async () => ({ sections: { mine: [], shared: [], following: [] } })),
      listFollowedCollections: vi.fn(async () => ({ items: [], nextCursor: null })),
      listFollowedReports: vi.fn(async () => ({ items: [], nextCursor: null })),
      listMyReports: vi.fn(async () => ({ items: [], nextCursor: null })),
      getFollowedReportIssuesPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    },
  }
})
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ isLoggedIn: true, bootstrapping: false }) }))
vi.mock('../lib/useReadingProgress', () => ({ useReadingProgress: () => progress.state, useReadingProgressList: () => progress.list }))
vi.mock('../lib/useSavedResource', () => ({ useSavedResources: () => ({ items: [{ resourceType: 'node', resourceId: 'medium', savedAt: '2026-07-25T00:00:00Z', target: { availability: 'available', collectionId: 'c1', title: 'Reading item', url: 'https://reading.test' } }], state: 'ready', message: '' }), useSavedResource: () => ({ state: 'ready', saved: false, pending: false, label: 'Save', toggle: vi.fn(), retry: vi.fn(), reload: vi.fn() }) }))
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

function editorSnapshot() {
  return {
    collection: {
      id: 'c1', title: 'Reading', kind: 'bookmarks', summary: '', visibility: 'private',
      allowSearchIndexing: false, rootNodeId: 'root', publicationSlug: null, publishedAt: null,
      revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '',
    },
    root: {
      id: 'root', collectionId: 'c1', kind: 'folder', folderRole: 'root', parentId: null, position: null,
      title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr', etag: '"rr"',
      readOnly: false, readOnlyReason: null, childrenRevision: 'cr', childrenEtag: '"cr"',
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    },
    nodes: [{
      id: 'nd-col-u01-01-001', collectionId: 'c1', kind: 'bookmark', title: 'Reading item',
      url: 'https://reading.test', description: null, tags: [], visibility: 'inherit', revision: 'n1',
      etag: '"n1"', parentId: 'root', position: 'a', readOnly: false, readOnlyReason: null,
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
  }
}

function readyReplica() {
  return {
    nodeId: 'nd-col-u01-01-001', collectionId: 'c1', status: 'ready', sourceUrl: 'https://reading.test',
    title: 'Reading item', byline: null, wordCount: 600, extractedAt: '2026-08-25T00:00:00.000Z', failureCode: null,
    sections: [{ id: 'sec-1', heading: 'Opening', paragraphs: [{ id: 'p-1', text: 'Hello reader.' }] }],
    etag: '"rr-1"',
  }
}

describe('Reader, Path Reader, and Library Reading Progress surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    progress.readable = false
    progress.state.status = 'in_progress'; progress.state.progress = 0.65
    progress.loadEditorSnapshot.mockResolvedValue(editorSnapshot())
    progress.getNodeReadableReplica.mockResolvedValue(readyReplica())
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function mount(element: React.ReactNode, route = '/') { mountTree(<MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>) }

  it('hydrates Reader progress state and sends complete/uncomplete through the shared workflow', async () => {
    mount(<Routes><Route path="/read/:resourceId" element={<Reader />} /></Routes>, '/read/nd-col-u01-01-001?collectionId=c1&subjectType=node'); await waitForDom(domFinishedLoading)
    const toolbar = document.querySelector('[data-testid="reading-progress-state"]')
    expect(toolbar?.getAttribute('data-progress')).toBe('0.65')
    expect(toolbar?.getAttribute('data-progress-save-state')).toBe('saved')
    expect(document.body.textContent).toContain('Progress saved')
    // No readable copy on screen → no percentage of nothing, no progress bar.
    expect(document.body.textContent).not.toContain('% read')
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    const save = document.querySelector<HTMLButtonElement>('[data-testid="reading-progress-state"] button[aria-label="Save"]')
    expect(save).not.toBeNull()
    expect(save?.getAttribute('aria-label')).toBe('Save')
    expect(save?.querySelector('[data-icon="bookmark"]')).not.toBeNull()
    expect(save?.querySelector('span')?.textContent).toBe('Save')
    act(() => ([...document.querySelectorAll('button')].find((b) => b.textContent === 'Mark complete') as HTMLButtonElement).click())
    expect(progress.state.toggleComplete).toHaveBeenCalledTimes(1)
  })

  it('shows the Reader percentage and progress bar once the readable copy is on screen', async () => {
    progress.readable = true
    mount(<Routes><Route path="/read/:resourceId" element={<Reader />} /></Routes>, '/read/nd-col-u01-01-001?collectionId=c1&subjectType=node'); await waitForDom(domFinishedLoading)
    await waitForDom(() => document.querySelector('[data-testid="reader-paragraph"]') !== null)
    expect(document.body.textContent).toContain('65% read')
    const bar = document.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('65')
    expect(bar?.getAttribute('aria-label')).toBe('Reading progress')
    expect(document.querySelector('[data-testid="reader-source-line"]')?.textContent).toContain('3 min read')
  })

  it('replaces Path Reader device-only state with authoritative per-resource completion', async () => {
    progress.state.status = 'completed'; progress.state.progress = 1
    /* The public snapshot endpoint answers the same for every mount of the
       slug; StrictMode's remount must not drain a one-shot queue. */
    progress.loadPublicCollectionSnapshot.mockResolvedValue({
      collection: {
        id: 'col-u01-01',
        slug: 'llm-learning-path',
        title: 'LLM learning path',
        summary: 'A public reading path.',
        kind: 'reading_path',
        rootNodeId: 'root-1',
        owner: { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'lin', displayName: 'Lin Yichen', avatarUrl: null },
        updatedAt: '2026-07-24T12:00:00.000Z',
        access: 'public',
      },
      nodes: [
        { id: 'root-1', parentId: null, kind: 'root', title: 'Published contents', description: null, url: null, position: null },
        {
          id: 'nd-col-u01-01-001', parentId: 'root-1', kind: 'bookmark', title: 'Transformers paper',
          description: 'Attention notes', url: 'https://arxiv.org/abs/1706.03762', position: '00000000000000000000',
        },
      ],
      page: { cursor: null, hasMore: false, sequence: 1 },
    })
    mount(<Routes><Route path="/path/:slug" element={<PathReader />} /></Routes>, '/path/llm-learning-path'); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toContain('stays on this device'); expect(document.body.textContent).toContain('Progress syncs to your account.')
    const incomplete = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Mark incomplete') as HTMLButtonElement
    act(() => incomplete.click()); expect(progress.state.toggleComplete).toHaveBeenCalled()
    const open = [...document.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes('Open bookmark'))
    expect(open?.getAttribute('href')).toBe(
      '/r/nd-col-u01-01-001?collectionId=col-u01-01&subjectType=node&slug=llm-learning-path',
    )
    expect(open?.getAttribute('target')).toBeNull()
  })

  it('hydrates Library rows from the private progress list and exposes no legacy read toggle', async () => {
    mount(<Library />); await waitForDom(domFinishedLoading); expect(document.body.textContent).toContain('Reading item'); expect(document.body.textContent).toContain('Completed')
    expect(document.querySelector('[aria-label="Mark as read"]')).toBeNull()
  })
})
