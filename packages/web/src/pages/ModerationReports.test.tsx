// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { ModerationReports } from './ModerationReports'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  listMyModerationReports: vi.fn(),
  isLoggedIn: true,
  isLive: true,
}))

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  isLive: () => mocks.isLive,
  productClient: {
    listMyModerationReports: (...args: unknown[]) => mocks.listMyModerationReports(...args),
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mocks.isLoggedIn }),
}))

describe('content-governance my reports page', () => {
  /* One page of reporter cases: the shape the endpoint answers with, used as
     the base implementation so the fixture describes the endpoint rather than
     a single mount's worth of queued calls. */
  function casesPage() {
    return {
      items: [{
        id: 'case_1',
        target: { kind: 'collection', id: 'col_1' },
        category: 'spam',
        status: 'submitted',
        publicResolution: null,
        revision: '1',
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z',
      }],
      nextCursor: null,
    }
  }

  beforeEach(() => {
    mocks.listMyModerationReports.mockReset()
    mocks.isLoggedIn = true
    mocks.isLive = true
    mocks.listMyModerationReports.mockResolvedValue(casesPage())
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lists reporter cases and public outcomes', async () => {
    mountTree(
      <MemoryRouter>
        <ModerationReports />
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="moderation-report-list"]') !== null)
    const [subject, reason] = document.querySelectorAll('[data-testid="moderation-report-list"] [role="cell"]')
    expect(subject?.querySelector('strong')?.textContent).toBe('Collection')
    expect(subject?.querySelector('span')?.textContent).toContain('col_1')
    expect(reason?.textContent).toBe('Spam')
    expect(document.body.textContent).not.toContain('spam')
    const status = document.querySelector('[data-testid="moderation-report-list"] .badge')
    expect(status?.textContent).toBe('Submitted')
    const link = document.querySelector('[data-testid="moderation-report-list"] a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/library/col_1')
  })

  it('sends signed-out visitors to login with returnTo', () => {
    mocks.isLoggedIn = false
    mountTree(
      <MemoryRouter>
        <ModerationReports />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Sign in to continue')
    expect(document.querySelector('a[href="/login?returnTo=%2Fmoderation%2Freports"]')?.textContent).toBe('Sign in')
    expect(mocks.listMyModerationReports).not.toHaveBeenCalled()
  })

  it('retries a failed reports load', async () => {
    // The endpoint is down for the initial load. StrictMode invokes the mount
    // effect twice, so "down" has to be the base behaviour — a single queued
    // rejection is consumed by the first invocation and the replay would
    // render the list instead of the error.
    mocks.listMyModerationReports.mockRejectedValue(new ProductApiError({
      status: 500,
      code: 'internal_error',
      message: "Couldn't load reports",
    }))
    mountTree(
      <MemoryRouter>
        <ModerationReports />
      </MemoryRouter>,
    )
    await waitForDom(() => document.body.textContent?.includes("Couldn't load reports") === true)
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')
    expect(retry).toBeTruthy()
    // The endpoint recovers: Retry issues exactly one fresh page request, with
    // no cursor walk and no refetch loop behind it.
    mocks.listMyModerationReports.mockResolvedValue(casesPage())
    const beforeRetry = mocks.listMyModerationReports.mock.calls.length
    expect(beforeRetry).toBeGreaterThan(0)
    await act(async () => { retry?.click() })
    await waitForDom(() => document.querySelector('[data-testid="moderation-report-list"]') !== null)
    expect(mocks.listMyModerationReports.mock.calls.length).toBe(beforeRetry + 1)
    expect(new Set(mocks.listMyModerationReports.mock.calls.map((call) => JSON.stringify(call[0]))).size).toBe(1)
  })
  it('shows the feature as unavailable while the governance flag is off', () => {
    mocks.isLive = false
    mountTree(
      <MemoryRouter>
        <ModerationReports />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Moderation reports are not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(mocks.listMyModerationReports).not.toHaveBeenCalled()
  })

})
