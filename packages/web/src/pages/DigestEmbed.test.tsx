// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ReportSeries } from './ReportSeries'
import { ReportIssue } from './ReportIssue'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionSnapshot, PublicReportIssue, PublicReportSeries } from '../api/types'

const mocks = vi.hoisted(() => ({ series: vi.fn(), issue: vi.fn(), snapshot: vi.fn() }))
vi.mock('../api', async original => {
  const api = await original<typeof import('../api')>()
  return { ...api, productClient: { ...api.productClient, getPublicReportSeries: mocks.series, getPublicReportIssue: mocks.issue, loadPublicCollectionSnapshot: mocks.snapshot } }
})
const issue: PublicReportIssue = { id: 'ed-2', title: 'Second issue', summary: 'Edition summary', publishedAt: '2026-09-01T00:00:00Z', url: '/reports/weekly/issues/ed-2', sourceCollectionSlug: 'edition-source' }
const series: PublicReportSeries = { id: 'series-1', slug: 'weekly', title: 'Weekly digest', summary: 'Digest summary', visibility: 'public', indexable: true, updatedAt: '2026-09-01T00:00:00Z', issues: [{ ...issue, id: 'hidden', title: 'Hidden title', state: 'hidden', sourceCollectionSlug: null }, issue] }
const snapshot: PublicCollectionSnapshot = {
  collection: { id: 'col-1', slug: 'edition-source', title: 'Source', summary: null, kind: 'bookmarks', rootNodeId: 'root', updatedAt: '2026-09-01T00:00:00Z', access: 'public' },
  nodes: [{ id: 'root', parentId: null, kind: 'root', title: 'Root', description: null, url: null, position: null }, ...Array.from({ length: 6 }, (_, i) => ({ id: `node-${i}`, parentId: 'root', kind: 'bookmark' as const, title: `Link ${i}`, description: null, url: `https://example.com/${i}`, position: String(i) }))],
  page: { cursor: null, hasMore: false, sequence: 1 },
}
function render(editionId?: string, query = '') {
  mountTree(<MemoryRouter initialEntries={[`/reports/weekly${editionId ? `/issues/${editionId}` : ''}?embed=1${query}`]}><Routes><Route path="/reports/:slug" element={<ReportSeries />} /><Route path="/reports/:slug/issues/:editionId" element={<ReportIssue />} /></Routes></MemoryRouter>)
}
async function ready() { await waitForDom(() => document.querySelector('article h1') !== null) }

describe('Digest embedded cards', () => {
  beforeEach(() => {
    clearRouteCache(); vi.clearAllMocks()
    window.__KNOWN_FLAGS__ = { reports: true }
    document.body.innerHTML = '<div id="root"></div>'
    mocks.series.mockResolvedValue(series); mocks.issue.mockResolvedValue(issue); mocks.snapshot.mockResolvedValue(snapshot)
  })
  afterEach(() => { cleanup(); delete window.__KNOWN_FLAGS__ })

  it('uses the newest readable issue and the shared collection card markup', async () => {
    render(); await ready()
    expect(document.querySelector('h1')?.textContent).toBe('Weekly digest')
    expect(document.body.textContent).toContain('Latest · Second issue')
    expect(document.body.textContent).not.toContain('Hidden title')
    expect(mocks.snapshot.mock.calls.every(call => call[0] === 'edition-source')).toBe(true)
    expect(document.querySelectorAll('[data-testid="share-embed-row"]')).toHaveLength(6)
    expect(document.querySelector('[data-testid="share-embed-more"]')?.getAttribute('href')).toBe('https://know-n.com/reports/weekly/issues/ed-2')
    expect(document.querySelector('footer a:last-child')?.getAttribute('href')).toBe('https://know-n.com/reports/weekly')
  })
  it('pins an issue, honors compact and appearance, and preserves attribution', async () => {
    render('ed-2', '&compact&theme=dark&bg=%23ffffff&text=%23ffffff&font=mono'); await ready()
    expect(document.querySelector('h1')?.textContent).toBe('Second issue')
    expect(document.querySelectorAll('[data-testid="share-embed-row"]')).toHaveLength(6)
    expect(document.body.textContent).not.toContain('Edition summary')
    const page = document.querySelector<HTMLElement>('[data-testid="share-embed-page"]')!
    expect(page.style.getPropertyValue('--embed-brand-ink')).toBe('#000000')
    expect(page.className).toContain('--dark')
    expect(document.querySelector('footer a img')?.getAttribute('alt')).toBe('Know-N')
    expect(document.querySelector('footer a img')?.getAttribute('src')).toBe('/brand-wordmark.svg')
    expect(document.querySelector('footer a:last-child')?.getAttribute('href')).toBe('https://know-n.com/reports/weekly/issues/ed-2')
  })
  it('does not fetch when digest exposure is off', () => {
    window.__KNOWN_FLAGS__ = { reports: false }; render()
    expect(document.body.textContent).toContain('not available')
    expect(mocks.series).not.toHaveBeenCalled(); expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled()
  })
  it('does not fetch contents for a hidden issue', async () => {
    mocks.issue.mockResolvedValue({ ...issue, state: 'hidden' }); render('ed-2')
    await waitForDom(() => document.body.textContent?.includes('not available') === true)
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })
  it('renders an empty series without falling back to the series source collection', async () => {
    mocks.series.mockResolvedValue({ ...series, issues: [], sourceCollectionSlug: 'must-not-load' }); render(); await ready()
    expect(document.body.textContent).toContain('No published issues yet')
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })
  it('keeps withdrawn source contents unavailable', async () => {
    mocks.snapshot.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Gone' })); render('ed-2')
    await waitForDom(() => document.body.textContent?.includes('contents are not available') === true)
    expect(document.querySelector('[data-testid="share-embed-row"]')).toBeNull()
  })
  it('offers retry for a failed series load', async () => {
    mocks.series.mockRejectedValue(new Error('offline')); render()
    await waitForDom(() => document.querySelector('[role="alert"]') !== null)
    mocks.series.mockResolvedValue(series)
    await act(async () => { document.querySelector<HTMLButtonElement>('button')!.click() })
    await ready()
  })
})
