// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { AnnotationView, EditorSnapshot } from '../api'
import { ResourceDetail } from './ResourceDetail'
import { cleanup, mountTree } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

const NODE_ID = 'nd-col-u01-01-001'
const mocks = vi.hoisted(() => ({
  loadAnnotations: vi.fn(), loadEditorSnapshot: vi.fn(), loadPublicCollectionSnapshot: vi.fn(),
  auth: { isLoggedIn: true, bootstrapping: false },
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: (flag: string) => flag === 'annotations',
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadAnnotations: mocks.loadAnnotations,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }),
}))

function item(): AnnotationView {
  return {
    id: 'annotation-detail-1', collectionId: 'collection-detail',
    subject: { type: 'node', id: NODE_ID }, type: 'note', format: 'html',
    value: '<img src=x onerror=alert(1)>', visibility: 'private',
    creator: null, provenance: { kind: 'human' }, revision: 'revision-1',
    createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', extensions: {},
  }
}

function editor(title = '3Blue1Brown · 神经网络可视化'): EditorSnapshot {
  return {
    collection: {
      id: 'collection-detail', title: 'Detail collection', kind: 'bookmarks', summary: '',
      visibility: 'private', allowSearchIndexing: false, rootNodeId: 'root', publicationSlug: 'detail-notes',
      publishedAt: null, revision: 'c1', etag: '"c1"', contentRevision: 'cc1', contentEtag: '"cc1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: '', updatedAt: '',
    },
    root: {
      id: 'root', collectionId: 'collection-detail', kind: 'folder', folderRole: 'root', parentId: null,
      position: null, title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr',
      etag: '"rr"', readOnly: false, readOnlyReason: null, childrenRevision: 'cr', childrenEtag: '"cr"',
      createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z',
    },
    nodes: [{
      id: NODE_ID, collectionId: 'collection-detail', kind: 'bookmark', title,
      url: 'https://www.youtube.com/@3blue1brown', description: 'Course entry', tags: ['youtube'],
      visibility: 'inherit', revision: 'n1', etag: '"n1"', parentId: 'root', position: 'a',
      readOnly: false, readOnlyReason: null, createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
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

describe('Resource Detail Annotation entry', () => {

  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.auth.isLoggedIn = true
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.loadAnnotations.mockResolvedValue([item()])
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
    const snapshot = editor()
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot,
      collection: { ...snapshot.collection, slug: 'detail-notes' },
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  it('loads the canonical subject, renders text safely, and hides Reader actions by default', async () => {
    installPageMetaBaseline()
    mountTree(
        <MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=detail-notes`]}>
          <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
        </MemoryRouter>,
      )
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    expect(mocks.loadEditorSnapshot).toHaveBeenCalledWith(
      'collection-detail',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mocks.loadAnnotations).toHaveBeenCalledWith(
      'collection-detail', { resourceType: 'node', resourceId: NODE_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }),
    )
    expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
    expect(document.body.textContent).not.toContain('Spacing as a system')
    expect(document.body.textContent).not.toContain('Suggested reading path')
    expect([...document.querySelectorAll('*')].some((el) => el.classList.contains('resource-hero-media'))).toBe(false)
    expect(document.querySelector('[data-testid="resource-annotation-preview"]')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector<HTMLAnchorElement>('a[href^="/read/"]')).toBeNull()
    expect(document.querySelector<HTMLAnchorElement>('a.btn-primary[href="https://www.youtube.com/@3blue1brown"]')).not.toBeNull()
    expect(document.querySelector<HTMLAnchorElement>(`a[href="/library/collection-detail?node=${NODE_ID}"]`)).not.toBeNull()
    expect(pageMetaContent('meta[name="description"]')).toBe('Read “3Blue1Brown · 神经网络可视化” in a curated Know-N collection.')
    expect(canonicalHref()).toBe(`https://know-n.com/r/${NODE_ID}?slug=detail-notes`)
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(pageMetaContent('meta[property="og:url"]')).toBe(canonicalHref())
    expect(robotsContents()).toEqual([])
  })

  it('restores Reader actions when the shared exposure gate is enabled', async () => {
    window.__KNOWN_FLAGS__ = { readableReplica: true }
    mountTree(
      <MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=detail-notes`]}>
        <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    expect(document.querySelector<HTMLAnchorElement>(`a[href="/read/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=detail-notes"]`)).not.toBeNull()
    expect(document.body.textContent).toContain('Read in Know-N')
    expect(document.body.textContent).toContain('Open reading view')
  })

  it('normalizes and truncates an unsafe node title before using it as a description', async () => {
    installPageMetaBaseline()
    const unsafeTitle = `<script>unsafe\u0000 title</script>\n ${'x'.repeat(700)}`
    // The snapshot endpoint answers every effect pass with the same node.
    mocks.loadEditorSnapshot.mockResolvedValue(editor(unsafeTitle))
    mountTree(
      <MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=detail-notes`]}>
        <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    const description = pageMetaContent('meta[name="description"]') ?? ''
    expect(description).toHaveLength(500)
    expect(description).toMatch(/^Read “<script>unsafe title<\/script> x/u)
    expect(description).not.toMatch(/[\u0000-\u001F\u007F]/u)
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('renders markdown annotation content with safe document structure', async () => {
    installPageMetaBaseline()
    // The annotation list is the same on every effect pass.
    mocks.loadAnnotations.mockResolvedValue([
      { ...item(), format: 'markdown', value: '## Heading\n\n**body**' },
      { ...item(), id: 'tldr-1', type: 'tldr', format: 'markdown', value: '## TLDR\n\n**takeaway**' },
      { ...item(), id: 'highlight-1', type: 'highlight', format: 'json', value: { quote: 'A complete highlighted passage' } },
      { ...item(), id: 'highlight-2', type: 'highlight', format: 'plain', value: 'Legacy plain highlight' },
    ])
    mountTree(
      <MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=detail-notes`]}>
        <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    const preview = document.querySelector('[data-testid="resource-annotation-preview"]')!
    expect(preview.querySelector('h3, h4')?.textContent).toBe('Heading')
    expect(preview.querySelector('strong')?.textContent).toBe('body')
    expect(preview.textContent).not.toContain('##')
    const annotations = document.querySelector('[data-testid="resource-annotation-list"]')!
    expect(annotations.textContent).toContain('A complete highlighted passage')
    const highlights = annotations.querySelectorAll('[data-testid="resource-annotation-item"] blockquote')
    expect(highlights[1]?.textContent).toBe('A complete highlighted passage')
    expect(highlights[2]?.textContent).toBe('Legacy plain highlight')
    expect(annotations.querySelectorAll('[data-testid="resource-annotation-item"]')).toHaveLength(3)
    expect(document.querySelector('script')).toBeNull()
    const tldr = document.querySelector('[data-testid="resource-tldr-body"]')!
    expect(tldr.querySelector('h3, h4')?.textContent).toBe('TLDR')
    expect([...tldr.querySelectorAll('strong')].map((el) => el.textContent)).toContain('takeaway')
    expect(tldr.textContent).not.toContain('##')
  })

  it.each([false, true])('does not request authenticated annotations for guests (collection query: %s)', async (withCollectionId) => {
    mocks.auth.isLoggedIn = false
    mountTree(
      <MemoryRouter initialEntries={[
        `/r/${NODE_ID}?slug=detail-notes${withCollectionId ? '&collectionId=collection-detail' : ''}`,
      ]}>
        <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('h1')?.textContent).toBe('3Blue1Brown · 神经网络可视化')
    expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalled()
    expect(mocks.loadAnnotations).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Sign in to see notes, highlights and relations on this bookmark.')
    expect(document.body.textContent).not.toContain('Loading annotations')
  })

  it('forces non-string markdown values to plain text', async () => {
    installPageMetaBaseline()
    mocks.loadAnnotations.mockResolvedValue([{ ...item(), format: 'markdown', value: { text: '## Heading' } }])
    mountTree(
      <MemoryRouter initialEntries={[`/r/${NODE_ID}?collectionId=collection-detail&subjectType=node&slug=detail-notes`]}>
        <Routes><Route path="/r/:id" element={<ResourceDetail />} /></Routes>
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    const preview = document.querySelector('[data-testid="resource-annotation-preview"]')!
    expect(preview.querySelector('h1,h2,h3,h4,h5,h6,strong')).toBeNull()
    expect(preview.textContent).toContain('## Heading')
  })
})
