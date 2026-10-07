// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Footer } from './Footer'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    user: {
      name: '林一晨',
      handle: 'lin-yichen',
      email: 'lin.yichen@example.com',
      initials: '林',
      accountId: 'account-1',
      profileId: 'profile-1',
    } as { name: string; handle: string; email: string; initials: string; accountId: string; profileId: string } | null,
    isLoggedIn: false,
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

describe('Footer session chrome', () => {

  function SearchProbe() {
    const location = useLocation()
    return <span data-testid="location-search">{location.search}</span>
  }

  function render(path = '/') {
    mountTree(
      <MemoryRouter initialEntries={[path]}>
        <Footer />
        <SearchProbe />
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows Log in for guests and keeps product workbench links out of the footer', () => {
    render()
    expect(document.body.textContent).toContain('Log in')
    expect(document.querySelector('a[href="/login"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Demo hub')
    expect(document.querySelector('a[href="/demos"]')).toBeNull()
    expect(document.querySelector('a[href="/today"]')).toBeNull()
    expect(document.querySelector('a[href="/library"]')).toBeNull()
    expect(document.querySelector('a[href="/about"]')).not.toBeNull()
    expect(document.querySelector('a[href="/contact"]')).not.toBeNull()
    expect(document.querySelector('a[href="/privacy"]')).not.toBeNull()
    expect(document.querySelector('a[href="/developers"]')?.textContent).toBe('Developers')
    expect(document.querySelector('a[href="/mcp"]')?.textContent).toBe('MCP')
    expect(document.querySelector('nav[aria-label="Legal"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="site-footer-heading"]')?.textContent).toBe('Product')
  })

  it('replaces Log in with a one-line Settings and Account footer after sign-in', () => {
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
    expect(document.querySelector('a[href="/login"]')).toBeNull()
    expect(document.querySelector('a[href="/settings"]')).toBeNull()
    const settings = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Settings')
    expect(settings).not.toBeNull()
    act(() => settings!.click())
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toContain('settings=profile')
    expect(document.querySelector('a[href="/u/lin-yichen"]')?.textContent).toBe('Profile')
    expect(document.querySelector('a[href="/about"]')?.textContent).toBe('About')
    expect(document.querySelector('a[href="/contact"]')?.textContent).toBe('Contact')
    expect(document.querySelector('a[href="/developers"]')?.textContent).toBe('Developers')
    expect(document.querySelector('a[href="/mcp"]')?.textContent).toBe('MCP')
    expect(document.querySelector('a[href="/privacy"]')?.textContent).toBe('Privacy')
    expect(document.querySelector('a[href="/today"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="site-footer-heading"]')).toHaveLength(0)
  })
})
