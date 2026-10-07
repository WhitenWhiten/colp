// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicReportIssue, PublicReportSeries } from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { ReportSeries } from './ReportSeries'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false, user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'reader' } },
  getPublicReportSeries: vi.fn<(slug: string, options?: unknown) => Promise<PublicReportSeries>>(),
  getReportFollowState: vi.fn(),
  followReport: vi.fn(),
  unfollowReport: vi.fn(),
  abandonReportFollowIntent: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      getPublicReportSeries: mocks.getPublicReportSeries,
      getReportFollowState: mocks.getReportFollowState,
      followReport: mocks.followReport,
      unfollowReport: mocks.unfollowReport,
      abandonReportFollowIntent: mocks.abandonReportFollowIntent,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))

function issue(id: string, title: string, publishedAt: string, summary: string | null = `${title} summary`): PublicReportIssue {
  return { id, title, publishedAt, summary, url: `/reports/weekly-notes/issues/${id}`, sourceCollectionSlug: `${id}-collection` }
}

function series(overrides: Partial<PublicReportSeries> = {}): PublicReportSeries {
  return {
    id: 'series-1',
    slug: 'weekly-notes',
    title: 'Weekly notes',
    summary: 'Seven links worth your Sunday.',
    visibility: 'public',
    indexable: true,
    updatedAt: '2026-09-01T00:00:00.000Z',
    issues: [
      issue('ed-3', 'Weekly notes #3', '2026-09-01T00:00:00.000Z'),
      issue('ed-2', 'Weekly notes #2', '2026-08-25T00:00:00.000Z', null),
      issue('ed-1', 'Weekly notes #1', '2026-08-18T00:00:00.000Z'),
    ],
    ...overrides,
  }
}

function render(path = '/reports/weekly-notes') {
  mountTree(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reports/:slug" element={<ReportSeries />} />
        <Route path="/reports" element={<p>Directory</p>} />
        <Route path="/login" element={<p>Login</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ReportSeries', () => {
  beforeEach(() => {
    clearRouteCache()
    installPageMetaBaseline()
    vi.clearAllMocks()
    mocks.auth = { isLoggedIn: true, bootstrapping: false, user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'reader' } }
    mocks.getReportFollowState.mockResolvedValue({ following: false, followerCount: 2, followedAt: null })
    mocks.followReport.mockResolvedValue({ following: true, followerCount: 3, followedAt: '2026-09-02T00:00:00.000Z' })
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
    mocks.getPublicReportSeries.mockResolvedValue(series())
    render()
    await waitForDom(() => findButtonByName('Embed').textContent === 'Embed')
    expect(document.querySelector('[data-testid="share-embed-block"]')).toBeNull()
    expect(document.querySelector('[data-testid="share-embed-live"]')).toBeNull()
    act(() => findButtonByName('Embed').click())
    await waitForDom(() => document.querySelector('[data-testid="share-embed-code"]') !== null)
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.parentElement).toBe(document.body)
    expect(dialog?.getAttribute('aria-label')).toBe('Embed this digest')
    expect(dialog?.querySelector('h2')?.textContent).toBe('Embed')
    expect(dialog?.querySelector('[data-testid="modal-panel"]')?.classList.contains('modal-panel--lg')).toBe(true)
    expect(document.querySelector('[data-testid="share-embed-live"]')?.getAttribute('src')).toBe('/reports/weekly-notes?embed=1')
    expect(document.querySelector('[data-testid="share-embed-code"]')?.textContent).toContain('https://know-n.com/reports/weekly-notes?embed=1')
    expect(document.querySelector('select[aria-label="Body font"]')).not.toBeNull()
  })

  it('renders breadcrumb, masthead stats and the dated archive with issue links', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series())
    render()
    await waitForDom(domFinishedLoading)

    expect(document.title).toBe('Weekly notes — Know-N')
    expect(canonicalHref()).toBe('https://know-n.com/reports/weekly-notes')
    expect(pageMetaContent('meta[name="description"]')).toBe('Seven links worth your Sunday.')
    expect(robotsContents()).toEqual([])

    const crumbs = document.querySelector('nav[aria-label="Breadcrumb"]')
    expect(crumbs?.querySelector('a[href="/reports"]')?.textContent).toBe('Digests')
    expect(crumbs?.textContent).toContain('Weekly notes')

    const header = document.querySelector('header.page-head')!
    // Single-column head: no eyebrow — title, lede, and the follow actions.
    expect(header.querySelector('p.eyebrow')).toBeNull()
    expect(header.querySelector('h1')?.textContent).toBe('Weekly notes')
    expect(header.querySelector('p.lede')?.textContent).toBe('Seven links worth your Sunday.')
    // The publication rail and the featured issue-front are gone; the same
    // issue appears exactly once, in the dated archive.
    expect(document.querySelector('[data-testid="digest-rail"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-featured-issue"]')).toBeNull()
    expect(document.querySelectorAll('a[href="/reports/weekly-notes/issues/ed-3"]')).toHaveLength(1)
    const byline = document.querySelector('p.report-series-byline')
    expect(byline?.textContent?.replace(/\s+/g, ' ')).toContain('3 issues')
    expect(byline?.textContent).not.toContain('Unlisted')

    const archive = document.querySelector('[data-testid="report-archive"]')
    expect(archive?.querySelector('h2')?.textContent).toBe('Issues')
    // The archive lists every edition; the newest is marked is-latest.
    const rows = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="report-issue-list"] a')]
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/reports/weekly-notes/issues/ed-3',
      '/reports/weekly-notes/issues/ed-2',
      '/reports/weekly-notes/issues/ed-1',
    ])
    expect(rows[0]?.classList.contains('is-latest')).toBe(true)
    expect(rows[0]?.textContent).toContain('Latest')
    expect(rows[1]?.classList.contains('is-latest')).toBe(false)
    const second = rows[1]!
    expect(second.querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-25T00:00:00.000Z')
    expect(second.querySelector('time')?.textContent).toBe('Aug 25, 2026')
    expect(second.textContent).toContain('Weekly notes #2')
    // Summary-less issues render no empty paragraph.
    expect(second.textContent).not.toContain('summary')
    expect(rows[2]!.textContent).toContain('Weekly notes #1 summary')
  })

  it('renders a moderation-hidden issue as an inert archive tombstone while the hero falls back', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({
      issues: [
        {
          ...issue('ed-3', 'Issue hidden', '2026-09-01T00:00:00.000Z', null),
          url: null,
          sourceCollectionSlug: null,
          state: 'hidden',
        },
        issue('ed-2', 'Weekly notes #2', '2026-08-25T00:00:00.000Z', null),
        issue('ed-1', 'Weekly notes #1', '2026-08-18T00:00:00.000Z'),
      ],
    }))
    render()
    await waitForDom(domFinishedLoading)

    // The archive carries the only issue list; the hidden edition keeps its
    // tombstone and the newest readable row takes the Latest mark.
    expect(document.querySelector('[data-testid="report-featured-issue"]')).toBeNull()
    expect(document.querySelector('[data-testid="digest-rail"]')).toBeNull()

    // The archive keeps the tombstone in position — dated and titled, but
    // with no link, no arrow icon and no Latest chip.
    const list = document.querySelector('[data-testid="report-issue-list"]')!
    const tombstoneRow = list.querySelector('[data-issue-hidden]')!
    expect(tombstoneRow.tagName).toBe('LI')
    expect(tombstoneRow.querySelector('a')).toBeNull()
    expect(tombstoneRow.querySelector('svg')).toBeNull()
    expect(tombstoneRow.querySelector('time')?.getAttribute('dateTime')).toBe('2026-09-01T00:00:00.000Z')
    expect(tombstoneRow.textContent).toContain('Issue hidden')
    expect(tombstoneRow.textContent).not.toContain('Latest')
    expect(list.children[0]).toBe(tombstoneRow)

    // The newest readable row inherits the is-latest mark and Latest chip.
    const rows = [...list.querySelectorAll<HTMLAnchorElement>('a')]
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/reports/weekly-notes/issues/ed-2',
      '/reports/weekly-notes/issues/ed-1',
    ])
    expect(rows[0]?.classList.contains('is-latest')).toBe(true)
    expect(rows[0]?.textContent).toContain('Latest')
    expect(rows[1]?.classList.contains('is-latest')).toBe(false)
  })

  it('keeps an archive of tombstones when every published issue is hidden', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({
      issues: [
        {
          ...issue('ed-2', 'Issue hidden', '2026-08-25T00:00:00.000Z', null),
          url: null,
          sourceCollectionSlug: null,
          state: 'hidden',
        },
      ],
    }))
    render()
    await waitForDom(domFinishedLoading)
    // Tombstones are position facts, not emptiness: no hero, no Latest stat,
    // no empty-archive state — but the slot stays listed.
    expect(document.querySelector('[data-testid="report-featured-issue"]')).toBeNull()
    expect(document.querySelectorAll('[data-issue-hidden]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="report-issue-list"] a')).toBeNull()
    expect(document.body.textContent).not.toContain('No published issues yet')
    expect(document.body.textContent).not.toContain('Latest')
  })

  it('renders the curator card, follower count and source collection when every issue shares one', async () => {
    const base = series()
    mocks.getPublicReportSeries.mockResolvedValue(series({
      followerCount: 128,
      sourceCollectionSlug: 'weekly-sources',
      issues: base.issues.map((item) => ({ ...item, sourceCollectionSlug: 'weekly-sources' })),
      curator: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA',
        handle: 'curator',
        displayName: 'Curator Chen',
        avatarUrl: null,
      },
    }))
    mocks.getReportFollowState.mockResolvedValue({ following: false, followerCount: 128, followedAt: null })
    render()
    await waitForDom(domFinishedLoading)

    // Curator and the source collection sit in the byline meta-row; the
    // follower count rides the masthead actions next to the follow button.
    const byline = document.querySelector('p.report-series-byline')!
    const trigger = byline.querySelector<HTMLAnchorElement>('[data-testid="profile-hover-trigger"]')
    expect(trigger?.getAttribute('href')).toBe('/u/curator')
    expect(trigger?.textContent).toContain('Curator Chen')
    expect(document.querySelector('[data-testid="report-series-followers"]')?.textContent).toBe('128 followers')
    const source = byline.querySelector('a[href="/c/weekly-sources"]')
    expect(source).not.toBeNull()
    expect(source?.textContent).toContain('Source collection')
    expect(document.querySelector('[data-testid="digest-rail"]')).toBeNull()
  })

  it('omits the series source link when readable issues point at different collections', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({ sourceCollectionSlug: 'ed-3-collection' }))
    render()
    await waitForDom(domFinishedLoading)
    const byline = document.querySelector('p.report-series-byline')
    expect(byline?.querySelector('a[href^="/c/"]')).toBeNull()
    expect(byline?.textContent).not.toContain('Source collection')
  })

  it('hides the curator byline when the owner cannot be projected', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({ curator: undefined, followerCount: undefined }))
    mocks.getReportFollowState.mockResolvedValue({ following: false, followedAt: null })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="profile-hover-trigger"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-series-followers"]')).toBeNull()
  })

  it('signals unlisted series in the stats and keeps them out of the index', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({ visibility: 'unlisted', indexable: false, summary: null }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('p.report-series-byline')?.textContent).toContain('Unlisted')
    expect(robotsContents()).toEqual(['noindex'])
    expect(pageMetaContent('meta[name="description"]')).toBe('Latest issues from Weekly notes.')
  })

  it('shows the empty archive state when no issue is published yet', async () => {
    mocks.getPublicReportSeries.mockResolvedValue(series({ issues: [] }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('p.report-series-byline')?.textContent?.replace(/\s+/g, ' ')).toContain('0 issues')
    expect(document.querySelector('[data-testid="report-issue-list"]')).toBeNull()
    expect(document.querySelector('[data-testid="report-featured-issue"]')).toBeNull()
    expect(document.body.textContent).toContain('No published issues yet')
  })

  it('renders the follow button for signed-in readers and toggles through the workflow', async () => {
    let followed = false
    mocks.getPublicReportSeries.mockResolvedValue(series())
    // Keyed by whether the follow has happened, not by call order: StrictMode
    // mounts the page twice, so a `mockResolvedValueOnce` queue would give the
    // two mounts opposite states and neither would settle.
    mocks.getReportFollowState.mockImplementation(async () => (followed
      ? { following: true, followerCount: 3, followedAt: '2026-09-02T00:00:00.000Z' }
      : { following: false, followerCount: 2, followedAt: null }))
    render()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => document.querySelector('[data-testid="report-follow-label"]')?.textContent === 'Follow')
    expect(mocks.getReportFollowState).toHaveBeenCalledWith('series-1', expect.anything())

    mocks.followReport.mockImplementation(async () => { followed = true; return {} })
    act(() => findButtonByName('Follow').click())
    await waitForDom(() => document.querySelector('[data-testid="report-follow-label"]')?.textContent === 'Unfollow')
    expect(mocks.followReport).toHaveBeenCalledWith('series-1', expect.objectContaining({ intentId: 'report-follow:series-1:follow' }))
    expect(document.querySelector('[data-testid="report-follow"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('offers sign-in instead of the follow button to visitors', async () => {
    mocks.auth = { ...mocks.auth, isLoggedIn: false }
    mocks.getPublicReportSeries.mockResolvedValue(series())
    render()
    await waitForDom(domFinishedLoading)
    const signIn = document.querySelector<HTMLAnchorElement>('[data-testid="report-follow-signin"]')
    expect(signIn?.textContent).toBe('Sign in to follow')
    expect(signIn?.getAttribute('href')).toMatch(/^\/login\?returnTo=/)
    expect(document.querySelector('[data-testid="report-follow"]')).toBeNull()
    expect(mocks.getReportFollowState).not.toHaveBeenCalled()
    // R15-11: visitors can still report the digest.
    expect(document.querySelector('[data-testid="report-digest-series"]')?.textContent).toBe('Report')
  })

  it('shows the loading state, then a retryable alert on failure', async () => {
    /* Endpoint state, not a call queue: the series is unreachable until the
       reader retries, after which it is served. */
    let serving = false
    mocks.getPublicReportSeries.mockImplementation(() => (
      serving
        ? Promise.resolve(series())
        : Promise.reject(new ProductApiError({ status: 503, code: 'transport_error', message: 'offline' }))
    ))
    render()
    expect(document.querySelector('[data-testid="report-series-loading"]')).not.toBeNull()
    await waitForDom(domFinishedLoading)

    const alert = document.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.querySelector('h1')?.textContent).toBe("Couldn't load this digest")
    expect(alert?.textContent).toContain('Network error')
    serving = true
    act(() => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toBe('Weekly notes')
  })

  it('renders the unavailable state for withdrawn series and while the gate is off', async () => {
    mocks.getPublicReportSeries.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'gone' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('h1')?.textContent).toBe('Digest unavailable')
    expect(document.querySelector('a[href="/reports"]')?.textContent).toBe('Browse digests')
    expect(robotsContents()).toEqual(['noindex'])
    expect(document.querySelector('[role="alert"]')).toBeNull()

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    window.__KNOWN_FLAGS__ = { reports: false }
    // The gate short-circuits rendering before any series load can settle.
    mocks.getPublicReportSeries.mockReset().mockReturnValue(new Promise(() => {}))
    render()
    expect(document.querySelector('h1')?.textContent).toBe('Digest unavailable')
  })
})
