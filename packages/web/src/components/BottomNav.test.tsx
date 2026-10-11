// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomNav } from './BottomNav'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    isLoggedIn: false,
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

describe('BottomNav', () => {
  function render(path = '/') {
    mountTree(
      <MemoryRouter initialEntries={[path]}>
        <BottomNav />
      </MemoryRouter>,
    )
  }

  function tabHrefs() {
    const nav = document.querySelector('[aria-label="Mobile primary"]')
    return [...(nav?.querySelectorAll('a') ?? [])].map((anchor) => anchor.getAttribute('href'))
  }

  beforeEach(() => {
    mocks.auth.isLoggedIn = false
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it('lists the owner destinations in desktop nav order once signed in', () => {
    mocks.auth.isLoggedIn = true
    render('/library')
    expect(tabHrefs()).toEqual(['/library', '/agents', '/approvals'])
    const labels = [...document.querySelectorAll('[data-testid="bottom-nav-label"]')].map((node) => node.textContent)
    expect(labels).toEqual(['Library', 'Agents', 'Approvals'])
  })

  it('offers only Sign in to guests, pointing back at the current page', () => {
    render('/c/research-notes?folder=f-1')
    expect(tabHrefs()).toEqual(['/login?returnTo=%2Fc%2Fresearch-notes%3Ffolder%3Df-1'])
    expect(document.querySelector('[data-testid="bottom-nav-label"]')?.textContent).toBe('Sign in')
  })

  it('marks Library current on a nested collection path', () => {
    mocks.auth.isLoggedIn = true
    render('/library/col-1/history')
    const library = document.querySelector('[aria-label="Mobile primary"] a[href="/library"]')
    expect(library?.getAttribute('aria-current')).toBe('page')
    const agents = document.querySelector('[aria-label="Mobile primary"] a[href="/agents"]')
    expect(agents?.getAttribute('aria-current')).toBeNull()
  })
})
