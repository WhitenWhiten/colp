// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelfHostedLogin } from './SelfHostedLogin'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  refreshSession: vi.fn<() => Promise<void>>(),
  getRegistrationState: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithUsername: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: false, bootstrapping: false, refreshSession: mocks.refreshSession }),
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, error: mocks.toast }),
}))
vi.mock('../api/authClient', () => ({
  authClient: {
    getRegistrationState: mocks.getRegistrationState,
    signInWithPassword: mocks.signInWithPassword,
    signInWithUsername: mocks.signInWithUsername,
  },
}))

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit() {
  await act(async () => {
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('SelfHostedLogin', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.getRegistrationState.mockReset().mockResolvedValue({ open: false, reason: 'closed' })
    mocks.signInWithPassword.mockReset().mockResolvedValue({ status: true })
    mocks.signInWithUsername.mockReset().mockResolvedValue({ status: true })
    mocks.toast.mockReset()
  })

  afterEach(() => cleanup())

  async function render() {
    await act(async () => {
      mountTree(
        <MemoryRouter initialEntries={['/login']}>
          <SelfHostedLogin />
        </MemoryRouter>,
      )
    })
  }

  it('offers only username-or-email and password: no code, providers, or mailed reset', async () => {
    await render()
    expect(document.querySelector('label[for="login-identifier"]')?.textContent).toBe('Username or email')
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Google')
    expect(document.body.textContent).not.toContain('Email code')
    expect(document.querySelector('a[href^="/reset-password"]')).toBeNull()
    expect(document.querySelector('[data-testid="login-reset-hint"]')?.textContent).toContain('colp-server reset-password')
    expect(document.body.textContent).not.toContain('Know-N')
  })

  it('signs in by username when the identifier has no @', async () => {
    await render()
    change(document.querySelector('#login-identifier') as HTMLInputElement, ' alice ')
    change(document.querySelector('#login-password') as HTMLInputElement, 'correct-horse')
    await submit()
    expect(mocks.signInWithUsername).toHaveBeenCalledWith({ username: 'alice', password: 'correct-horse' })
    expect(mocks.signInWithPassword).not.toHaveBeenCalled()
  })

  it('signs in by email when the identifier has an @', async () => {
    await render()
    change(document.querySelector('#login-identifier') as HTMLInputElement, 'Alice@Example.net')
    change(document.querySelector('#login-password') as HTMLInputElement, 'correct-horse')
    await submit()
    expect(mocks.signInWithPassword).toHaveBeenCalledWith(expect.objectContaining({
      email: 'alice@example.net',
      password: 'correct-horse',
    }))
    expect(mocks.signInWithUsername).not.toHaveBeenCalled()
  })

  it('points a server without an owner at first-run setup', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'first-run' })
    await render()
    const notice = document.querySelector('[data-testid="login-owner-missing"]')
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/register')
  })
})
