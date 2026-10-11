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

  it('offers guests Sign in back to the current page and About only', () => {
    render('/c/research-notes')
    const links = [...document.querySelectorAll('nav[aria-label="Footer"] a')].map((anchor) => [anchor.textContent, anchor.getAttribute('href')])
    expect(links).toEqual([
      ['Sign in', '/login?returnTo=%2Fc%2Fresearch-notes'],
      ['About', '/about'],
    ])
    expect(document.querySelector('a[href="/library"]')).toBeNull()
    expect(document.querySelector('footer')?.textContent).toContain('COLP Server')
  })

  it('replaces Sign in with Settings, About and Agents after sign-in', () => {
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
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
    expect(document.querySelector('a[href="/settings"]')).toBeNull()
    const settings = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Settings')
    expect(settings).not.toBeNull()
    act(() => settings!.click())
    expect(document.querySelector('[data-testid="location-search"]')?.textContent).toContain('settings=profile')
    expect(document.querySelector('a[href="/about"]')?.textContent).toBe('About')
    expect(document.querySelector('a[href="/agents"]')?.textContent).toBe('Agents')
  })
})
