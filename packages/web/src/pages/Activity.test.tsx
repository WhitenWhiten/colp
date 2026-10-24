// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { TopNav } from '../components/TopNav'
import { publishActivitySummary, resetActivityStatus } from '../lib/activityStatus'
import { cleanup, findButtonByName, renderWithRouter, settled, waitForDom } from '../test/render'
import { Activity } from './Activity'
import { activityItem, fakeActivityApi } from './activity/activity.test-helper'
import { useActivityInbox } from './activity/useActivityInbox'

const toast = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn() }))
const auth = vi.hoisted(() => ({ isLoggedIn: true, bootstrapping: false,
  user: { accountId: 'owner', name: 'Owner', initials: 'O' }, sessionState: 'ready', logout: vi.fn() }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../components/AppToast', () => ({ useToast: () => toast }))
vi.mock('../components/SearchPalette', () => ({ SearchPalette: () => null }))

const entries = () => [...document.querySelectorAll('[data-activity-id]')].map((entry) => entry.getAttribute('data-activity-id'))
const click = (name: string) => act(() => findButtonByName(name).click())

describe('Activity inbox', () => {
  beforeEach(() => { vi.clearAllMocks(); resetActivityStatus(); auth.isLoggedIn = true })
  afterEach(() => { cleanup(); resetActivityStatus() })

  it('renders agent additions and every run outcome with links, dates, samples and New markers', async () => {
    const api = fakeActivityApi()
    const run = { id: 'run-1', ruleId: 'rule-1', ruleName: 'Weekly papers', status: 'completed', outputCount: 1, attention: null }
    api.listActivity.mockResolvedValue({ items: [
      activityItem('added', { folders: [{ nodeId: 'llm-papers', title: 'LLM Papers', count: 6 }, { nodeId: 'reading', title: 'Reading', count: 1 }] }),
      ...(['run_completed', 'run_partial', 'run_failed', 'run_attention'] as const).map((kind) => activityItem(kind, { kind, run, count: 1, items: [], folders: [] })),
    ], nextCursor: null, unreadCount: 5 })
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await waitForDom(() => entries().length === 5)
    expect(document.body.textContent).toContain('Claude added 7 bookmarks to LLM Papers and 1 more folder')
    for (const text of ['Weekly papers finished', 'Weekly papers partly finished', 'Weekly papers failed', 'Weekly papers needs your decision', '1 new digest', 'Attention Is All You Need', 'arxiv.org']) {
      expect(document.body.textContent).toContain(text)
    }
    expect(document.querySelector('a[href="/library/personal?folder=llm-papers"]')).not.toBeNull()
    expect(document.querySelector('a[href="/automations/runs/run-1"]')).not.toBeNull()
    expect(document.querySelectorAll('time[title]').length).toBe(5)
    expect(document.querySelectorAll('[data-unread="true"]').length).toBe(5)
    // Days are headings, not one landmark each.
    expect(document.querySelector('section > h2')).not.toBeNull()
    expect(document.querySelector('section[aria-label]')).toBeNull()
  })

  it('marks through the newest item after render exactly once, including after loading more', async () => {
    const api = fakeActivityApi()
    api.listActivity.mockImplementation(async (query) => query?.cursor
      ? { items: [activityItem('older')], nextCursor: null, unreadCount: 0 }
      : { items: [activityItem('newest')], nextCursor: 'page-2', unreadCount: 7 })
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await waitForDom(() => api.markActivityRead.mock.calls.length === 1)
    expect(entries()).toEqual(['newest'])
    expect(api.markActivityRead).toHaveBeenCalledWith({ through: 'newest', throughRevision: '1' })
    click('Load more')
    await waitForDom(() => entries().length === 2)
    expect(api.listActivity).toHaveBeenCalledWith({ state: 'all', cursor: 'page-2', limit: 20 })
    expect(api.markActivityRead).toHaveBeenCalledTimes(1)
  })

  it('asks for the Unread filter, resets pagination, and does not mark again', async () => {
    const api = fakeActivityApi()
    api.listActivity.mockImplementation(async (query) => ({ items: query?.state === 'unread' ? [] : [activityItem()], nextCursor: null, unreadCount: 1 }))
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await waitForDom(() => entries().length === 1)
    click('Unread')
    await waitForDom(() => document.body.textContent?.includes('You’re all caught up') === true)
    expect(api.listActivity.mock.calls.at(-1)?.[0]).toEqual({ state: 'unread', limit: 20 })
    expect(api.markActivityRead).toHaveBeenCalledTimes(1)
  })

  it('lets Mark all read retry a failed automatic read and reports failure as a toast', async () => {
    const api = fakeActivityApi()
    api.listActivity.mockResolvedValue({ items: [activityItem()], nextCursor: null, unreadCount: 1 })
    api.markActivityRead.mockRejectedValueOnce(new Error('Could not mark activity read.'))
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await waitForDom(() => toast.error.mock.calls.length === 1)
    expect(toast.error).toHaveBeenCalledWith('Could not mark activity read.')
    click('Mark all read')
    await waitForDom(() => api.markActivityRead.mock.calls.length === 2)
    expect(api.markActivityRead.mock.calls[1]).toEqual([{ through: 'activity-1', throughRevision: '1' }])
  })

  it('offers Mark all read only after the automatic read, then reaches activity that arrived later', async () => {
    const api = fakeActivityApi()
    api.listActivity.mockResolvedValue({ items: [activityItem('shown')], nextCursor: null, unreadCount: 2 })
    api.getActivitySummary.mockResolvedValue({ unreadCount: 1, latest: activityItem('arrived', { revision: '3' }), revision: '3' })
    let finishRead: ((result: { readCount: number; unreadCount: number }) => void) | undefined
    api.markActivityRead.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await waitForDom(() => api.markActivityRead.mock.calls.length === 1)
    const markAll = () => [...document.querySelectorAll('button')].find((button) => /Mark/u.test(button.textContent ?? ''))
    expect(markAll()).toBeUndefined()
    // Something arrived between the list and its read: the head offers the rest.
    await act(async () => finishRead?.({ readCount: 1, unreadCount: 1 }))
    await waitForDom(() => markAll()?.textContent === 'Mark all read')
    click('Mark all read')
    await waitForDom(() => api.markActivityRead.mock.calls.length === 2)
    expect(api.markActivityRead.mock.calls[0]).toEqual([{ through: 'shown', throughRevision: '1' }])
    expect(api.markActivityRead.mock.calls[1]).toEqual([{ through: 'arrived', throughRevision: '3' }])
    await waitForDom(() => markAll() === undefined)
  })

  it('uses readable fallbacks and treats bookmark titles as text', async () => {
    const api = fakeActivityApi()
    api.listActivity.mockResolvedValue({ items: [activityItem('anonymous', { agent: null, count: 1, items: [{ nodeId: 'x', title: '<img src=x>', host: null, occurredAt: '2026-10-23T09:00:00Z' }] })], nextCursor: null, unreadCount: 0 })
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await waitForDom(() => entries().length === 1)
    expect(document.body.textContent).toContain('An agent added 1 bookmark to LLM Papers')
    expect(document.body.textContent).toContain('<img src=x>')
    expect(document.querySelector('ul[aria-label="Recent bookmarks"] img')).toBeNull()
    expect(api.markActivityRead).not.toHaveBeenCalled()
  })

  it('hides a previously available bell when the list returns feature-off 404', async () => {
    const api = fakeActivityApi()
    let fail: ((reason: unknown) => void) | undefined
    api.listActivity.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    renderWithRouter(<><TopNav /><Activity api={api} /></>, { route: '/activity' })
    act(() => publishActivitySummary({ unreadCount: 7, revision: '1', latest: null }))
    expect(document.querySelector('[aria-label="Activity, 7 unread"]')).not.toBeNull()
    await act(async () => fail?.(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found' })))
    await waitForDom(() => document.querySelector('[aria-label^="Activity,"]') === null)
    expect(document.body.textContent).toContain('This feature is not available yet')
  })

  it('does not fetch private activity for a signed-out visitor', async () => {
    auth.isLoggedIn = false
    const api = fakeActivityApi()
    renderWithRouter(<Activity api={api} />, { route: '/activity' })
    await settled()
    expect(document.body.textContent).toContain('Sign in to see your activity')
    expect(api.listActivity).not.toHaveBeenCalled()
  })

  it('does not carry a pending read indicator into another account', async () => {
    const api = fakeActivityApi()
    api.listActivity.mockResolvedValueOnce({ items: [activityItem()], nextCursor: null, unreadCount: 1 })
    let finishRead: ((result: { readCount: number; unreadCount: number }) => void) | undefined
    api.markActivityRead.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
    function Probe({ account }: { account: string }) {
      const { marking } = useActivityInbox(api, account)
      return <output>{marking ? 'Marking read' : 'Ready'}</output>
    }
    const view = renderWithRouter(<Probe account="owner" />, { route: '/activity', strict: false })
    await waitForDom(() => document.querySelector('output')?.textContent === 'Marking read')
    view.rerender(<Probe account="other-owner" />)
    expect(document.querySelector('output')?.textContent).toBe('Ready')
    await act(async () => finishRead?.({ readCount: 1, unreadCount: 0 }))
    expect(document.querySelector('output')?.textContent).toBe('Ready')
  })
})
