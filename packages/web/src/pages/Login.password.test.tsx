// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { findButtonByName } from '../test/render'
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

describe('Login password mode', () => {

  beforeEach(() => {
    resetLoginMocks()
  })

  afterEach(() => cleanup())

    it('signs in with a password and redirects to the safe returnTo', async () => {
    mocks.authClient.signInWithPassword.mockResolvedValue({ status: true })
    renderLogin('/login?returnTo=%2Flibrary')
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'correct-horse-battery')
    await act(async () => {
      submitForm()
    })

    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'correct-horse-battery',
      callbackURL: '/library',
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('shows the controlled approval reason once and ignores arbitrary reason text', () => {
    renderLogin('/login?returnTo=%2Fapprovals%2Fplan-1&reason=approval_required')
    expect(mocks.toast.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast.toast).toHaveBeenCalledWith(
      'Please sign in before authorizing this MCP change.',
    )
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    expect(mocks.toast.toast).toHaveBeenCalledTimes(1)

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    mocks.toast.toast.mockReset()
    renderLogin('/login?reason=render%20this%20attacker%20text')
    expect(mocks.toast.toast).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('attacker text')
  })

  it('returns to the exact approval detail after password sign-in', async () => {
    mocks.authClient.signInWithPassword.mockResolvedValue({ status: true })
    renderLogin('/login?returnTo=%2Fapprovals%2Fplan-1%3Fsource%3Dmcp%23review&reason=approval_required')
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'correct-horse-battery')
    await act(async () => {
      submitForm()
    })
    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: '/approvals/plan-1?source=mcp#review' }),
    )
    expect(document.querySelector('[data-testid="page-approval"]')).not.toBeNull()
  })

  /* Server failures use the error toast (auto-dismiss, cleared on navigation).
     Suspect fields stay marked so the form still signals where to retype. */
  it('toasts a wrong password, marks the fields, and never sets a session', async () => {
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
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'wrong-password')
    await act(async () => {
      submitForm()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('Incorrect email or password.')
    expect(document.querySelector('#login-server-error')).toBeNull()
    expect(loginCardText()).not.toContain('Incorrect email or password.')
    expect(document.querySelector('#login-email')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#login-password')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#login-password')?.getAttribute('aria-describedby')).toBeNull()
    expect(document.activeElement?.id).toBe('login-password')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
    expect(document.querySelector('#login-email')).not.toBeNull()
  })

  it('returns focus to Sign in after a server failure instead of <body> (R15-36)', async () => {
    mocks.authClient.signInWithPassword.mockRejectedValueOnce(
      new ProductApiError({
        status: 503,
        code: 'internal_error',
        message: 'down',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }),
    )
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    await act(async () => {
      submitForm()
    })
    expect(mocks.toast.error).toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('login-submit')
  })

  it('clears invalid marks once the user edits the password', async () => {
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
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'wrong-password')
    await act(async () => {
      submitForm()
    })
    expect(mocks.toast.error).toHaveBeenCalledWith('Incorrect email or password.')
    expect(document.querySelector('#login-password')?.getAttribute('aria-invalid')).toBe('true')

    change(document.querySelector<HTMLInputElement>('#login-password')!, 'second-try')
    expect(document.querySelector('#login-server-error')).toBeNull()
    expect(document.querySelector('#login-password')?.getAttribute('aria-invalid')).toBeNull()
    expect(document.querySelector('#login-email')?.getAttribute('aria-invalid')).toBeNull()
  })

  it('toggles password visibility with an accessible eye button', () => {
    renderLogin()
    const password = document.querySelector<HTMLInputElement>('#login-password')!
    expect(password.type).toBe('password')
    const toggle = findButtonByName('Show password')
    expect(toggle.querySelector('svg')?.getAttribute('data-icon')).toBe('eye')
    act(() => toggle.click())
    expect(password.type).toBe('text')
    expect(toggle.getAttribute('aria-label')).toBe('Hide password')
    expect(toggle.querySelector('svg')?.getAttribute('data-icon')).toBe('eye-off')
    act(() => toggle.click())
    expect(password.type).toBe('password')
    expect(toggle.getAttribute('aria-label')).toBe('Show password')
  })

  it('toasts the same non-enumerating message for an unknown email', async () => {
    mocks.authClient.signInWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 401,
        code: 'invalid_credentials',
        message: 'no account exists for this email',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ghost@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'whatever1')
    await act(async () => {
      submitForm()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('Incorrect email or password.')
    expect(loginCardText()).not.toContain('Incorrect email or password.')
    expect(document.body.textContent).not.toContain('no account exists')
  })

  it('toasts a network error when the transport fails', async () => {
    mocks.authClient.signInWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 0,
        code: 'transport_error',
        message: 'Failed to fetch',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }),
    )
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    await act(async () => {
      submitForm()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('Network error. Check your connection and try again.')
    expect(document.querySelector('#login-server-error')).toBeNull()
    // Transport failure is not a field error: no input is marked invalid.
    expect(document.querySelector('#login-password')?.getAttribute('aria-invalid')).toBeNull()
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
  })

  it('toasts the typed Product API 404 copy, never raw server text', async () => {
    mocks.authClient.signInWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 404,
        code: 'resource_not_found',
        message: 'Product API error (404)',
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

    expect(mocks.toast.error).toHaveBeenCalledWith('Resource not found or not accessible.')
    expect(document.body.textContent).not.toContain('Product API error (404)')
    expect(loginCardText()).not.toContain('Resource not found')
  })

  it('toasts verification_required without leaving the form', async () => {
    mocks.authClient.signInWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 403,
        code: 'verification_required',
        message: 'Email verification is required to complete this action.',
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

    expect(mocks.toast.error).toHaveBeenCalledWith('Please verify your email before signing in.')
    expect(document.querySelector('#login-server-error')).toBeNull()
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
  })

  it('does not double-submit while a sign-in is in flight', async () => {
    let resolveSignIn!: (value: { status: boolean }) => void
    mocks.authClient.signInWithPassword.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve
      }),
    )
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    const form = document.querySelector<HTMLFormElement>('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledTimes(1)
    expect(signInButton().disabled).toBe(true)
    expect(signInButton().textContent).toBe('Signing in…')

    await act(async () => {
      resolveSignIn({ status: true })
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('submits with keyboard activation on the submit button', async () => {
    mocks.authClient.signInWithPassword.mockResolvedValue({ status: true })
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'password-1')
    const button = signInButton()
    button.focus()
    expect(document.activeElement).toBe(button)
    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    act(() => button.click())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledTimes(1)
  })

  it('keeps Sign in enabled and shows a field error until a password is entered', async () => {
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    expect(signInButton().disabled).toBe(false)
    await act(async () => {
      submitForm()
    })
    expect(mocks.authClient.signInWithPassword).not.toHaveBeenCalled()
    expect(document.querySelector('#login-password')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#login-secret-error')?.textContent).toBe('Enter your password.')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'short')
    expect(document.querySelector('#login-secret-error')).toBeNull()
    expect(signInButton().disabled).toBe(false)
  })

  it('submits a short password so the server can accept a legacy credential', async () => {
    mocks.authClient.signInWithPassword.mockResolvedValue({ status: true })
    renderLogin()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-password')!, 'nope')
    await act(async () => {
      submitForm()
    })
    expect(mocks.authClient.signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'nope',
      callbackURL: '/library',
    })
  })

  it('redirects a logged-in visitor away from the login page', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = { name: 'Ada' }
    renderLogin('/login?returnTo=%2Flibrary')
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('keeps the form open for a controlled approval reason during a stale logged-in race', () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = { name: 'Ada' }
    renderLogin('/login?returnTo=%2Fapprovals%2Fplan-1&reason=approval_required')
    expect(document.querySelector('form')).not.toBeNull()
    expect(document.querySelector('[data-testid="page-approval"]')).toBeNull()
  })

  it('keeps returnTo on the Create an account link', () => {
    renderLogin('/login?returnTo=%2Fc%2Fx')
    expect(document.querySelector('a[href="/register?returnTo=%2Fc%2Fx"]')?.textContent).toBe('Create an account')
  })
})
