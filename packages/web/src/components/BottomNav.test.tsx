// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { BottomNav } from './BottomNav'
import { UnreadBadgeFeed } from './UnreadBadgeFeed'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as null | {
      name: string
      handle: string
      email: string
      initials: string
      accountId: string
      profileId: string
    },
    isLoggedIn: false,
    logout: vi.fn().mockResolvedValue('signed-out'),
  },
  notificationExposure: false,
  communityExposure: false,
  activityUnread: 0,
  communityUnread: 0,
}))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  isNotificationExposureEnabled: () => mocks.notificationExposure,
  isCommunityExposureEnabled: () => mocks.communityExposure,
}))
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))
vi.mock('../lib/useNotificationCenter', () => ({
  useNotificationCenter: () => ({ unreadCount: mocks.activityUnread }),
}))
vi.mock('../lib/useCommunityNotificationCenter', () => ({
  useCommunityNotificationCenter: () => ({ unreadCount: mocks.communityUnread }),
}))

/* R15-27: the navs read one shared count that UnreadBadgeFeed publishes. */
function renderWithFeed(ui: ReactNode) {
  return (
    <>
      <UnreadBadgeFeed activity={mocks.notificationExposure} community={mocks.communityExposure} />
      {ui}
    </>
  )
}

describe('BottomNav', () => {

  function render(path = '/') {
    mountTree(
      <MemoryRouter initialEntries={[path]}>
        {renderWithFeed(<BottomNav />)}
      </MemoryRouter>,
    )
  }

  function tabHrefs() {
    const nav = document.querySelector('[aria-label="Mobile primary"]')
    return [...(nav?.querySelectorAll('a') ?? [])].map((anchor) => anchor.getAttribute('href'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    mocks.notificationExposure = false
    mocks.communityExposure = false
    mocks.activityUnread = 0
    mocks.communityUnread = 0
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lists five signed-in destinations with Profile at /u/<handle>', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    render('/explore')
    // Same order as the desktop nav: Today, Explore, Library.
    expect(tabHrefs()).toEqual([
      '/today',
      '/explore',
      '/library',
      '/notifications',
      '/u/lin-yichen',
    ])
    const nav = document.querySelector('[aria-label="Mobile primary"]')
    expect(nav?.querySelector('a[href="/notifications"]')).not.toBeNull()
    expect(nav?.querySelector('a[href="/notifications"] [data-testid="bottom-nav-label"]')?.textContent).toBe('Notifications')
  })

  it('shows Explore and Log in for guests and never exposes workbench channels', () => {
    render('/')
    expect(tabHrefs()).toEqual(['/explore', '/login'])
    expect(document.querySelector('a[href="/today"]')).toBeNull()
    expect(document.querySelector('a[href="/library"]')).toBeNull()
    expect(document.querySelector('a[href="/notifications"]')).toBeNull()
    expect(document.querySelector('[aria-label="Mobile primary"] a[href="/login"] [data-testid="bottom-nav-label"]')?.textContent).toBe('Log in')
  })

  it('points the guest Log in tab back at the current page', () => {
    render('/c/browser-research')
    expect(tabHrefs()).toEqual(['/explore', '/login?returnTo=%2Fc%2Fbrowser-research'])
  })

  it('marks Library current on a nested collection path', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    render('/library/col-1')
    const nav = document.querySelector('[aria-label="Mobile primary"]')
    const library = nav?.querySelector('a[href="/library"]')
    expect(library?.getAttribute('aria-current')).toBe('page')
    expect(library?.classList.contains('is-active')).toBe(true)
    expect(nav?.querySelector('a[href="/today"]')?.getAttribute('aria-current')).toBeNull()
    expect(nav?.querySelector('a[href="/explore"]')?.getAttribute('aria-current')).toBeNull()
  })

  it('lights the notifications badge from community unread when activity is quiet', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    mocks.notificationExposure = false
    mocks.communityExposure = true
    mocks.activityUnread = 0
    mocks.communityUnread = 2
    render('/explore')
    const tab = document.querySelector('a[href="/notifications"]')
    expect(tab?.querySelector('[data-testid="notifications-badge-dot"]')).not.toBeNull()
    expect(tab?.getAttribute('aria-label')).toBe('Notifications, 2 unread')
  })
})
