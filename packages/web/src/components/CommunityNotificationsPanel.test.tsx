// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommunityNotification,
  CommunityNotificationInbox,
  CommunityTarget,
} from '@known/product-v1-client'
import { ProductApiError } from '../api/errors'
import { clearRouteCache } from '../lib/routeCache'
import { CommunityNotificationsPanel, type CommunityNotificationFilter } from './CommunityNotificationsPanel'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getCommunityNotificationsPage: vi.fn(),
  getCommunityNotificationPreference: vi.fn(),
  markCommunityNotificationsRead: vi.fn(),
  updateCommunityNotificationPreference: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const COLLECTION = 'cccccccccccccccccccccA'
const TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: 'static-v1',
}

function notification(id: string, overrides: Partial<CommunityNotification> = {}): CommunityNotification {
  return {
    id,
    kind: 'comment_reply',
    commentId: `comment-${id}`,
    target: TARGET,
    actor: {
      id: `actor-${id}`,
      handle: `replier-${id}`,
      displayName: `Replier ${id}`,
      avatarUrl: null,
    },
    preview: `Preview of reply ${id}`,
    href: `/community/comments/comment-${id}`,
    read: false,
    createdAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  }
}

function inbox(
  items: readonly CommunityNotification[],
  nextCursor: string | null = null,
  unreadCount = items.filter((item) => !item.read).length,
): CommunityNotificationInbox {
  return { items: [...items], nextCursor, unreadCount }
}

describe('CommunityNotificationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox([notification('n1'), notification('n2', { read: true })], null, 1))
    mocks.markCommunityNotificationsRead.mockResolvedValue({ changedIds: ['n1'], unreadCount: 0 })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function render(
    options: {
      enabled?: boolean
      filter?: CommunityNotificationFilter
      onFilterChange?: (value: CommunityNotificationFilter) => void
    } = {},
  ) {
    const filter = options.filter ?? 'All'
    mountTree(
      <MemoryRouter initialEntries={['/notifications?tab=community']}>
        <CommunityNotificationsPanel
          enabled={options.enabled ?? true}
          filter={filter}
          onFilterChange={options.onFilterChange ?? (() => {})}
        />
      </MemoryRouter>,
    )
  }

  function items(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-community-notification-item]')]
  }

  function filterButton(label: string | RegExp): HTMLButtonElement {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Community notification filters"] [role="radio"]')]
    const match = buttons.find((button) => typeof label === 'string'
      ? button.textContent?.trim() === label
      : label.test(button.textContent ?? ''))
    if (!match) throw new Error(`filter option not found: ${String(label)}`)
    return match
  }

  it('renders the reply inbox with actor, preview, target link, and read state', async () => {
    render()
    await waitForDom(() => items().length === 2)

    /* The generated client turns this into GET
       /api/v1/me/community-notifications?read=all&limit=20. Reply delivery
       is owned by Settings, so this paint does not read the preference. */
    expect(mocks.getCommunityNotificationsPage).toHaveBeenCalledWith(
      { read: 'all', limit: 20 },
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(mocks.getCommunityNotificationPreference).not.toHaveBeenCalled()

    const [first, second] = items()
    expect(first?.className).toContain('is-unread')
    expect(second?.className).not.toContain('is-unread')
    // Subject composes actor display name + reply preview under a "replied" label.
    expect(first?.getAttribute('aria-label')).toBe('Unread notification: Replier n1 replied: Preview of reply n1')
    expect(first?.textContent).toContain('Replier n1 replied: Preview of reply n1')
    // The row links to the authority href; the kind chip and read marker paint.
    const link = first?.querySelector('a[href^="/community/comments/"]')
    expect(link?.getAttribute('href')).toBe('/community/comments/comment-n1')
    expect(first?.textContent).toContain('Comment reply')
    // Unread rows say what is new; read rows drop the state line (R12-09).
    expect(first?.querySelector('p')?.textContent).toBe('New reply')
    expect(second?.querySelector('p')).toBeNull()
    const stamp = first?.querySelector('time')
    expect(stamp?.getAttribute('dateTime')).toBe('2026-01-02T03:04:05.000Z')
    // Unread rows carry a per-row Mark read action; read rows do not.
    expect(first?.querySelector('[data-notification-read]')).not.toBeNull()
    expect(second?.querySelector('[data-notification-read]')).toBeNull()
  })

  it('marks one notification read through the receipted command and refreshes authority', async () => {
    /* First paint serves the unread row; the receipt commits, then the
       authority refresh re-reads and must keep the transitioned state — the
       optimistic paint alone is never the final word. The read models the
       inbox's authority state, so it is a base implementation: StrictMode
       double-invokes the panel's mount read and both reads are the first
       paint. */
    let receiptCommitted = false
    mocks.getCommunityNotificationsPage.mockImplementation(async () => (receiptCommitted
      ? inbox([notification('n1', { read: true }), notification('n2', { read: true })], null, 0)
      : inbox([notification('n1'), notification('n2', { read: true })], null, 1)))
    render()
    await waitForDom(() => items().length === 2)
    const baselineReads = mocks.getCommunityNotificationsPage.mock.calls.length

    const markRead = items()[0]?.querySelector<HTMLButtonElement>('[data-notification-read]')
    expect(markRead).not.toBeNull()
    receiptCommitted = true
    await act(async () => { markRead?.click() })
    await waitForDom(() => mocks.getCommunityNotificationsPage.mock.calls.length >= baselineReads + 1)

    // Bulk-read receipt: ids payload plus the intent id, never a fabricated
    // body. One click is one receipted command — no duplicated write.
    expect(mocks.markCommunityNotificationsRead).toHaveBeenCalledTimes(1)
    const [payload, options] = mocks.markCommunityNotificationsRead.mock.calls[0]!
    expect(payload).toEqual({ ids: ['n1'] })
    expect(options).toEqual(expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }))

    // Optimistic paint + authority refresh settle on the read row.
    await waitForDom(() => items()[0]?.className.includes('is-unread') === false && items()[0]?.querySelector('p') === null)
  })

  it('marks all visible unread rows through the bulk command', async () => {
    /* The first paint carries the unread rows; once the bulk receipt
       commits, the authority reports every visible row read. Both mount
       reads (StrictMode double-invokes the panel's mount effect) are the
       pre-commit paint. */
    let receiptCommitted = false
    mocks.getCommunityNotificationsPage.mockImplementation(async () => (receiptCommitted
      ? inbox([
        notification('n1', { read: true }), notification('n2', { read: true }), notification('n3', { read: true }),
      ], null, 0)
      : inbox([
        notification('n1'), notification('n2'), notification('n3', { read: true }),
      ], null, 2)))
    render()
    await waitForDom(() => items().length === 3)

    const markAll = findButtonByName('Mark visible read')
    expect(markAll.disabled).toBe(false)
    receiptCommitted = true
    await act(async () => { markAll.click() })
    await waitForDom(() => mocks.markCommunityNotificationsRead.mock.calls.length === 1)

    // Only the unread visible ids are sent — the read row stays out of the payload.
    const [payload] = mocks.markCommunityNotificationsRead.mock.calls[0]!
    expect(payload).toEqual({ ids: ['n1', 'n2'] })

    // Once the authority refresh confirms every visible row read, the bulk
    // action disables itself.
    await waitForDom(() => findButtonByName('Mark visible read').disabled)
  })

  it('shows the authority unread count on the Unread chip and refetches on filter change', async () => {
    const onFilterChange = vi.fn()
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox([notification('n1')], null, 7))
    render({ onFilterChange })
    await waitForDom(() => items().length === 1)

    // unreadCount is the whole-inbox authority count, not the page size.
    const unreadChip = filterButton(/Unread · 7/)
    expect(unreadChip.getAttribute('aria-checked')).toBe('false')
    expect(filterButton('All').getAttribute('aria-checked')).toBe('true')

    await act(async () => { unreadChip.click() })
    expect(onFilterChange).toHaveBeenCalledWith('Unread')

    // The host applies the filter; the panel re-reads with read=unread.
    render({ filter: 'Unread', onFilterChange })
    await waitForDom(() => mocks.getCommunityNotificationsPage.mock.calls.some(
      ([query]) => (query as { read?: string }).read === 'unread',
    ))
    expect(mocks.getCommunityNotificationsPage).toHaveBeenLastCalledWith(
      { read: 'unread', limit: 20 },
      expect.objectContaining({ maxRetries: 0 }),
    )
  })

  it('pages the inbox with the authority cursor and keeps order', async () => {
    /* Page one is the endpoint's steady state: StrictMode double-invokes the
       panel's mount read, so both mount reads must serve the first page with
       its cursor. The continuation is the genuinely different next read. */
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox([notification('n1'), notification('n2')], 'cursor-2', 2))
    render()
    await waitForDom(() => items().length === 2)

    const loadMore = findButtonByName('Load more')
    mocks.getCommunityNotificationsPage.mockResolvedValueOnce(inbox([notification('n3')], null, 2))
    await act(async () => { loadMore.click() })
    await waitForDom(() => items().length === 3)

    // Exactly one paged read went out, and a cursor query must not re-send
    // read/limit.
    const cursorCalls = mocks.getCommunityNotificationsPage.mock.calls
      .filter(([query]) => 'cursor' in (query as Record<string, unknown>))
    expect(cursorCalls).toHaveLength(1)
    expect(cursorCalls[0]?.[0]).toEqual({ cursor: 'cursor-2' })
    expect(cursorCalls[0]?.[1]).toEqual(expect.objectContaining({ maxRetries: 0 }))
    expect(items().map((item) => item.getAttribute('aria-label'))).toEqual([
      'Unread notification: Replier n1 replied: Preview of reply n1',
      'Unread notification: Replier n2 replied: Preview of reply n2',
      'Unread notification: Replier n3 replied: Preview of reply n3',
    ])
    // No further cursor: the Load more affordance is gone.
    expect([...document.querySelectorAll('button')]
      .some((button) => /Load more|Loading/.test(button.textContent ?? ''))).toBe(false)
  })

  it('keeps redacted rows in place when the reply preview is no longer servable', async () => {
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox([
      notification('n1'),
      notification('n2', { preview: null, actor: { id: 'actor-n2', handle: null, displayName: 'Former member', avatarUrl: null } }),
    ], null, 2))
    render()
    await waitForDom(() => items().length === 2)

    const redacted = items()[1]
    // preview null keeps the row position with the redacted-preview copy.
    expect(redacted?.textContent).toContain('Former member replied: Reply no longer visible')
    expect(redacted?.getAttribute('aria-label')).toBe('Unread notification: Former member replied: Reply no longer visible')
    // The row still carries its read affordance and authority link.
    expect(redacted?.querySelector('[data-notification-read]')).not.toBeNull()
    expect(redacted?.querySelector('a[href="/community/comments/comment-n2"]')).not.toBeNull()
  })

  it('renders the empty state when the inbox has no rows in this filter', async () => {
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox([], null, 0))
    render()
    await waitForDom(() => document.body.textContent?.includes('Nothing here') === true)
    expect(document.body.textContent).toContain('No reply notifications in this filter.')
    expect(items().length).toBe(0)
    // The bulk action has nothing to do.
    expect(findButtonByName('Mark visible read').disabled).toBe(true)
  })

  it('shows the loading state then surfaces a load error with retry', async () => {
    let resolvePage: ((value: CommunityNotificationInbox) => void) | null = null
    let rejectPage: ((reason: unknown) => void) | null = null
    mocks.getCommunityNotificationsPage.mockImplementation(
      () => new Promise<CommunityNotificationInbox>((resolve, reject) => { resolvePage = resolve; rejectPage = reject }),
    )
    render()
    await waitForDom(() => document.body.textContent?.includes('Loading community notifications…') === true)
    expect(items().length).toBe(0)

    await act(async () => {
      rejectPage?.(new ProductApiError({ status: 500, code: 'internal_error', message: 'Inbox backend exploded' }))
    })
    await waitForDom(() => document.body.textContent?.includes("Couldn't load notifications") === true)
    expect(document.body.textContent).toContain('Check your connection and try again.')
    expect(items().length).toBe(0)

    // Retry re-runs the failed read operation; the recovered page paints.
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox([notification('n1')], null, 1))
    await act(async () => { findButtonByName('Try again').click() })
    await waitForDom(() => items().length === 1)
    expect(document.body.textContent).not.toContain("Couldn't load notifications")
    expect(resolvePage).not.toBeNull()
  })

  it('shows the sign-in CTA instead of retry on a 401', async () => {
    mocks.getCommunityNotificationsPage.mockRejectedValue(
      new ProductApiError({ status: 401, code: 'authentication_required', message: 'Sign in required' }),
    )
    render()
    await waitForDom(() => document.body.textContent?.includes('Sign in to continue') === true)
    expect(document.body.textContent).toContain('Community reply notifications require a signed-in session.')
    const login = document.querySelector<HTMLAnchorElement>('a[href^="/login?returnTo="]')
    expect(login).not.toBeNull()
    expect(login?.textContent).toBe('Sign in')
    // A signed-out viewer gets no retry affordance.
    expect(document.querySelector('[role="alert"] button')).toBeNull()
  })

  it('renders nothing and stays inert when the community surface is disabled', async () => {
    render({ enabled: false })
    await act(async () => { await Promise.resolve() })
    // flag-off: zero requests AND zero chrome — no rail, no buttons, no
    // preference toggle, no empty state.
    expect(mocks.getCommunityNotificationsPage).not.toHaveBeenCalled()
    expect(mocks.getCommunityNotificationPreference).not.toHaveBeenCalled()
    expect(items().length).toBe(0)
    expect(document.body.textContent).not.toContain('Nothing here')
    expect(document.querySelector('[aria-label="Community notification filters"]')).toBeNull()
    expect(document.querySelector('[data-testid="community-preference"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Mark visible read')
    expect(document.body.textContent).not.toContain('Refresh')
  })

  it('does not host the community preference switch and sends readers to Settings', async () => {
    render()
    await waitForDom(() => items().length === 2)
    expect(document.querySelector('[role="switch"]')).toBeNull()
    expect(document.querySelector('[data-testid="community-preference"]')).toBeNull()
    const settings = document.querySelector<HTMLAnchorElement>('a[href="/library?settings=notifications"]')
    expect(settings?.textContent).toContain('Settings')
    expect(mocks.getCommunityNotificationPreference).not.toHaveBeenCalled()
    expect(mocks.updateCommunityNotificationPreference).not.toHaveBeenCalled()
  })

  it('surfaces a failed mutation and retries the same intent', async () => {
    mocks.markCommunityNotificationsRead
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }))
      .mockResolvedValue({ changedIds: ['n1'], unreadCount: 0 })
    render()
    await waitForDom(() => items().length === 2)

    const markRead = items()[0]?.querySelector<HTMLButtonElement>('[data-notification-read]')
    await act(async () => { markRead?.click() })
    await waitForDom(() => document.body.textContent?.includes("Couldn't save your change") === true)
    expect(mocks.markCommunityNotificationsRead).toHaveBeenCalledTimes(1)

    await act(async () => { findButtonByName('Try again').click() })
    await waitForDom(() => mocks.markCommunityNotificationsRead.mock.calls.length === 2)
    // Exact retry: the stored intent id is reused for the receipted command.
    expect(mocks.markCommunityNotificationsRead.mock.calls[1]?.[1]?.intentId)
      .toBe(mocks.markCommunityNotificationsRead.mock.calls[0]?.[1]?.intentId)
    await waitForDom(() => document.body.textContent?.includes("Couldn't save your change") !== true)
  })
})
