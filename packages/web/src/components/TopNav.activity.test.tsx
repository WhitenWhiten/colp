// @vitest-environment happy-dom
import { act } from 'react'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopNav } from './TopNav'
import { publishActivitySummary, publishActivityUnavailable, resetActivityStatus } from '../lib/activityStatus'
import { cleanup, renderWithRouter } from '../test/render'

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({
  user: { accountId: 'owner', name: 'Owner', initials: 'O' }, isLoggedIn: true, logout: vi.fn(),
}) }))
vi.mock('./AppToast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('./SearchPalette', () => ({ SearchPalette: () => null }))

function Location() { return <output>{useLocation().pathname}</output> }

describe('Activity navigation', () => {
  beforeEach(() => resetActivityStatus())
  afterEach(() => { cleanup(); resetActivityStatus() })

  it('shows the unread count with an accessible label and caps the pill at 99+', () => {
    renderWithRouter(<><TopNav /><Location /></>, { route: '/library' })
    expect(document.querySelector('[aria-label^="Activity,"]')).toBeNull()
    act(() => publishActivitySummary({ unreadCount: 107, latest: null, revision: '9' }))
    const bell = document.querySelector<HTMLButtonElement>('[aria-label="Activity, 107 unread"]')
    expect(bell?.querySelector('span[aria-hidden]')?.textContent).toBe('99+')
    act(() => bell?.click())
    expect(document.querySelector('output')?.textContent).toBe('/activity')
    act(() => publishActivitySummary({ unreadCount: 0, latest: null, revision: '10' }))
    expect(document.querySelector('[aria-label="Activity, 0 unread"]')).not.toBeNull()
    expect(document.querySelector('[aria-label^="Activity,"] span[aria-hidden]')).toBeNull()
  })

  it('offers Activity in the account menu and mobile drawer, and conceals every entry when unavailable', () => {
    renderWithRouter(<TopNav />, { route: '/activity' })
    act(() => publishActivitySummary({ unreadCount: 7, latest: null, revision: '9' }))
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')?.click())
    expect(document.querySelector('nav[aria-label="Account"] a[href="/activity"]')).not.toBeNull()
    act(() => document.querySelector<HTMLAnchorElement>('nav[aria-label="Account"] a[href="/activity"]')?.click())
    expect(document.querySelector('[data-testid="account-trigger"]')?.getAttribute('aria-expanded')).toBe('false')
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')?.click())
    expect(document.querySelector('nav[aria-label="Mobile"] a[href="/activity"]')).not.toBeNull()
    act(() => publishActivityUnavailable())
    expect(document.querySelector('[aria-label^="Activity,"]')).toBeNull()
    expect(document.querySelector('a[href="/activity"]')).toBeNull()
  })
})
