// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopNav } from './TopNav'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: {
      name: 'Dev User',
      handle: 'dev',
      email: 'dev@example.test',
      initials: 'DU',
      accountId: 'account-1',
      profileId: 'profile-1',
    },
    isLoggedIn: true,
    logout: vi.fn().mockResolvedValue('signed-out'),
  }),
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))
vi.mock('./SearchPalette', () => ({
  SearchPalette: () => null,
}))

describe('Write approvals navigation', () => {
  function render() {
    mountTree(<MemoryRouter><TopNav /></MemoryRouter>)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('exposes the approvals destination from the account menu', () => {
    render()
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="account-trigger"]')!.click())
    const link = document.querySelector<HTMLAnchorElement>('#account-dropdown a[href="/approvals"]')
    expect(link?.textContent).toContain('Write approvals')
  })

  it('keeps the approvals destination reachable in the mobile account drawer', () => {
    render()
    act(() => document.querySelector<HTMLButtonElement>('[aria-controls="mobile-navigation"]')!.click())
    const drawer = document.querySelector<HTMLElement>('#mobile-navigation')
    expect(drawer?.querySelector('a[href="/approvals"]')?.textContent).toContain('Write approvals')
  })
})
