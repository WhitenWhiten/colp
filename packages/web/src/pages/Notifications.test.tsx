// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notifications } from './Notifications'
import { publishUnreadCounts } from '../lib/unreadBadgeStore'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

/* The activity filter is a "Show: <value>" SelectMenu pill. */
function filterSelect() {
  return document.querySelector<HTMLSelectElement>('[data-testid="notification-filter"] select')!
}
function filterOption(name: string | RegExp) {
  return [...filterSelect().options].find((option) => typeof name === 'string' ? option.textContent === name : name.test(option.textContent ?? ''))!
}
function chooseFilter(name: string | RegExp) {
  act(() => {
    filterSelect().value = filterOption(name).value
    filterSelect().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const mocks = vi.hoisted(() => ({ enabled: true, emailEnabled: false, hook: vi.fn() }))
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(),
  isNotificationExposureEnabled: () => mocks.enabled,
  isEmailNotificationsExposureEnabled: () => mocks.emailEnabled }))
vi.mock('../lib/useNotificationCenter', () => ({ useNotificationCenter: (...args: unknown[]) => mocks.hook(...args) }))
/* The Community tab is a separate durable inbox; the page test only needs
   the tab wiring — the panel's own suite covers its flag-off inertness. */
vi.mock('../components/CommunityNotificationsPanel', () => ({
  CommunityNotificationsPanel: (props: { enabled: boolean; filter: string }) => (
    props.enabled ? <div data-testid="community-panel-stub">{props.filter}</div> : null
  ),
}))
const notification = {
  notificationId: 'notification-1', notificationType: 'follow_activity' as const,
  actorProfileId: 'profile-2', actorDisplayName: null, subject: { type: 'profile' as const, id: 'profile-2' },
  state: 'unread' as const, stateRevision: '1', readAt: null,
  occurredAt: '2026-07-29T08:00:00.000Z',
}
const email = { enabled: false, revision: '0', updatedAt: '2026-07-29T00:00:00.000Z', verifiedSender: 'no-reply@example.test', emailSuppressed: false, emailAvailable: true }
const ready = {
  state: 'ready', items: [notification], unreadCount: 12, hasMore: true, preference: { channel: 'in_app', enabled: true, revision: '2', updatedAt: '2026-07-29T00:00:00.000Z', email },
  error: null, mutationError: null, pending: null, refresh: vi.fn(), retry: vi.fn(), loadMore: vi.fn(), markOne: vi.fn(), markVisibleRead: vi.fn(), retryMutation: vi.fn(), setPreference: vi.fn(), resetPreference: vi.fn(), setEmailPreference: vi.fn(), resetEmailPreference: vi.fn(),
}
function LocationSearch() {
  const location = useLocation()
  return <span data-testid="location-search">{location.search}</span>
}

describe('P5-22 Notifications page', () => {
  function render(path = '/notifications') {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Notifications />
          <LocationSearch />
        </MemoryRouter>,
      )
  }
  beforeEach(() => { vi.clearAllMocks(); mocks.enabled = true; mocks.emailEnabled = true; mocks.hook.mockReturnValue({ ...ready }); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => {
    cleanup(); document.body.innerHTML = ''
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
  })

  it('keeps flag-off inert and does not expose demo or paid categories', async () => {
    mocks.enabled = false; render(); await waitForDom(domFinishedLoading)
    expect(mocks.hook).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    expect(document.querySelector('[data-testid="notifications-flag-off"]')).not.toBeNull()
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('This workspace has not enabled')
    expect(document.body.textContent).not.toMatch(/Creator|Billing|revenue|demo notification/iu)
  })

  it('renders loading, empty, success, real error, and retry without mock fallback', async () => {
    mocks.hook.mockReturnValue({ ...ready, state: 'loading', items: [] }); render(); expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading')
    act(() => { mocks.hook.mockReturnValue({ ...ready, state: 'empty', items: [], hasMore: false }); mountTree(<MemoryRouter><Notifications /></MemoryRouter>) }); expect(document.body.textContent).toContain('Nothing here')
    act(() => { mocks.hook.mockReturnValue({ ...ready, state: 'error', items: [], error: { status: 503 } }); mountTree(<MemoryRouter><Notifications /></MemoryRouter>) })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load notifications")
    act(() => findButtonByName('Try again').click()); expect(ready.retry).toHaveBeenCalled()
  })

  it('shows server unread authority, paginates, marks one/bounded visible items, and reports mutation failure', () => {
    render()
    expect(filterOption(/Unread/).textContent).toContain('12')
    expect(document.querySelectorAll('[data-notification-item]')).toHaveLength(1)
    act(() => findButtonByName('Mark visible read').click()); expect(ready.markVisibleRead).toHaveBeenCalled()
    act(() => findButtonByName('Load more').click()); expect(ready.loadMore).toHaveBeenCalled()
    act(() => document.querySelector<HTMLButtonElement>('[data-notification-read]')!.click()); expect(ready.markOne).toHaveBeenCalledWith('notification-1')
    act(() => { mocks.hook.mockReturnValue({ ...ready, mutationError: new Error('offline') }); mountTree(<MemoryRouter><Notifications /></MemoryRouter>) })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save your change")
    act(() => findButtonByName('Try again').click()); expect(ready.retryMutation).toHaveBeenCalled()
  })

  it('keeps the Community tab absent and the panel unreachable while the community surface is disabled', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: false }
    render('/notifications?tab=community')
    await waitForDom(domFinishedLoading)
    // No Community tab, and a forged ?tab=community deep link falls back to
    // the Activity inbox — the panel never mounts.
    expect(document.querySelector('#notifications-tab-community')).toBeNull()
    expect(document.querySelector('[data-testid="community-notifications-panel"]')).toBeNull()
    expect(document.querySelector('[data-testid="community-panel-stub"]')).toBeNull()
    expect(document.querySelector('#notifications-panel-activity')).not.toBeNull()
  })

  it('exposes the Community tab and mounts the panel only while the community surface is enabled', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    render('/notifications?tab=community')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('#notifications-tab-community')).not.toBeNull()
    await waitForDom(() => document.querySelector('[data-testid="community-panel-stub"]') !== null)
  })

  it('splits the account-menu unread total across the inbox tabs', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    act(() => publishUnreadCounts({ activity: 12, community: 3 }))
    try {
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('#notifications-tab-activity')?.textContent).toBe('Activity · 12')
      expect(document.querySelector('#notifications-tab-community')?.textContent).toBe('Community · 3')
      expect(filterOption(/Unread/).textContent).toContain('12')
    } finally {
      act(() => publishUnreadCounts({ activity: 0, community: 0 }))
    }
  })

  it('sends in-app preference to Settings instead of duplicating the switch', () => {
    render()
    expect(document.querySelector('[data-testid="in-app-preference"]')).toBeNull()
    const settings = document.querySelector<HTMLAnchorElement>('a[href="/library?settings=notifications"]')
    expect(settings?.textContent).toContain('Settings')
    expect(ready.setPreference).not.toHaveBeenCalled()
  })

  it('keeps the Community tab free of preference switches', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    render('/notifications?tab=community')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('#notifications-tab-community')).not.toBeNull()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0)
    expect(document.querySelector('[data-testid="community-preference"]')).toBeNull()
    expect(document.querySelector('[data-testid="in-app-preference"]')).toBeNull()
  })

  it('exposes an independent email channel toggle with verified sender and per-channel reset', () => {
    render()
    const switches = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    expect(switches).toHaveLength(1)
    const emailToggle = switches.find((value) => value.getAttribute('aria-label') === 'Email notifications')!
    expect(emailToggle.getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain('no-reply@example.test')
    emailToggle.focus(); expect(document.activeElement).toBe(emailToggle)
    act(() => emailToggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); act(() => emailToggle.click())
    expect(ready.setEmailPreference).toHaveBeenCalledWith(true)
    const emailSection = document.querySelector('[data-testid="email-preference"]')!
    const reset = [...emailSection.querySelectorAll<HTMLButtonElement>('button')]
      .find((value) => value.textContent?.trim() === 'Use default')!
    act(() => reset.click())
    expect(ready.resetEmailPreference).toHaveBeenCalled()
    expect(ready.resetPreference).not.toHaveBeenCalled()
  })

  it('email flag off hides only the email control while the Notification center stays usable', () => {
    mocks.emailEnabled = false; render()
    expect(document.querySelector('[data-testid="email-preference"]')).toBeNull()
    expect(document.querySelector('[data-testid="notification-center"]')).not.toBeNull()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0)
    expect(document.querySelector('a[href="/library?settings=notifications"]')).not.toBeNull()
  })

  it('shows an honest unavailable state with retry when the backend reports email unavailable', () => {
    mocks.hook.mockReturnValue({ ...ready, preference: { ...ready.preference, email: { ...email, emailAvailable: false, verifiedSender: null } } })
    render()
    const section = document.querySelector('[data-testid="email-preference"]')!
    expect(section.textContent).toContain('Email notifications are unavailable')
    expect(section.querySelector('[role="switch"]')).toBeNull()
    const retry = section.querySelector<HTMLButtonElement>('button')!
    act(() => retry.click()); expect(ready.refresh).toHaveBeenCalled()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0)
  })

  it('shows a read-only unsubscribed state that never fakes a usable toggle', () => {
    mocks.hook.mockReturnValue({ ...ready, preference: { ...ready.preference, email: { ...email, emailSuppressed: true } } })
    render()
    const section = document.querySelector('[data-testid="email-preference"]')!
    expect(section.textContent).toContain('unsubscribed')
    expect(section.querySelector('[role="switch"]')).toBeNull()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0)
  })

  it('preselects Collection changes from filter=collection and writes the pill back to the URL', async () => {
    render('/notifications?filter=collection')
    await waitForDom(domFinishedLoading)
    expect(filterOption('Collection changes').selected).toBe(true)
    expect(filterOption('All').selected).toBe(false)
    expect(mocks.hook).toHaveBeenCalledWith(expect.objectContaining({ state: 'all' }))

    chooseFilter(/Unread/)
    expect(filterOption(/Unread/).selected).toBe(true)
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toBe('?filter=unread')
    expect(mocks.hook).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'unread' }))

    chooseFilter('Follows')
    expect(filterOption('Follows').selected).toBe(true)
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toBe('?filter=follows')
    expect(mocks.hook).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'all' }))

    chooseFilter('Collection changes')
    expect(filterOption('Collection changes').selected).toBe(true)
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toBe('?filter=collection')

    chooseFilter('All')
    expect(filterOption('All').selected).toBe(true)
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toBe('')
  })

  it('keeps narrow-viewport content semantically complete without logical truncation', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 }); render()
    const item = document.querySelector('[data-notification-item]')!
    expect(item.textContent).toContain('Follows')
    expect(item.textContent).toContain('Someone followed your work')
    expect(item.textContent).not.toContain('profile-2')
    expect(item.querySelector('[data-notification-read]')).not.toBeNull()
    expect(document.querySelector('[data-testid="email-preference"]')?.textContent).toContain('Email notifications')
  })

  it('links collection changes to publication slugs and follows to actor handles', () => {
    const opaqueCollectionId = 'opaque-collection-id'
    const collectionWithSlug = {
      notificationId: 'notification-col', notificationType: 'collection_change' as const,
      actorProfileId: 'profile-actor', actorHandle: 'mira.writer', collectionTitle: 'LLM learning path',
      publicationSlug: 'llm-learning-path', subject: { type: 'collection' as const, id: opaqueCollectionId },
      state: 'unread' as const, stateRevision: '1', readAt: null, occurredAt: '2026-07-29T08:00:00.000Z',
    }
    const collectionWithoutSlug = {
      notificationId: 'notification-private', notificationType: 'collection_change' as const,
      actorProfileId: 'profile-actor', actorHandle: 'mira.writer', collectionTitle: null, publicationSlug: null,
      subject: { type: 'collection' as const, id: opaqueCollectionId },
      state: 'read' as const, stateRevision: '1', readAt: '2026-07-29T08:01:00.000Z', occurredAt: '2026-07-29T07:30:00.000Z',
    }
    const encodedSlugItem = {
      ...collectionWithSlug, notificationId: 'notification-encoded', publicationSlug: 'llm/learning-path',
    }
    const followWithHandle = {
      ...notification, notificationId: 'notification-follow', actorHandle: 'ada.west', actorDisplayName: null,
    }
    const followWithoutHandle = {
      ...notification, notificationId: 'notification-follow-no-handle', actorDisplayName: null,
    }
    mocks.hook.mockReturnValue({
      ...ready,
      items: [collectionWithSlug, followWithHandle, collectionWithoutSlug, encodedSlugItem, followWithoutHandle],
    })
    render()
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.querySelector(`a[href="/c/${encodeURIComponent('llm/learning-path')}"]`)).not.toBeNull()
    expect(document.body.innerHTML).not.toContain(`/c/${opaqueCollectionId}`)
    expect(document.querySelector(`a[href="/c/${opaqueCollectionId}"]`)).toBeNull()
    expect(document.querySelector('a[href="/u/mira.writer"]')).not.toBeNull()
    expect(document.querySelector('a[href="/u/ada.west"]')).not.toBeNull()
    expect(document.querySelector('a[href="/u/profile-2"]')).toBeNull()
    expect(document.querySelector('a[href="/u/profile-actor"]')).toBeNull()
  })

  it('shows actorDisplayName on a follow row and still locates only from actorHandle', () => {
    mocks.hook.mockReturnValue({
      ...ready,
      items: [{ ...notification, actorHandle: 'mira.okada', actorDisplayName: 'Mira Okada' }],
    })
    render()
    const item = document.querySelector('[data-notification-item]')!
    expect(item.textContent).toContain('Mira Okada followed your work')
    expect(item.textContent).not.toContain('Someone followed your work')
    expect(item.querySelector('a[href="/u/mira.okada"]')).not.toBeNull()
    expect(item.querySelector('a[href="/u/profile-2"]')).toBeNull()
    expect(item.textContent).not.toContain('profile-2')
  })

  it('shows actorDisplayName without a profile link when actorHandle is absent', () => {
    mocks.hook.mockReturnValue({
      ...ready,
      items: [{ ...notification, actorHandle: null, actorDisplayName: 'Kai Nakamura' }],
    })
    render()
    const item = document.querySelector('[data-notification-item]')!
    expect(item.textContent).toContain('Kai Nakamura followed your work')
    expect(item.querySelector('a[href^="/u/"]')).toBeNull()
    expect(document.body.innerHTML).not.toContain('/u/')
    expect(item.textContent).not.toContain('profile-2')
  })

  it('treats empty-string and null actorDisplayName as absent', () => {
    const emptyName = {
      ...notification, notificationId: 'notification-empty-name', actorHandle: 'ada.west', actorDisplayName: '',
    }
    const collectionSpacer = {
      notificationId: 'notification-spacer', notificationType: 'collection_change' as const,
      actorProfileId: 'profile-actor', actorHandle: 'mira.writer', actorDisplayName: 'Mira Okada',
      collectionTitle: 'LLM learning path', publicationSlug: 'llm-learning-path',
      subject: { type: 'collection' as const, id: 'opaque-collection-id' },
      state: 'read' as const, stateRevision: '1', readAt: '2026-07-29T08:01:00.000Z',
      occurredAt: '2026-07-29T07:30:00.000Z',
    }
    const nullName = {
      ...notification, notificationId: 'notification-null-name', actorHandle: null, actorDisplayName: null,
    }
    mocks.hook.mockReturnValue({ ...ready, items: [emptyName, collectionSpacer, nullName] })
    render()
    const items = [...document.querySelectorAll('[data-notification-item]')]
    expect(items).toHaveLength(3)
    expect(items[0]!.textContent).toContain('Someone followed your work')
    expect(items[0]!.querySelector('a[href="/u/ada.west"]')).not.toBeNull()
    expect(items[2]!.textContent).toContain('Someone followed your work')
    expect(items[2]!.querySelector('a[href^="/u/"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/undefined followed your work/u)
  })

  it('does not render closed summary tokens as inbox copy', () => {
    const collectionWithToken = {
      notificationId: 'notification-col-token', notificationType: 'collection_change' as const,
      actorProfileId: 'profile-actor', actorHandle: 'mira.writer', collectionTitle: 'LLM learning path',
      publicationSlug: 'llm-learning-path', subject: { type: 'collection' as const, id: 'opaque-collection-id' },
      state: 'unread' as const, stateRevision: '1', readAt: null, occurredAt: '2026-07-29T08:00:00.000Z',
      summary: 'public_collection_updated',
    }
    const followWithToken = {
      ...notification, notificationId: 'notification-follow-token', actorHandle: 'ada.west',
      summary: 'new_follower',
    }
    mocks.hook.mockReturnValue({ ...ready, items: [collectionWithToken, followWithToken] })
    render()
    expect(document.body.textContent).not.toContain('public_collection_updated')
    expect(document.body.textContent).not.toContain('new_follower')
    expect(document.body.textContent).toContain('LLM learning path')
    expect(document.body.textContent).toContain('Someone followed your work')
  })

  it('keeps grouped follows as a count without listing actorDisplayName values', () => {
    const first = { ...notification, notificationId: 'notification-group-a', actorHandle: 'mira.okada', actorDisplayName: 'Mira Okada' }
    const second = { ...notification, notificationId: 'notification-group-b', actorHandle: 'kai.nakamura', actorDisplayName: 'Kai Nakamura' }
    mocks.hook.mockReturnValue({ ...ready, items: [first, second] })
    render()
    expect(document.querySelectorAll('[data-notification-item]')).toHaveLength(1)
    expect(document.body.textContent).toContain('2 people followed your work')
    expect(document.body.textContent).not.toContain('Mira Okada')
    expect(document.body.textContent).not.toContain('Kai Nakamura')
    expect(document.querySelector('a[href="/u/mira.okada"]')).toBeNull()
    expect(document.querySelector('a[href="/u/kai.nakamura"]')).toBeNull()
  })

  it('says what is new on unread rows and drops the state line on read rows (R12-09)', () => {
    const change = {
      notificationId: 'notification-change', notificationType: 'collection_change' as const,
      actorProfileId: 'profile-actor', actorHandle: 'mira.writer', collectionTitle: 'LLM learning path',
      publicationSlug: 'llm-learning-path', subject: { type: 'collection' as const, id: 'collection-1' },
      state: 'unread' as const, stateRevision: '1', readAt: null, occurredAt: '2026-07-29T09:00:00.000Z',
    }
    const followA = { ...notification, notificationId: 'notification-follow-a' }
    const followB = { ...notification, notificationId: 'notification-follow-b' }
    const readChange = { ...change, notificationId: 'notification-read', state: 'read' as const, readAt: '2026-07-29T09:30:00.000Z' }
    mocks.hook.mockReturnValue({ ...ready, items: [change, followA, followB, readChange] })
    render()
    const rows = [...document.querySelectorAll('[data-notification-item]')]
    expect(rows.map((row) => row.querySelector('p')?.textContent ?? null)).toEqual(['New changes', '2 new followers', null])
    expect(rows[2]!.getAttribute('aria-label')).toBe('Read notification: LLM learning path')
  })

  it('skins the inbox tabs as the standard tab rail', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    render()
    await waitForDom(domFinishedLoading)
    const tablist = document.querySelector('[role="tablist"][aria-label="Notification inboxes"]')
    expect(tablist?.className).toBe('tab-rail')
    expect(tablist?.querySelector('[role="tab"]')?.getAttribute('class')).toBeNull()
  })
})
