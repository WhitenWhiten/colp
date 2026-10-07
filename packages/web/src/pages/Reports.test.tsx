// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicReportIssue, PublicReportPage, PublicReportSeries } from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { Reports } from './Reports'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({
  getPublicReportsPage: vi.fn<(params?: unknown, options?: unknown) => Promise<PublicReportPage>>(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getPublicReportsPage: mocks.getPublicReportsPage,
    },
  }
})

function issue(id: string, title: string, publishedAt: string, editionOrdinal?: number): PublicReportIssue {
  return {
    id, title, publishedAt, summary: `${title} summary`, editionOrdinal,
    url: `/reports/series/issues/${id}`, sourceCollectionSlug: `${id}-collection`,
  }
}

function series(slug: string, title: string, issues: PublicReportIssue[], summary: string | null = `${title} summary`, overrides: Partial<PublicReportSeries> = {}): PublicReportSeries {
  return {
    id: `series-${slug}`, slug, title, summary, visibility: 'public', indexable: true,
    updatedAt: issues[0]?.publishedAt ?? '2026-08-01T00:00:00.000Z', issues,
    ...overrides,
  }
}

function page(items: PublicReportSeries[], nextCursor: string | null = null): PublicReportPage {
  return { items, nextCursor }
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

describe('Reports directory', () => {
  beforeEach(() => {
    clearRouteCache()
    installPageMetaBaseline()
    mocks.getPublicReportsPage.mockReset()
    window.__KNOWN_FLAGS__ = { reports: true }
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = ''
  })

  function render() {
    mountTree(<MemoryRouter><Reports /></MemoryRouter>)
  }

  it('renders the editorial head, count line and nameplate grid with public metadata', async () => {
    mocks.getPublicReportsPage.mockResolvedValue(page([
      series('weekly-notes', 'Weekly notes', [
        issue('ed-2', 'Weekly notes #2', '2026-09-01T00:00:00.000Z', 2),
        issue('ed-1', 'Weekly notes #1', '2026-08-25T00:00:00.000Z', 1),
      ], `${'Weekly notes'} summary`, {
        followerCount: 12,
        curator: { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'curator', displayName: 'Curator Chen', avatarUrl: null },
      }),
      series('quiet-signals', 'Quiet signals', [issue('qs-1', 'Signals, September', '2026-09-03T00:00:00.000Z')]),
      series('fresh-start', 'Fresh start', [], null),
    ]))
    render()
    await waitForDom(domFinishedLoading)

    expect(document.title).toBe('Digests — Know-N')
    expect(canonicalHref()).toBe('https://know-n.com/reports')
    expect(pageMetaContent('meta[name="description"]')).toBe('Public digest series and their latest issues on Know-N.')
    expect(document.querySelector('h1')?.textContent).toBe('Digests')
    // R10-12: the head speaks digest vocabulary once — no eyebrow echoing the title.
    expect(document.querySelector('[data-testid="reports-page"] .eyebrow')).toBeNull()
    expect(document.body.textContent).toContain('3 digests')

    const cards = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="report-series-card"]')]
    expect(cards).toHaveLength(3)
    expect(document.querySelectorAll('[data-testid="report-grid"] [data-testid="report-series-card"]')).toHaveLength(3)
    const weekly = cards[0]!
    expect(weekly.getAttribute('href')).toBe('/reports/weekly-notes')
    expect(weekly.querySelector('h3')?.textContent).toBe('Weekly notes')
    const weeklyText = weekly.textContent?.replace(/\s+/g, ' ') ?? ''
    // The nameplate now shares the CollectionCard anatomy: collection chrome,
    // rss mark + Digest chip, a stats line (followers then latest edition),
    // and the curator row on the card floor.
    expect(weekly.classList.contains('result-card--collection')).toBe(true)
    expect(weekly.querySelector('span.chip--label')?.textContent).toBe('Digest')
    expect(weeklyText).toContain('Curator Chen')
    expect(weeklyText).toContain('No. 2 · Sep 1, 2026')
    expect(weeklyText).toContain('12 followers')
    expect(weeklyText.indexOf('12 followers')).toBeLessThan(weeklyText.indexOf('No. 2'))
    expect(weeklyText).toContain('Weekly notes summary')
    expect(weeklyText).not.toContain('Latest:')
    expect(weekly.querySelector('time')?.getAttribute('dateTime')).toBe('2026-09-01T00:00:00.000Z')

    const signals = cards[1]!
    expect(signals.textContent).toContain('Sep 3, 2026')

    const fresh = cards[2]!
    expect(fresh.textContent).toContain('No issues yet')
    expect(fresh.textContent).not.toContain('Latest')
    // No description when the series has none; the stats line still renders.
    expect(fresh.querySelectorAll('p')).toHaveLength(1)

    expect(document.body.textContent).toContain('All 3 digests loaded')
    expect(document.body.textContent).not.toContain('Load more')
  })

  it('shows the loading state before the first page resolves', () => {
    mocks.getPublicReportsPage.mockReturnValue(new Promise(() => {}))
    render()
    expect(document.querySelector('[data-testid="reports-loading-state"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Loading digests')
    expect(document.body.textContent).not.toContain('No public digests yet')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('retries the first page from the alert state', async () => {
    /* StrictMode's mount → cleanup → mount walk issues the first page twice,
       and the cleanup aborts the first request. Both mount calls therefore
       have to fail for the alert state to survive, so the queued success is
       spent by the retry request instead. */
    mocks.getPublicReportsPage
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(page([series('recovered', 'Recovered digest', [])]))
    render()
    await waitForDom(domFinishedLoading)

    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Couldn't load digests")
    act(() => findButtonByName('Try again').click())
    await waitForDom(() => document.body.textContent?.includes('Recovered digest') === true)

    // Two mount calls plus a single retry request — no retry loop.
    expect(mocks.getPublicReportsPage).toHaveBeenCalledTimes(3)
    expect(mocks.getPublicReportsPage.mock.calls[2]?.[0]).toEqual({ limit: 24 })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Recovered digest')
  })

  it('offers Explore from the empty and exposure-off states', async () => {
    mocks.getPublicReportsPage.mockResolvedValue(page([]))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('No public digests yet')
    expect(document.querySelector('[role="status"] a[href="/explore"]')?.textContent).toBe('Explore collections')
    expect(document.querySelector('[data-testid="report-grid"]')).toBeNull()

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    window.__KNOWN_FLAGS__ = { reports: false }
    mocks.getPublicReportsPage.mockClear()
    render()
    expect(document.body.textContent).toContain('Digests are not available yet')
    expect(document.querySelector('[role="status"] a[href="/explore"]')).not.toBeNull()
    expect(mocks.getPublicReportsPage).not.toHaveBeenCalled()
  })

  it('treats a backend 404 as the exposure-off state', async () => {
    mocks.getPublicReportsPage.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not exposed' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Digests are not available yet')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('loads the next page with the cursor, keeps the grid when it fails, and ends with the notice', async () => {
    /* The first page is the endpoint's steady state: the StrictMode double
       mount reads it twice, so it is installed as the base implementation.
       Only the two calls that genuinely differ are queued — the failing
       `Load more`, then the successful retry. */
    mocks.getPublicReportsPage
      .mockResolvedValueOnce(page([series('page-one', 'Page one', [])], 'cursor-2'))
      .mockResolvedValueOnce(page([series('page-one', 'Page one', [])], 'cursor-2'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(page([series('page-two', 'Page two', [])], null))
    render()
    await waitForDom(domFinishedLoading)
    // More pages exist, so the true total is unknown — no count renders.
    expect(document.querySelector('[data-testid="report-directory-count"]')).toBeNull()
    expect(document.body.textContent).not.toContain('All 1 digest loaded')

    act(() => findButtonByName('Load more').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.getPublicReportsPage.mock.calls[2]?.[0]).toEqual({ cursor: 'cursor-2' })
    expect(document.body.textContent).toContain('Page one')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load more digests.")

    act(() => findButtonByName('Try again').click())
    await waitForDom(() => document.body.textContent?.includes('Page two') === true)
    expect(document.body.textContent).toContain('Page two')
    expect(document.querySelector('[data-testid="report-directory-count"]')?.textContent).toBe('2 digests')
    expect(document.body.textContent).toContain('All 2 digests loaded')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
