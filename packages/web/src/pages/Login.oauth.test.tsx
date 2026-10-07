// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import {
  change,
  cleanup,
  loginCardText,
  mocks,
  renderLogin,
  resetLoginMocks,
  signInButton,
  submitForm,
} from './Login.test-helper'

vi.mock('../auth/AuthContext', async () => {
  const { mocks } = await import('./Login.test-mocks')
  return { useAuth: () => mocks.auth }
})
vi.mock('../components/AppToast', async () => {
  const { mocks } = await import('./Login.test-mocks')
  return { useToast: () => mocks.toast }
})
vi.mock('../api/authClient', async () => {
  const { mocks } = await import('./Login.test-mocks')
  return { authClient: mocks.authClient }
})

describe('Login provider icons', () => {
  let restoreLocation: () => void

  beforeEach(() => {
    resetLoginMocks()
    const g = globalThis as typeof globalThis & { location?: { origin: string; assign?: (url: string) => void } }
    const previous = g.location
    Object.defineProperty(g, 'location', {
      configurable: true,
      value: { origin: 'http://localhost', assign: vi.fn() },
    })
    restoreLocation = () => {
      if (previous === undefined) {
        Object.defineProperty(g, 'location', { configurable: true, value: undefined })
      } else {
        Object.defineProperty(g, 'location', { configurable: true, value: previous })
      }
    }
  })

  afterEach(() => {
    cleanup()
    restoreLocation()
  })

    it('starts Google sign-in through the server and navigates the browser to the provider', async () => {
    mocks.authClient.startOAuth.mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz',
      redirect: true,
    })
    renderLogin('/login?returnTo=%2Flibrary')
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Continue with Google"]')!
    expect(button.textContent?.trim()).toBe('G')
    await act(async () => {
      button.click()
    })

    expect(mocks.authClient.startOAuth).toHaveBeenCalledWith({
      providerId: 'google',
      callbackURL: '/library',
      errorCallbackURL: '/auth/recovery?returnTo=%2Flibrary',
      newUserCallbackURL: '/onboarding',
    })
    const assign = (globalThis as { location?: { assign?: (url: string) => void } }).location?.assign
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=xyz')
    expect(document.body.textContent).not.toContain('client_secret')
  })

  it('starts GitHub sign-in with the same safe callback contract', async () => {
    mocks.authClient.startOAuth.mockResolvedValue({
      url: 'https://github.com/login/oauth/authorize?state=abc',
      redirect: true,
    })
    renderLogin()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Continue with GitHub"]')!.click()
    })

    expect(mocks.authClient.startOAuth).toHaveBeenCalledWith({
      providerId: 'github',
      callbackURL: '/library',
      errorCallbackURL: '/auth/recovery?returnTo=%2Flibrary',
      newUserCallbackURL: '/onboarding',
    })
  })

  it('never forwards a cross-origin returnTo to the OAuth start', async () => {
    mocks.authClient.startOAuth.mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz',
      redirect: true,
    })
    renderLogin('/login?returnTo=https%3A%2F%2Fevil.example%2Fphish')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Continue with Google"]')!.click()
    })

    expect(mocks.authClient.startOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: '/library', errorCallbackURL: '/auth/recovery?returnTo=%2Flibrary' }),
    )
    const assign = (globalThis as { location?: { assign?: (url: string) => void } }).location?.assign
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=xyz')
  })

  it('toasts when the OAuth start fails', async () => {
    mocks.authClient.startOAuth.mockRejectedValue(
      new ProductApiError({
        status: 503,
        code: 'email_delivery_unavailable',
        message: 'Email delivery is temporarily unavailable',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    renderLogin()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Continue with Google"]')!.click()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Email delivery is temporarily unavailable. Try again shortly.',
    )
    expect(document.querySelector('[role="alert"]')).toBeNull()
    const assign = (globalThis as { location?: { assign?: (url: string) => void } }).location?.assign
    expect(assign).not.toHaveBeenCalled()
  })
})

describe('Login layout, callback errors and returnTo hardening', () => {

  beforeEach(() => {
    resetLoginMocks()
  })

  afterEach(() => cleanup())

    it('keeps method tabs to Password and Email code, with provider icons below Sign in', () => {
    renderLogin()
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
    expect(tabs).toEqual(['Password', 'Email code'])
    expect(document.body.textContent).not.toContain(
      'Sign in with your email and password, an email code, or a connected provider.',
    )
    const form = document.querySelector('form')!
    const oauth = document.querySelector('[data-testid="auth-oauth-row"]')!
    expect(form.contains(oauth)).toBe(false)
    expect(
      signInButton().compareDocumentPosition(oauth) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(document.querySelector('[aria-label="Continue with Google"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Continue with GitHub"]')).not.toBeNull()
  })

  it('exposes username and current-password autocomplete so password managers can fill from the email field', () => {
    renderLogin()
    const email = document.querySelector<HTMLInputElement>('#login-email')!
    const password = document.querySelector<HTMLInputElement>('#login-password')!
    const form = document.querySelector<HTMLFormElement>('form')!
    expect(form.method).toBe('post')
    expect(email.autocomplete).toBe('username')
    expect(email.name).toBe('username')
    expect(password.autocomplete).toBe('current-password')
    expect(password.name).toBe('password')
  })

  it('keeps Forgot password and both secret fields mounted when switching methods', () => {
    renderLogin()
    expect(document.querySelector('a[href^="/reset-password"]')?.textContent).toContain('Forgot password?')
    expect(document.querySelector('[data-mode="password"]')?.hasAttribute('data-inactive')).toBe(false)
    expect(document.querySelector('[data-mode="otp"]')?.hasAttribute('data-inactive')).toBe(true)

    act(() => {
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click()
    })

    expect(document.querySelector('a[href^="/reset-password"]')?.textContent).toContain('Forgot password?')
    expect(document.querySelector('[data-mode="password"]')?.hasAttribute('data-inactive')).toBe(true)
    expect(document.querySelector('[data-mode="otp"]')?.hasAttribute('data-inactive')).toBe(false)
    expect(document.querySelector('#login-password')).not.toBeNull()
    expect(document.querySelector('#login-otp-code')).not.toBeNull()
    expect(document.querySelector('#login-send-otp')).not.toBeNull()
    expect(document.querySelector('[data-testid="auth-oauth-row"]')).not.toBeNull()
  })

  it('connects method tabs to secret panels and moves between them with arrow keys', () => {
    renderLogin()
    const [passwordTab, otpTab] = document.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(passwordTab?.getAttribute('aria-controls')).toBe('login-panel-password')
    expect(otpTab?.getAttribute('aria-controls')).toBe('login-panel-otp')
    expect(document.getElementById('login-panel-password')?.getAttribute('role')).toBe('tabpanel')
    expect(document.getElementById('login-panel-otp')?.getAttribute('role')).toBe('tabpanel')
    passwordTab!.focus()
    act(() => {
      passwordTab!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      )
    })
    expect(otpTab?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-mode="otp"]')?.hasAttribute('data-inactive')).toBe(false)
    // R15-36: arrow keys roam the tablist; the code field must not steal focus.
    expect(document.activeElement).toBe(otpTab)
  })

  it('does not insert an alert into the card when auth=failed', () => {
    renderLogin('/login?auth=failed')
    const title = document.querySelector('h1')!
    expect(title.nextElementSibling?.classList.contains('auth-tabs')).toBe(true)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(loginCardText()).not.toContain('Sign-in failed.')
  })

  it('toasts when the OAuth callback reports auth=failed', () => {
    renderLogin('/login?auth=failed')
    expect(mocks.toast.error).toHaveBeenCalledTimes(1)
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Sign-in failed. Your session was not created. Please try again.',
    )
  })

  it('toasts a restart notice when the OAuth callback reports auth=restart', () => {
    renderLogin('/login?auth=restart')
    expect(mocks.toast.toast).toHaveBeenCalledWith('Your previous session ended. Please sign in again.')
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('falls back to /library for a cross-origin returnTo on password sign-in', async () => {
    mocks.authClient.signInWithPassword.mockResolvedValue({ status: true })
    renderLogin('/login?returnTo=https%3A%2F%2Fevil.example%2Fphish')
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    await act(async () => {
      submitForm()
    })

    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: '/library' }),
    )
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('falls back to /library for protocol-relative and backslash returnTo values', async () => {
    mocks.authClient.signInWithPassword.mockResolvedValue({ status: true })
    renderLogin('/login?returnTo=%2F%2Fevil.example%2Fphish')
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    await act(async () => {
      submitForm()
    })
    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: '/library' }),
    )
  })

  it('keeps the password form mounted after a failed submit (no silent navigation)', async () => {
    mocks.authClient.signInWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 401,
        code: 'invalid_credentials',
        message: 'Invalid email or password',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    await act(async () => {
      submitForm()
    })
    expect(mocks.toast.error).toHaveBeenCalledWith('Incorrect email or password.')
    expect(document.querySelector('#login-server-error')).toBeNull()
    expect(document.querySelector('#login-password')).not.toBeNull()
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })
})
