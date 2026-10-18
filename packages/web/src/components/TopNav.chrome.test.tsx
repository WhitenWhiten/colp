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
      username?: string
      initials: string
      accountId: string
      profileId: string
    },
    isLoggedIn: false,
    sessionState: 'signed-out',
    logout: vi.fn().mockResolvedValue('signed-out'),
  },
  toast: vi.fn(),
  toastError: vi.fn(),
}))

import { markServerFeatureAvailable, markServerFeatureUnavailable } from '../lib/serverFeatureAvailability'
import { OPEN_SEARCH_PALETTE_EVENT } from '../lib/searchPaletteEvents'

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, error: mocks.toastError }),
}))
vi.mock('./SearchPalette', () => ({
  SearchPalette: ({ open }: { open: boolean }) => <div data-testid="search-palette" data-open={open ? 'true' : 'false'} />,
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
    mocks.auth.sessionState = 'signed-out'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('offers guests only Sign in, with no primary nav, tools or menu', () => {
    render('/c/browser-research')
    expect(document.querySelector('[aria-label="Primary"]')).toBeNull()
    expect(document.querySelector('[data-testid="tools-trigger"]')).toBeNull()
    expect(document.querySelector('[aria-controls="mobile-navigation"]')).toBeNull()
    expect(document.querySelector('a[href="/login?returnTo=%2Fc%2Fbrowser-research"]')?.textContent).toBe('Sign in')
  })

  it('offers no Sign in while the session check fails: the visitor may be signed in (R15-23)', () => {
    mocks.auth.sessionState = 'offline'
    render('/library')
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
  })

  it('offers guests no library search: the palette would only answer with a sign-in wall', () => {
    render('/c/browser-research')
    expect(document.querySelector('button.nav-search')).toBeNull()
    expect(document.querySelector('button.nav-search-compact')).toBeNull()
  })

  it('ignores ⌘/Ctrl+K and the open-palette event for guests, and closes the palette on sign-out', async () => {
    render('/c/browser-research')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    })
    expect(document.querySelector('[data-testid="search-palette"]')).toBeNull()
    act(() => {
      window.dispatchEvent(new Event(OPEN_SEARCH_PALETTE_EVENT))
    })
    expect(document.querySelector('[data-testid="search-palette"]')).toBeNull()
    cleanup()
    document.body.innerHTML = ''

    signIn()
    render('/library')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.querySelector('[data-testid="search-palette"]')?.getAttribute('data-open')).toBe('true')
    // The session ends while the palette is open: the palette goes with it.
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    render('/library')
    expect(document.querySelector('[data-testid="search-palette"]')).toBeNull()
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
    cleanup()
    document.body.innerHTML = ''
    // The sign-up card links to sign-in itself.
    render('/register')
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
  })

  it('shows Library, Sync, Agents and Approvals and a warning Sign out when signed in', () => {
    signIn()
    render('/library/col-1')
    const primary = [...document.querySelectorAll('[aria-label="Primary"] a')]
    expect(primary.map((anchor) => anchor.getAttribute('href'))).toEqual(['/library', '/sync', '/agents', '/approvals'])
    expect(primary.every((anchor) => anchor.classList.contains('nav-link-core'))).toBe(true)
    expect(document.querySelector('[aria-label="Primary"] a[href="/library"]')?.classList.contains('is-active')).toBe(true)
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    const logout = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Sign out')
    expect(logout?.classList.contains('account-logout')).toBe(true)
    const accountMenu = document.getElementById('account-dropdown')
    expect([...accountMenu!.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual(['/approvals'])
    // No public profiles here: the generated @handle is not shown, the email is.
    expect(document.body.textContent).not.toContain('@lin-yichen')
    expect(accountMenu?.textContent).toContain('lin.yichen@example.com')
  })

  it('names the account by its sign-in username when the server sends one', () => {
    signIn()
    mocks.auth.user = { ...mocks.auth.user!, username: 'linyc' }
    render('/library')
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    const accountMenu = document.getElementById('account-dropdown')
    expect(accountMenu?.textContent).toContain('@linyc')
    expect(accountMenu?.textContent).not.toContain('lin.yichen@example.com')
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
      '/library/health',
      '/import',
      '/approvals',
    ])
  })

  it('traps Tab inside the open mobile drawer overlay', () => {
    signIn()
    render('/library')
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
      '/library/health',
      '/import',
    ])
    expect([...dropdown.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual([
      'Extension',
      'Link health',
      'Import',
    ])

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[data-testid="tools-dropdown"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('drops Sync from the primary nav once the server said it has none', () => {
    signIn()
    render('/library')
    const primaryHrefs = () => [...document.querySelectorAll('[aria-label="Primary"] a')].map((anchor) => anchor.getAttribute('href'))
    expect(primaryHrefs()).toContain('/sync')
    try {
      act(() => markServerFeatureUnavailable('sync'))
      expect(primaryHrefs()).toEqual(['/library', '/agents', '/approvals'])
    } finally {
      act(() => markServerFeatureAvailable('sync'))
    }
    expect(primaryHrefs()).toContain('/sync')
  })
})
