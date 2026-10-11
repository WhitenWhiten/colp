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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, error: mocks.toastError }),
}))
vi.mock('./SearchPalette', () => ({
  SearchPalette: () => null,
}))

describe('TopNav session chrome', () => {
  function SearchProbe() {
    const location = useLocation()
    return <span data-testid="location-search">{location.search}</span>
  }

  function signIn() {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    }
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

  it('offers guests only Sign in, with no primary nav or tools', () => {
    render('/c/browser-research')
    expect(document.querySelector('[aria-label="Primary"]')).toBeNull()
    expect(document.querySelector('[data-testid="tools-trigger"]')).toBeNull()
    expect(document.querySelector('a[href="/login?returnTo=%2Fc%2Fbrowser-research"]')?.textContent).toBe('Sign in')
  })

  it('offers guests no library search: the palette would only answer with a sign-in wall', () => {
    render('/c/browser-research')
    expect(document.querySelector('button.nav-search')).toBeNull()
    expect(document.querySelector('button.nav-search-compact')).toBeNull()
  })

  it('marks the search trigger as opening a dialog', () => {
    signIn()
    render('/library')
    const trigger = document.querySelector('button.nav-search')
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('button.nav-search-compact')?.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('drops the primary nav and the Sign in link on auth routes', () => {
    render('/login')
    expect(document.querySelector('[aria-label="Primary"]')).toBeNull()
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
  })

  it('shows Library, Agents and Approvals and a warning Sign out when signed in', () => {
    signIn()
    render('/library/col-1')
    const primary = [...document.querySelectorAll('[aria-label="Primary"] a')]
    expect(primary.map((anchor) => anchor.getAttribute('href'))).toEqual(['/library', '/agents', '/approvals'])
    expect(primary.every((anchor) => anchor.classList.contains('nav-link-core'))).toBe(true)
    expect(document.querySelector('[aria-label="Primary"] a[href="/library"]')?.classList.contains('is-active')).toBe(true)
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    const logout = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')
    expect(logout?.classList.contains('account-logout')).toBe(true)
    const accountMenu = document.getElementById('account-dropdown')
    expect([...accountMenu!.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual(['/approvals'])
  })

  it('says "Signed out" only after the server confirmed it (R15-21)', async () => {
    signIn()
    mocks.auth.logout.mockResolvedValueOnce('failed').mockResolvedValueOnce('signed-out')
    render('/library')
    const clickLogOut = async () => {
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
      await act(async () => {
        [...document.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')!.click()
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

  it('lists only account entries and tools in the signed-in mobile drawer', () => {
    signIn()
    render('/library')
    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    const drawer = document.getElementById('mobile-navigation')
    expect([...drawer!.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/extension',
      '/sync',
      '/library/health',
      '/import',
      '/approvals',
    ])
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

  it('offers only Sign in in the guest mobile drawer', () => {
    render('/')
    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    const drawer = document.getElementById('mobile-navigation')
    expect([...drawer!.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual(['Sign in'])
  })

  it('exposes the account dropdown as disclosure navigation, not a menu', () => {
    signIn()
    render('/library')
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
    signIn()
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
    signIn()
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
    signIn()
    render('/library')
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
      '/library/health',
      '/import',
    ])
    expect([...dropdown.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual([
      'Extension',
      'Sync center',
      'Link health',
      'Import',
    ])

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[data-testid="tools-dropdown"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('marks Sync unavailable once the server said so', () => {
    signIn()
    try {
      markServerFeatureUnavailable('sync')
      render('/library')
      act(() => document.querySelector<HTMLButtonElement>('[data-testid="tools-trigger"]')!.click())
      const dropdown = document.querySelector<HTMLElement>('[data-testid="tools-dropdown"]')!
      const hrefs = [...dropdown.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))
      expect(hrefs).not.toContain('/sync')
      const sync = dropdown.querySelector('[aria-disabled="true"]')
      expect(sync?.textContent).toBe('Sync center Not available')
    } finally {
      act(() => markServerFeatureAvailable('sync'))
    }
  })
})
