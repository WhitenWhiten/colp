// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionSnapshot, PublicReportIssue, PublicReportSeries } from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { ReportIssue } from './ReportIssue'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: false, bootstrapping: false, user: null as null | { profileId: string; handle: string } },
  getPublicReportIssue: vi.fn<(slug: string, editionId: string, options?: unknown) => Promise<PublicReportIssue>>(),
  getPublicReportSeries: vi.fn<(slug: string, options?: unknown) => Promise<PublicReportSeries>>(),
  loadPublicCollectionSnapshot: vi.fn<(slug: string, options?: unknown) => Promise<PublicCollectionSnapshot>>(),
  getReportFollowState: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      getPublicReportIssue: mocks.getPublicReportIssue,
      getPublicReportSeries: mocks.getPublicReportSeries,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      getReportFollowState: mocks.getReportFollowState,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

function issue(id: string, title: string, publishedAt: string, overrides: Partial<PublicReportIssue> = {}): PublicReportIssue {
  return {
    id, title, publishedAt, summary: `${title} summary`,
    url: `/reports/weekly-notes/issues/${id}`, sourceCollectionSlug: `${id}-collection`,
    ...overrides,
  }
}

const ISSUES = [
  issue('ed-3', 'Weekly notes #3', '2026-09-01T00:00:00.000Z'),
  issue('ed-2', 'Weekly notes #2', '2026-08-25T00:00:00.000Z'),
  issue('ed-1', 'Weekly notes #1', '2026-08-18T00:00:00.000Z'),
]

function series(overrides: Partial<PublicReportSeries> = {}): PublicReportSeries {
  return {
    id: 'series-1', slug: 'weekly-notes', title: 'Weekly notes', summary: 'Seven links worth your Sunday.',
    visibility: 'public', indexable: true, updatedAt: '2026-09-01T00:00:00.000Z', issues: ISSUES, ...overrides,
  }
}

function snapshot(slug: string, bookmarks: string[] = ['First find', 'Second find']): PublicCollectionSnapshot {
  return {
    collection: {
      id: `col-${slug}`, slug, title: 'Issue sources', summary: null, kind: 'bookmarks',
      rootNodeId: 'root', updatedAt: '2026-09-01T00:00:00.000Z', access: 'public',
      owner: { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'curator', displayName: 'Curator', avatarUrl: null },
    },
    nodes: [
      { id: 'root', parentId: null, kind: 'root', title: 'Issue sources', description: null, url: null, position: null },
      ...bookmarks.map((title, index) => ({
        id: `bm-${index}`, parentId: 'root', kind: 'bookmark' as const, title,
        description: `${title} description`, url: `https://example.test/${index}`, position: String(index),
      })),
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

function render(path = '/reports/weekly-notes/issues/ed-2') {
  mountTree(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reports/:slug/issues/:editionId" element={<ReportIssue />} />
        <Route path="/reports/:slug" element={<p data-testid="series-route">Series</p>} />
        <Route path="/reports" element={<p>Directory</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function neighbour(direction: 'older' | 'newer'): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(`[data-testid="report-issue-${direction}"]`)
}

describe('ReportIssue', () => {
  beforeEach(() => {
    clearRouteCache()
    installPageMetaBaseline()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.auth = { isLoggedIn: false, bootstrapping: false, user: null }
    mocks.getPublicReportSeries.mockResolvedValue(series())
    mocks.loadPublicCollectionSnapshot.mockImplementation(async (slug) => snapshot(slug))
    mocks.getReportFollowState.mockResolvedValue({ following: false, followerCount: 0, followedAt: null })
    window.__KNOWN_FLAGS__ = { reports: true }
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = ''
  })

  it('offers the shared appearance editor with a digest embed URL', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    render()
    await waitForDom(() => findButtonByName('Embed').textContent === 'Embed')
    expect(document.querySelector('[data-testid="share-embed-block"]')).toBeNull()
    expect(document.querySelector('[data-testid="share-embed-live"]')).toBeNull()
    act(() => findButtonByName('Embed').click())
    await waitForDom(() => document.querySelector('[data-testid="share-embed-code"]') !== null)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.parentElement).toBe(document.body)
    expect(dialog?.getAttribute('aria-label')).toBe('Embed this issue')
    expect(dialog?.querySelector('h2')?.textContent).toBe('Embed')
    expect(dialog?.querySelector('[data-testid="modal-panel"]')?.classList.contains('modal-panel--lg')).toBe(true)
    expect(document.querySelector('[data-testid="share-embed-live"]')?.getAttribute('src')).toBe('/reports/weekly-notes/issues/ed-2?embed=1')
    expect(document.querySelector('[data-testid="share-embed-code"]')?.textContent).toContain('https://know-n.com/reports/weekly-notes/issues/ed-2?embed=1')
    expect(document.querySelector('select[aria-label="Body font"]')).not.toBeNull()
  })

  it('renders the masthead with series context, the entry stream and both neighbours', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    render()
    await waitForDom(domFinishedLoading)

    expect(document.title).toBe('Weekly notes #2 — Know-N')
    expect(canonicalHref()).toBe('https://know-n.com/reports/weekly-notes/issues/ed-2')
    expect(pageMetaContent('meta[name="description"]')).toBe('Weekly notes #2 summary')
    expect(robotsContents()).toEqual([])
    // R15-11: the issue masthead carries a report path.
    await waitForDom(() => document.querySelector('[data-testid="report-digest-issue"]') !== null)

    // Single reading column: no publication rail, no toolbar — the
    // breadcrumb returns to the directory and the series home.
    const page = document.querySelector('[data-testid="report-issue-page"]')!
    expect(page.getAttribute('data-view')).toBeNull()
    expect(document.querySelector('[data-testid="digest-rail"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-toolbar"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-entries-count"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-section-filter"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-pub-bar"]')).toBeNull()
    expect(document.querySelector('a.report-back')).toBeNull()
    const crumbs = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a')]
    expect(crumbs.map((crumb) => [crumb.textContent, crumb.getAttribute('href')])).toEqual([
      ['Digests', '/reports'],
      ['Weekly notes', '/reports/weekly-notes'],
    ])
    expect(document.querySelector('nav[aria-label="Breadcrumb"]')?.textContent).toContain('Weekly notes #2')

    const header = document.querySelector('header.page-head')!
    // Digests read in the editorial serif head (PRODUCT.md).
    expect(header.classList.contains('page-head--editorial')).toBe(true)
    // Edition eyebrow: just the publish date (the fixture carries no
    // editionOrdinal, so no "No. X" prefix).
    const meta = header.querySelector('span.report-issue-meta')
    expect(meta?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-25T00:00:00.000Z')
    expect(meta?.querySelector('time')?.textContent).toBe('Aug 25, 2026')
    expect(header.querySelector('h1')?.textContent).toBe('Weekly notes #2')
    // The issue summary reads as the masthead lede.
    expect(header.querySelector('p.lede')?.textContent).toBe('Weekly notes #2 summary')
    // Head actions are gone: "Open as collection" sits in the footer row.
    expect(header.querySelector('a[href="/c/ed-2-collection"]')).toBeNull()
    expect(document.querySelector('div.report-issue-actions a[href="/c/ed-2-collection"]')?.textContent).toBe('Source collection')

    const entries = document.querySelector('[data-testid="report-entries"]')!
    expect(entries.querySelector('h2')).toBeNull()
    expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalledWith('ed-2-collection', expect.anything())
    // Edition entries, not library bookmark rows — and no numbering chrome.
    const digestEntries = entries.querySelectorAll('[data-testid="digest-entry"]')
    expect(digestEntries).toHaveLength(2)
    expect(entries.querySelector('[data-collection-view]')).toBeNull()
    expect(entries.querySelector('span.digest-entry-index')).toBeNull()
    expect(entries.querySelector('div.digest-board')).toBeNull()
    expect(digestEntries[0]?.querySelector('a.digest-entry-title')?.getAttribute('href')).toBe('https://example.test/0')
    expect(digestEntries[0]?.querySelector('a.digest-entry-title')?.getAttribute('target')).toBe('_blank')
    expect(entries.textContent).toContain('First find')
    expect(entries.textContent).toContain('Second find')

    const nav = document.querySelector('nav[aria-label="More issues in this digest"]')
    expect(nav).not.toBeNull()
    expect(neighbour('older')?.getAttribute('href')).toBe('/reports/weekly-notes/issues/ed-1')
    expect(neighbour('older')?.textContent).toContain('Older issue')
    expect(neighbour('older')?.textContent).toContain('Weekly notes #1')
    expect(neighbour('older')?.textContent).toContain('Aug 18, 2026')
    expect(neighbour('newer')?.getAttribute('href')).toBe('/reports/weekly-notes/issues/ed-3')
    expect(neighbour('newer')?.textContent).toContain('Newer issue')
    expect(neighbour('newer')?.textContent).toContain('Weekly notes #3')
  })

  it('renders public tldr/note snippets in the issue entry stream', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot('ed-2-collection'),
      nodes: [
        { id: 'root', parentId: null, kind: 'root', title: 'Issue sources', description: null, url: null, position: null },
        {
          id: 'bm-0', parentId: 'root', kind: 'bookmark', title: 'First find',
          description: 'First find description', url: 'https://example.test/0', position: '0',
          tldr: 'Issue takeaway from the curator',
          note: 'Issue note from the curator',
        },
      ],
    })
    render()
    await waitForDom(domFinishedLoading)

    const entries = document.querySelector('[data-testid="report-entries"]')!
    // TL;DR and the curator's note share one style, so each carries a label.
    expect(entries.querySelector('[data-testid="bookmark-tldr"] .digest-entry-note-label')?.textContent).toBe('TL;DR')
    expect(entries.querySelector('[data-testid="bookmark-note"] .digest-entry-note-label')?.textContent).toBe('Curator’s note')
    expect(entries.textContent).toContain('Issue takeaway from the curator')
    expect(entries.textContent).toContain('Issue note from the curator')
    // "Open as collection" lives in the footer actions row.
    expect(document.querySelector('div.report-issue-actions a[href="/c/ed-2-collection"]')?.textContent).toBe('Source collection')
  })

  it('only links the older issue from the newest edition and navigates to it', async () => {
    // The endpoint answers per requested edition: the StrictMode mount asks
    // twice for ed-3 and the in-app navigation asks for ed-2, so key the
    // fixture on the request instead of on an invocation count.
    mocks.getPublicReportIssue.mockImplementation(async (_slug: string, editionId: string) => (
      editionId === 'ed-3' ? ISSUES[0]! : ISSUES[1]!
    ))
    render('/reports/weekly-notes/issues/ed-3')
    await waitForDom(domFinishedLoading)

    expect(neighbour('newer')).toBeNull()
    expect(neighbour('older')?.getAttribute('href')).toBe('/reports/weekly-notes/issues/ed-2')
    act(() => neighbour('older')!.click())
    await waitForDom(() => document.querySelector('h1')?.textContent === 'Weekly notes #2')
    expect(mocks.getPublicReportIssue).toHaveBeenLastCalledWith('weekly-notes', 'ed-2', expect.anything())
    expect(neighbour('newer')?.getAttribute('href')).toBe('/reports/weekly-notes/issues/ed-3')
  })

  it('renders no neighbour navigation when the issue is outside the bounded archive', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(issue('ed-0', 'Weekly notes #0', '2026-08-11T00:00:00.000Z'))
    render('/reports/weekly-notes/issues/ed-0')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('h1')?.textContent).toBe('Weekly notes #0')
    expect(document.querySelector('nav[aria-label="More issues in this digest"]')).toBeNull()
  })

  it('reports entries unavailable when the issue has no public source collection', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(issue('ed-2', 'Weekly notes #2', '2026-08-25T00:00:00.000Z', { sourceCollectionSlug: undefined }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Entries unavailable')
    expect(document.body.textContent).toContain("This issue doesn't link to a public collection.")
    expect(document.querySelector('a[href^="/c/"]')).toBeNull()
    expect(mocks.loadPublicCollectionSnapshot).not.toHaveBeenCalled()
  })

  it('retries a failed source collection load and keeps the collection link', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    mocks.loadPublicCollectionSnapshot
      .mockRejectedValueOnce(new ProductApiError({ status: 503, code: 'transport_error', message: 'offline' }))
      .mockResolvedValueOnce(snapshot('ed-2-collection', ['Recovered find']))
    render()
    await waitForDom(domFinishedLoading)

    const alert = document.querySelector('[data-testid="report-entries"] [role="alert"]')
    expect(alert?.textContent).toContain("Couldn't load this issue's entries")
    expect(alert?.querySelector('a[href="/c/ed-2-collection"]')?.textContent).toBe('Open the collection')
    act(() => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="report-entries"] [role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Recovered find')
    expect(document.querySelectorAll('[data-testid="digest-entry"]')).toHaveLength(1)
  })

  it('shows the empty entries state for a collection without visible items', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot('ed-2-collection', []))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelectorAll('[data-testid="digest-entry"]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No visible entries')
  })

  it('holds the social cluster\'s row while the series loads', async () => {
    let resolveSeries: (value: ReturnType<typeof series>) => void = () => undefined
    mocks.getPublicReportSeries.mockImplementation(() => new Promise((resolve) => { resolveSeries = resolve }))
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    render()
    await waitForDom(() => document.querySelector('[data-testid="social-actions-pending"]') !== null)
    const pending = document.querySelector('[data-testid="social-actions-pending"]')
    expect(pending?.getAttribute('aria-hidden')).toBe('true')
    expect(pending?.childElementCount).toBe(0)
    expect(document.querySelector('[data-testid="social-actions"]')).toBeNull()

    await act(async () => { resolveSeries(series()) })
    await waitForDom(() => document.querySelector('[data-testid="social-actions"]') !== null)
    expect(document.querySelector('[data-testid="social-actions-pending"]')).toBeNull()
  })

  it('marks issues of non-indexable series noindex', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({ indexable: false }))
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    render()
    await waitForDom(domFinishedLoading)
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('renders the unavailable state with a way back to the series', async () => {
    mocks.getPublicReportIssue.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'gone' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('h1')?.textContent).toBe('Issue unavailable')
    expect(document.querySelector('a[href="/reports/weekly-notes"]')?.textContent).toBe('Back to the digest')
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('shows the loading state, then a retryable alert when the issue fails to load', async () => {
    // StrictMode replays the mount effect, so "the load fails" has to be the
    // endpoint's base behaviour: a single queued rejection is consumed by the
    // first invocation and the replay renders the issue instead.
    mocks.getPublicReportIssue.mockRejectedValue(new Error('network'))
    render()
    expect(document.querySelector('[data-testid="report-issue-loading"]')).not.toBeNull()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"] h1')?.textContent).toBe("Couldn't load this issue")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Check your connection and try again.')
    // The endpoint recovers: the retry is a fresh request that succeeds.
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    act(() => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('h1')?.textContent).toBe('Weekly notes #2')
  })

  it('renders the curator byline and follow button under the masthead', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({
      followerCount: 42,
      curator: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA',
        handle: 'curator',
        displayName: 'Curator Chen',
        avatarUrl: null,
      },
    }))
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    render()
    await waitForDom(domFinishedLoading)

    const byline = document.querySelector('p.report-series-byline')!
    expect(byline).not.toBeNull()
    // Curator card: the same ProfileHoverCard trigger the series page uses.
    const trigger = byline.querySelector<HTMLAnchorElement>('[data-testid="profile-hover-trigger"]')
    expect(trigger?.getAttribute('href')).toBe('/u/curator')
    expect(trigger?.textContent).toContain('Curator Chen')
    const follow = document.querySelector('[data-testid="report-follow-signin"]')
    expect(follow).not.toBeNull()
    expect(byline.contains(follow)).toBe(false)
  })

  it('skips a hidden sibling in the neighbour footer', async () => {
    const tombstone = {
      ...issue('ed-2', 'Issue hidden', '2026-08-25T00:00:00.000Z'),
      summary: null,
      url: null,
      sourceCollectionSlug: null,
      state: 'hidden' as const,
    }
    mocks.getPublicReportSeries.mockResolvedValue(series({ issues: [ISSUES[0]!, tombstone, ISSUES[2]!] }))
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[0]!)
    render('/reports/weekly-notes/issues/ed-3')
    await waitForDom(domFinishedLoading)

    // The neighbour footer skips the hidden edition: ed-3's older readable
    // neighbour is ed-1.
    expect(neighbour('older')?.getAttribute('href')).toBe('/reports/weekly-notes/issues/ed-1')
    expect(neighbour('older')?.textContent).toContain('Weekly notes #1')
    expect(neighbour('newer')).toBeNull()
  })

  it('shows the issue number and the reporting period in the eyebrow', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(issue('ed-2', 'Weekly notes #2', '2026-08-25T00:00:00.000Z', {
      issueKey: '2026-W35',
      editionOrdinal: 2,
      periodStart: '2026-08-18T00:00:00.000Z',
      periodEnd: '2026-08-25T00:00:00.000Z',
    }))
    render()
    await waitForDom(domFinishedLoading)

    const meta = document.querySelector('header.page-head .report-issue-meta')!
    expect(meta.textContent).toContain('No. 2')
    expect(meta.textContent).toContain('Aug 25, 2026')
    // The issue key stays out of the masthead; the coverage range joins it.
    expect(meta.textContent).not.toContain('2026-W35')
    const period = meta.querySelector('[data-testid="report-issue-period"]')
    expect(period?.textContent).toContain('Covers')
    expect(period?.textContent).toContain('Aug 18, 2026')
    expect(period?.textContent).toContain('Aug 25, 2026')
    expect(document.querySelectorAll('[data-testid="report-issue-period"]')).toHaveLength(1)
  })

  it('folds source-collection folders into anchored, numbered sections', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot('ed-2-collection'),
      nodes: [
        { id: 'root', parentId: null, kind: 'root', title: 'Issue sources', description: null, url: null, position: null },
        { id: 'lead', parentId: 'root', kind: 'bookmark', title: 'Lead find', description: null, url: 'https://example.test/lead', position: '0' },
        { id: 'f-research', parentId: 'root', kind: 'folder', title: 'Research', description: null, url: null, position: '1' },
        { id: 'f1-a', parentId: 'f-research', kind: 'bookmark', title: 'Paper', description: null, url: 'https://example.test/paper', position: '0' },
        { id: 'f-tools', parentId: 'root', kind: 'folder', title: 'Tools', description: null, url: null, position: '2' },
        { id: 'f2-a', parentId: 'f-tools', kind: 'bookmark', title: 'CLI', description: null, url: 'https://example.test/cli', position: '0' },
      ],
    })
    render()
    await waitForDom(domFinishedLoading)

    const entries = document.querySelector('[data-testid="report-entries"]')!
    expect(entries.querySelectorAll('[data-testid="digest-entry"]')).toHaveLength(3)

    const sections = [...entries.querySelectorAll('section[aria-label]')]
    // Top-level sections carry roman numerals (I. Research).
    expect(sections.map((s) => s.querySelector('h2')?.textContent)).toEqual(['I. Research', 'II. Tools'])
    expect(sections[0]?.id).toBe('rsec-f-research')
    expect(sections[1]?.textContent).toContain('CLI')
    // The root-level bookmark renders ahead of the named sections.
    expect(entries.textContent?.indexOf('Lead find')).toBeLessThan(entries.textContent?.indexOf('Paper') ?? 0)
  })

  it('offers one Save all to library action only to signed-in readers', async () => {
    mocks.getPublicReportIssue.mockResolvedValue(ISSUES[1]!)
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toContain('Save all to library')
    expect(document.querySelectorAll('[data-collection-resource-save]')).toHaveLength(0)

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    clearRouteCache()
    mocks.auth = { isLoggedIn: true, bootstrapping: false, user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'reader' } }
    render()
    await waitForDom(domFinishedLoading)
    // One page-level action — never a save icon per entry.
    expect(document.querySelectorAll('[data-collection-resource-save]')).toHaveLength(0)
    const saveAll = findButtonByName('Save all to library')
    expect(saveAll).not.toBeNull()
  })
})
