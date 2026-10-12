// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPasswordCommand, SelfHostedLogin } from './SelfHostedLogin'
import { cleanup, mountTree } from '../test/render'
import { ProductApiError } from '../api/errors'

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

  async function render(entry = '/login') {
    await act(async () => {
      mountTree(
        <MemoryRouter initialEntries={[entry]}>
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

  it('resumes a paused OAuth authorization at the URL Better Auth returns', async () => {
    const assign = vi.fn()
    const g = globalThis as typeof globalThis & { location?: Location }
    const previous = g.location
    Object.defineProperty(g, 'location', { configurable: true, value: { origin: 'http://localhost', assign } })
    try {
      const oauthQuery = 'client_id=agent&scope=mcp%3Aread%3Aown&sig=signed'
      mocks.signInWithUsername.mockResolvedValue({ status: true, redirectUrl: 'http://localhost/consent?client_id=agent' })
      await render(`/login?${oauthQuery}`)
      change(document.querySelector('#login-identifier') as HTMLInputElement, 'alice')
      change(document.querySelector('#login-password') as HTMLInputElement, 'correct-horse')
      await submit()
      expect(mocks.signInWithUsername).toHaveBeenCalledWith({ username: 'alice', password: 'correct-horse', oauthQuery })
      expect(assign).toHaveBeenCalledWith('http://localhost/consent?client_id=agent')
      expect(mocks.refreshSession).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(g, 'location', { configurable: true, value: previous })
    }
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

  it('replaces the form with first-run setup when the server has no owner', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'first-run' })
    await render()
    const card = document.querySelector('[data-testid="login-owner-missing"]')
    expect(card?.querySelector('h1')?.textContent).toBe('Set up COLP Server')
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/register')
    expect(document.querySelector('#login-identifier')).toBeNull()
  })

  it('validates empty fields inline, on the field, without calling the server', async () => {
    await render()
    await submit()
    const identifier = document.querySelector('#login-identifier') as HTMLInputElement
    const password = document.querySelector('#login-password') as HTMLInputElement
    expect(document.querySelector('#login-identifier-error')?.textContent).toBe('Enter your username or email.')
    expect(document.querySelector('#login-password-error')?.textContent).toBe('Enter your password.')
    expect(identifier.getAttribute('aria-invalid')).toBe('true')
    expect(identifier.getAttribute('aria-describedby')).toBe('login-identifier-error')
    expect(password.getAttribute('aria-invalid')).toBe('true')
    expect(mocks.signInWithUsername).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()

    change(identifier, 'alice')
    expect(document.querySelector('#login-identifier-error')).toBeNull()
    expect(identifier.hasAttribute('aria-invalid')).toBe(false)
  })

  it('sends a rejected sign-in to the error toast and marks both fields', async () => {
    mocks.signInWithUsername.mockRejectedValue(new ProductApiError({
      status: 401,
      code: 'invalid_credentials',
      message: 'The username or password is incorrect.',
      recovery: 'user_action',
    }))
    await render()
    change(document.querySelector('#login-identifier') as HTMLInputElement, 'alice')
    change(document.querySelector('#login-password') as HTMLInputElement, 'wrong-password')
    await submit()
    expect(mocks.toast).toHaveBeenCalledWith('Incorrect username or password.')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('#login-identifier')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#login-password')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement?.id).toBe('login-password')
  })

  it('points an invited person at sign-up only while invites are open', async () => {
    await render()
    expect(document.querySelector('[data-testid="login-invite"]')).toBeNull()
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'invite' })
    await render()
    expect(document.querySelector('[data-testid="login-invite"] a')?.getAttribute('href')).toBe('/register')
  })

  it('fills the reset command with the username typed so far', () => {
    expect(resetPasswordCommand('')).toBe('docker compose exec server colp-server reset-password --username <username>')
    expect(resetPasswordCommand(' ada ')).toBe('docker compose exec server colp-server reset-password --username ada')
    expect(resetPasswordCommand('ada@example.net')).toContain('--username <username>')
    expect(resetPasswordCommand('a; rm -rf /')).toContain('--username <username>')
  })
})
