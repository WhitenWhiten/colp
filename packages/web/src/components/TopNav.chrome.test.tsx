// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopNav } from './TopNav'
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
  toast: vi.fn(),
  toastError: vi.fn(),
}))

import { markServerFeatureAvailable, markServerFeatureUnavailable } from '../lib/serverFeatureAvailability'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  isWriteApprovalsExposureEnabled: () => false,
  isNotificationExposureEnabled: () => false,
}))
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, error: mocks.toastError }),
}))
vi.mock('../lib/useNotificationCenter', () => ({
  useNotificationCenter: () => ({ unreadCount: 0 }),
}))
vi.mock('../lib/useCommunityNotificationCenter', () => ({
  useCommunityNotificationCenter: () => ({ unreadCount: 0 }),
}))
vi.mock('./SearchPalette', () => ({
  SearchPalette: () => null,
}))

describe('TopNav session chrome', () => {

  function SearchProbe() {
    const location = useLocation()
    return <span data-testid="location-search">{location.search}</span>
  }

  function render(path = '/') {
    mountTree(
      <MemoryRouter initialEntries={[path]}>
        <TopNav />
        <SearchProbe />
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('hides workbench channels and the bell for guests', () => {
    render('/')
    expect(document.querySelector('a[href="/today"]')).toBeNull()
    expect(document.querySelector('a[href="/library"]')).toBeNull()
    expect(document.querySelector('a[href="/dashboard"]')).toBeNull()
    expect(document.querySelector('a[href="/explore"]')).not.toBeNull()
    expect(document.querySelector('a[href="/notifications"]')).toBeNull()
    expect(document.querySelector('a[href="/login"]')?.textContent).toContain('Log in')
  })

  it('points the guest Log in link back at the current page', () => {
    render('/c/browser-research')
    expect(document.querySelector('a[href="/login?returnTo=%2Fc%2Fbrowser-research"]')?.textContent).toContain('Log in')
  })

  it('marks the search trigger as opening a dialog', () => {
    render('/')
    const trigger = document.querySelector('button.nav-search')
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('button.nav-search-compact')?.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('does not highlight a workbench channel on auth routes', () => {
    render('/login')
    expect(document.querySelector('[aria-label="Primary"]')).toBeNull()
    expect(document.querySelector('a[href="/login"]')).toBeNull()
    expect(document.querySelector('a[href="/register"]')?.textContent).toContain('Get started')
  })

  it('shows product channels, the bell, and a warning Log out when signed in', () => {
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
    expect(document.querySelector('a[href="/today"]')).not.toBeNull()
    expect(document.querySelector('a[href="/notifications"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Primary"] a[href="/dashboard"]')).toBeNull()
    expect(document.querySelector('a[href="/updates"]')).toBeNull()
    expect(document.querySelector('a[href="/explore"]')?.classList.contains('is-active')).toBe(true)
    expect(document.querySelector('[aria-label="Primary"] a[href="/today"]')?.classList.contains('nav-link-core')).toBe(true)
    expect(document.querySelector('[aria-label="Primary"] a[href="/explore"]')?.classList.contains('nav-link-core')).toBe(true)
    expect(document.querySelector('[aria-label="Primary"] a[href="/library"]')?.classList.contains('nav-link-core')).toBe(true)
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    const logout = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Log out')
    expect(logout?.classList.contains('account-logout')).toBe(true)
    expect(document.body.textContent).not.toContain('Demo hub')
    expect(document.body.textContent).not.toContain('Updates inbox')
    const accountMenu = document.getElementById('account-dropdown')
    expect(accountMenu?.querySelector('a[href="/demos"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/notifications"]')).not.toBeNull()
    expect(accountMenu?.querySelector('a[href="/updates"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/sync"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/classify"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/import"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/extension"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/library/health"]')).toBeNull()
    expect(accountMenu?.querySelector('a[href="/ai/organize"]')).toBeNull()
  })

  it('says "Signed out" only after the server confirmed it (R15-21)', async () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: 'Ada',
      handle: 'ada',
      email: 'ada@example.com',
      initials: 'A',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    mocks.auth.logout.mockResolvedValueOnce('failed').mockResolvedValueOnce('signed-out')
    render('/explore')
    const clickLogOut = async () => {
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
      await act(async () => {
        [...document.querySelectorAll('button')].find((button) => button.textContent === 'Log out')!.click()
      })
    }

    await clickLogOut()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't sign out. You may still be signed in on this device.",
      expect.objectContaining({ action: expect.objectContaining({ label: 'Retry' }) }),
    )
    expect(document.querySelector('[data-testid="location-search"]')).not.toBeNull()

    const retry = mocks.toastError.mock.calls[0]![1].action.onClick as () => void
    await act(async () => { retry() })
    expect(mocks.auth.logout).toHaveBeenCalledTimes(2)
    expect(mocks.toast).toHaveBeenCalledWith('Signed out')
  })

  it('hides Demo hub from the signed-in account menu and mobile drawer', () => {
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
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    expect(document.getElementById('account-dropdown')?.textContent).not.toContain('Demo hub')
    expect(document.getElementById('account-dropdown')?.querySelector('a[href="/demos"]')).toBeNull()
    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    const drawer = document.getElementById('mobile-navigation')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).not.toContain('Demo hub')
    expect(drawer?.querySelector('a[href="/demos"]')).toBeNull()
    expect(drawer?.textContent).not.toContain('AI chat')
    expect(drawer?.querySelector('a[href="/ai/chat"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/today"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/library"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/explore"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/notifications"]')).toBeNull()
  })

  it('traps Tab inside the open mobile drawer overlay', () => {
    render('/')
    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    expect(document.getElementById('mobile-navigation')).not.toBeNull()
    const outside = document.createElement('button')
    outside.textContent = 'outside'
    document.body.appendChild(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.querySelector('header.topnav')?.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(outside)
    outside.remove()
  })

  it('keeps Demo hub out of the guest mobile drawer', () => {
    render('/')
    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    const drawer = document.getElementById('mobile-navigation')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).not.toContain('Demo hub')
    expect(drawer?.querySelector('a[href="/demos"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/today"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/library"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/explore"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/notifications"]')).toBeNull()
    expect(document.querySelector('a[href="/today"]')).toBeNull()
    expect(drawer?.querySelector('a[href="/login"]')?.textContent).toContain('Log in')
  })

  it('exposes the account dropdown as disclosure navigation, not a menu', () => {
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
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()

    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dropdown = document.getElementById('account-dropdown')!
    expect(trigger.getAttribute('aria-controls')).toBe(dropdown.id)
    expect(dropdown.tagName).toBe('NAV')
    expect(dropdown.getAttribute('role')).toBeNull()
    expect(dropdown.querySelector('[role="menuitem"]')).toBeNull()

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.getElementById('account-dropdown')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the settings dialog from the account menu and the mobile drawer', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    render('/library')
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    const menuSettings = [...document.querySelectorAll<HTMLButtonElement>('#account-dropdown button')]
      .find((button) => button.textContent === 'Settings')
    expect(menuSettings).not.toBeNull()
    act(() => menuSettings!.click())
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toContain('settings=profile')
    expect(document.getElementById('account-dropdown')).toBeNull()

    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    const drawerSettings = [...document.querySelectorAll<HTMLButtonElement>('#mobile-navigation button')]
      .find((button) => button.textContent === 'Settings')
    expect(drawerSettings).not.toBeNull()
    act(() => drawerSettings!.click())
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toContain('settings=profile')
    expect(document.getElementById('mobile-navigation')).toBeNull()
  })

  it('hands focus to the account trigger when opening settings from its menu', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    render('/library')
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!
    act(() => trigger.click())
    const menuSettings = [...document.querySelectorAll<HTMLButtonElement>('#account-dropdown button')]
      .find((button) => button.textContent === 'Settings')!
    act(() => menuSettings.click())
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toContain('settings=profile')
    // The dialog's focus trap records whatever holds focus at open — which must be the trigger.
    expect(document.activeElement).toBe(trigger)
  })

  it('lists session tools from a desktop Tools disclosure, not the account menu', () => {
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
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="tools-trigger"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()

    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dropdown = document.querySelector<HTMLElement>('[data-testid="tools-dropdown"]')!
    expect(trigger.getAttribute('aria-controls')).toBe(dropdown.id)
    expect(dropdown.tagName).toBe('NAV')
    expect(dropdown.getAttribute('role')).toBeNull()
    expect([...dropdown.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/extension',
      '/sync',
      '/classify',
      '/library/health',
      '/import',
      '/ai/organize',
      '/moderation/reports',
      '/moderation/appeals',
      '/admin/moderation/cases',
      '/admin/moderation/appeals',
    ])
    expect([...dropdown.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual([
      'Extension',
      'Sync center',
      'Classify inbox',
      'Link health',
      'Import',
      'AI organize',
      'My content reports',
      'My appeals',
      'Moderation cases',
      'Moderation appeals',
    ])

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[data-testid="tools-dropdown"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('hides flag-off tools and marks Sync unavailable once the server said so', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
    ;(window as { __KNOWN_FLAGS__?: Record<string, boolean> }).__KNOWN_FLAGS__ = { classify: false, contentGovernance: false }
    try {
      markServerFeatureUnavailable('sync')
      render('/explore')
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="tools-trigger"]')!.click())
      const dropdown = document.querySelector<HTMLElement>('[data-testid="tools-dropdown"]')!
      const hrefs = [...dropdown.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))
      expect(hrefs).not.toContain('/classify')
      expect(hrefs).not.toContain('/sync')
      const sync = dropdown.querySelector('[aria-disabled="true"]')
      expect(sync?.textContent).toBe('Sync center Not available')
    } finally {
      markServerFeatureAvailable('sync')
      delete (window as { __KNOWN_FLAGS__?: Record<string, boolean> }).__KNOWN_FLAGS__
    }
  })

  it('offers Extension from desktop Tools when signed out', () => {
    render('/')
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="tools-trigger"]')!.click())
    const dropdown = document.querySelector<HTMLElement>('[data-testid="tools-dropdown"]')!
    expect([...dropdown.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/extension',
    ])
    expect(dropdown.textContent).toBe('Extension')
  })
})
