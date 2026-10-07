// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportSeries, ReportSeriesPage } from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { MyDigests } from './MyDigests'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false },
  listMyReports: vi.fn(),
  createReport: vi.fn(),
  newCommandId: vi.fn(() => 'cmd-fixed'),
  mutationIntentKey: vi.fn((scope: string, id: string) => `${scope}:${id}`),
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      listMyReports: mocks.listMyReports,
      createReport: mocks.createReport,
      newCommandId: mocks.newCommandId,
      mutationIntentKey: mocks.mutationIntentKey,
    },
  }
})

function series(id: string, overrides: Partial<ReportSeries> = {}): ReportSeries {
  return {
    id,
    ownerSubjectId: 'sub-1',
    title: `Digest ${id}`,
    summary: `Summary for ${id}`,
    slug: `digest-${id}`,
    visibility: 'private',
    allowSearchIndexing: false,
    state: 'active',
    resourceRevision: 'r1',
    contentRevision: 'c1',
    policyRevision: 'p1',
    ...overrides,
  }
}

function page(items: ReportSeries[], nextCursor: string | null = null): ReportSeriesPage {
  return { items, nextCursor }
}

function setSelect(id: string, value: string) {
  const select = document.getElementById(id) as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function fieldHint(id: string): string {
  const field = document.getElementById(id)?.closest('.field')
  const hint = [...(field?.querySelectorAll('span') ?? [])].find((span) => span.classList.contains('field-hint'))
  return hint?.textContent ?? ''
}

describe('MyDigests', () => {
  beforeEach(() => {
    clearRouteCache()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.listMyReports.mockReset()
    mocks.createReport.mockReset()
    window.__KNOWN_FLAGS__ = { reports: true }
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = ''
  })

  function render(route = '/library/digests') {
    mountTree(<MyDigests />, { route })
  }

  it('lists owned series as manage links with visibility badges', async () => {
    mocks.listMyReports.mockResolvedValue(page([
      series('rep-1', { title: 'AI weekly', slug: 'ai-weekly', visibility: 'public' }),
      series('rep-2', { title: 'Quiet notes', slug: null, visibility: 'private' }),
    ]))
    render()
    await waitForDom(domFinishedLoading)

    const cards = [...document.querySelectorAll('[data-testid="my-digest-card"]')]
    expect(cards).toHaveLength(2)
    expect(cards[0]!.classList.contains('result-card--digest')).toBe(true)
    expect(cards[0]!.getAttribute('href')).toBe('/library/digests/rep-1')
    expect(cards[0]!.textContent).toContain('AI weekly')
    expect(cards[0]!.textContent).toContain('Public')
    expect(cards[0]!.textContent).toContain('Published at know-n.com/reports/ai-weekly')
    expect(cards[1]!.getAttribute('href')).toBe('/library/digests/rep-2')
    expect(cards[1]!.textContent).toContain('Private')
    expect(cards[1]!.textContent).not.toContain('/reports/')
  })

  it('creates a digest from the New digest dialog', async () => {
    mocks.listMyReports.mockResolvedValue(page([]))
    mocks.createReport.mockResolvedValue(series('rep-new', { title: 'New one' }))
    render()
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('No digests yet')
    act(() => { findButtonByName('New digest').click() })
    await waitForDom(() => document.querySelector('[data-testid="new-digest-form"]') !== null)

    const titleInput = document.getElementById('nd-title') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(titleInput, 'New one')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      (document.querySelector('[data-testid="new-digest-form"]') as HTMLFormElement)
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => mocks.createReport.mock.calls.length === 1)
    expect(mocks.createReport).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New one', visibility: 'private', allowSearchIndexing: false }),
      expect.objectContaining({ intentId: 'create-report:cmd-fixed' }),
    )
    await waitForDom(() => document.querySelector('[data-testid="new-digest-form"]') === null)
  })

  it('replaces the create-form hint with the selected visibility', async () => {
    mocks.listMyReports.mockResolvedValue(page([]))
    render()
    await waitForDom(domFinishedLoading)
    act(() => { findButtonByName('New digest').click() })
    await waitForDom(() => document.getElementById('nd-visibility') !== null)

    const form = document.querySelector('[data-testid="new-digest-form"]')!
    const hints = () => [...form.querySelectorAll('span')].filter((span) => span.classList.contains('field-hint'))
    expect(hints()).toHaveLength(2)
    expect(fieldHint('nd-visibility')).toBe('Only you and collaborators can open it.')
    expect(form.textContent).not.toContain('can be indexed')
    expect(form.textContent).not.toContain('You can change this later')

    setSelect('nd-visibility', 'protected')
    expect(hints()).toHaveLength(2)
    expect(fieldHint('nd-visibility')).toBe('Only you and collaborators can open it for now.')

    setSelect('nd-visibility', 'unlisted')
    expect(fieldHint('nd-visibility')).toBe("Anyone with the link can open it. It isn't listed in the directory.")

    setSelect('nd-visibility', 'public')
    expect(hints()).toHaveLength(2)
    expect(fieldHint('nd-visibility')).toBe('Listed in the digest directory. Anyone can open and follow it.')
  })

  it('opens the create dialog directly for ?new=1', async () => {
    mocks.listMyReports.mockResolvedValue(page([series('rep-1')]))
    render('/library/digests?new=1')
    await waitForDom(() => document.querySelector('[data-testid="new-digest-form"]') !== null)
    expect(document.getElementById('nd-title')).not.toBeNull()
  })

  it('shows the unavailable state when the reports flag is off', async () => {
    window.__KNOWN_FLAGS__ = { reports: false }
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Digests are not available yet')
    expect(mocks.listMyReports).not.toHaveBeenCalled()
  })

  it('asks visitors to sign in', async () => {
    mocks.auth.isLoggedIn = false
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Sign in to curate digests')
    const signIn = document.querySelector<HTMLAnchorElement>('a[href^="/login"]')
    expect(signIn?.textContent).toBe('Sign in')
    expect(signIn?.getAttribute('href')).toBe(`/login?returnTo=${encodeURIComponent('/library/digests')}`)
    // No disabled New digest button for someone who can't create one.
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'New digest')).toBe(false)
    expect(mocks.listMyReports).not.toHaveBeenCalled()
  })

  it('says it could not load the digests and offers Try again', async () => {
    mocks.listMyReports.mockRejectedValue(new Error('network'))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your digests")
    mocks.listMyReports.mockResolvedValue(page([series('rep-1', { title: 'AI weekly' })]))
    act(() => { document.querySelector('[role="alert"]')!.querySelector('button')!.click() })
    await waitForDom(() => document.querySelector('[data-testid="my-digest-card"]') !== null)
    expect(document.body.textContent).toContain('AI weekly')
  })
})
