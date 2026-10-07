// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Register, OTP_RESEND_COOLDOWN_SECONDS } from './Register'
import { ProductApiError } from '../api/errors'
import { cleanup, findButtonByName, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as { name: string } | null,
    isLoggedIn: false,
    bootstrapping: false,
    csrfToken: null as string | null,
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  toast: {
    toast: vi.fn<(msg: string, variant?: string) => void>(),
    success: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  },
  authClient: {
    signUpWithPassword: vi.fn(),
    sendOtp: vi.fn(),
    signInWithOtp: vi.fn(),
    startOAuth: vi.fn(),
    getAuthSession: vi.fn(),
  },
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../components/AppToast', () => ({ useToast: () => mocks.toast }))
vi.mock('../api/authClient', () => ({ authClient: mocks.authClient }))

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Register password signup', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.toast.success.mockReset()
    mocks.toast.error.mockReset()
    mocks.authClient.signUpWithPassword.mockReset()
    mocks.authClient.getAuthSession.mockReset().mockResolvedValue({
      session: {
        id: 's-1', userId: 'u-1',
        expiresAt: '2026-07-26T00:00:00Z', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
      user: { id: 'u-1', email: 'ada@example.com', emailVerified: false, name: 'Ada Lovelace', image: null },
    })
  })

  afterEach(() => cleanup())

  function render(initialPath = '/register') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/register" element={<Register />} />
            <Route path="/login" element={<div data-testid="page-login" />} />
            <Route path="/verify-email" element={<div data-testid="page-verify" />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('creates an account, refreshes the session and prompts for email verification', async () => {
    mocks.authClient.signUpWithPassword.mockResolvedValue({ status: true })
    render('/register?returnTo=%2Flibrary')
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.signUpWithPassword).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct-horse-battery',
      callbackURL: '/verify-email?verified=1&returnTo=%2Flibrary',
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="auth-pending"] h2')?.textContent).toBe('Check your email')
    // R15-36: the focused form was replaced; focus moves to the new heading.
    expect(document.activeElement).toBe(document.querySelector('[data-testid="auth-pending"] h2'))
    expect(document.body.textContent).toContain('ada@example.com')
    const codeLink = document.querySelector<HTMLAnchorElement>('[data-testid="auth-pending"] a[href*="/verify-email"]')
    expect(codeLink?.getAttribute('href')).toBe(
      '/verify-email?email=ada%40example.com&returnTo=%2Flibrary',
    )
    expect(document.body.textContent).not.toContain('Continue')
  })

  it('shows a generic non-enumerating error when the email is already registered', async () => {
    mocks.authClient.signUpWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 409,
        code: 'user_already_exists',
        message: 'User already exists',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    // The server's enumerating text must never reach the UI.
    expect(document.body.textContent).not.toContain('already exists')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'We could not create your account. If you already have an account, sign in instead.',
    )
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="auth-pending"]')).toBeNull()
  })

  it('shows a network error when the transport fails', async () => {
    mocks.authClient.signUpWithPassword.mockRejectedValue(
      new ProductApiError({
        status: 0,
        code: 'transport_error',
        message: 'Failed to fetch',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Network error. Check your connection and try again.',
    )
    expect(document.querySelector('[data-testid="auth-pending"]')).toBeNull()
  })

  it('toggles password visibility with an accessible eye button', () => {
    render()
    const password = document.querySelector<HTMLInputElement>('#register-password')!
    expect(password.type).toBe('password')
    const toggle = findButtonByName('Show password')
    act(() => toggle.click())
    expect(password.type).toBe('text')
    expect(toggle.getAttribute('aria-label')).toBe('Hide password')
    act(() => toggle.click())
    expect(password.type).toBe('password')
  })

  it('blocks empty password signup with field errors instead of calling the API', async () => {
    render()
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.signUpWithPassword).not.toHaveBeenCalled()
    expect(document.querySelector('#register-name')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#register-email')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#register-password')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#register-name-error')?.textContent).toBe('Enter your name.')
    expect(document.querySelector('#register-email-error')?.textContent).toBe('Enter your email.')
    expect(document.querySelector('#register-password-error')?.textContent).toBe('Enter a password.')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'short12')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('#register-password-error')?.textContent).toBe('Password must be at least 8 characters.')
    expect(mocks.authClient.signUpWithPassword).not.toHaveBeenCalled()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada')
    expect(document.querySelector('#register-name-error')).toBeNull()
    expect(document.querySelector('#register-email-error')?.textContent).toBe('Enter your email.')
  })

  it('does not double-submit while the account is being created', async () => {
    let resolveSignUp!: (value: { status: boolean }) => void
    mocks.authClient.signUpWithPassword.mockReturnValue(
      new Promise((resolve) => {
        resolveSignUp = resolve
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    const form = document.querySelector<HTMLFormElement>('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(mocks.authClient.signUpWithPassword).toHaveBeenCalledTimes(1)
    const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Creating…')

    await act(async () => {
      resolveSignUp({ status: true })
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('submits with keyboard activation on the create button', async () => {
    mocks.authClient.signUpWithPassword.mockResolvedValue({ status: true })
    render()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!
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

    expect(mocks.authClient.signUpWithPassword).toHaveBeenCalledTimes(1)
  })

  it('does not offer Continue on unverified pending even when a session mock claims logged-in', async () => {
    mocks.authClient.signUpWithPassword.mockResolvedValue({ status: true })
    mocks.auth.isLoggedIn = true
    mocks.auth.user = { name: 'Ada Lovelace' }
    render()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('[data-testid="auth-pending"] h2')?.textContent).toBe('Check your email')
    expect(document.body.textContent).not.toContain('Continue')
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })

  it('shows congratulations and hides the code path once the mailbox is verified', async () => {
    mocks.authClient.signUpWithPassword.mockResolvedValue({ status: true })
    mocks.authClient.getAuthSession.mockResolvedValue({
      session: {
        id: 's-1', userId: 'u-1',
        expiresAt: '2026-07-26T00:00:00Z', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
      user: { id: 'u-1', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace', image: null },
    })
    render()
    change(document.querySelector<HTMLInputElement>('#register-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#register-password')!, 'correct-horse-battery')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Congratulations')
    expect(document.body.textContent).not.toContain('Enter the verification code instead')
    expect(document.querySelector('[data-testid="auth-pending"] button')?.textContent).toBe('Continue')
  })
})

describe('Register OTP signup (verified email)', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.toast.success.mockReset()
    mocks.authClient.sendOtp.mockReset()
    mocks.authClient.signInWithOtp.mockReset()
    mocks.authClient.getAuthSession.mockReset().mockResolvedValue(null)
  })

  afterEach(() => cleanup())

  function render(initialPath = '/register') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/register" element={<Register />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
            <Route path="/onboarding" element={<div data-testid="page-onboarding" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  function openOtpMode() {
    act(() => {
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click()
    })
  }

  it('moves focus to the OTP name field when the email-code step is shown', () => {
    render()
    openOtpMode()
    expect(document.activeElement?.id).toBe('register-otp-name')
  })

  it('blocks empty OTP send with field errors instead of calling the API', async () => {
    render()
    openOtpMode()
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.sendOtp).not.toHaveBeenCalled()
    expect(document.querySelector('#register-otp-name')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#register-otp-email')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#register-otp-name-error')?.textContent).toBe('Enter your name.')
  })

  it('moves focus to the sign-up code field once it appears', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    render()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement?.id).toBe('register-otp-code')
  })

  it('puts the sent-code notice in the one card feedback slot, not inside the form', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    render()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    const notice = document.querySelector('[role="status"]')
    expect(notice?.textContent).toBe('We sent a sign-up code to verified@example.com.')
    expect(notice?.classList.contains('auth-feedback')).toBe(true)
    expect(notice?.closest('form')).toBeNull()
    // The slot sits above the method tabs, where an error would also land.
    expect(notice?.compareDocumentPosition(document.querySelector('[role="tablist"]')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('shows an error in place of the notice instead of stacking both', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.signInWithOtp.mockRejectedValue(new Error('nope'))
    render()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(1)

    change(document.querySelector<HTMLInputElement>('#register-otp-code')!, '000000')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    const slots = document.querySelectorAll('[role="alert"], [role="status"]')
    expect(slots).toHaveLength(1)
    expect(slots[0]?.getAttribute('role')).toBe('alert')
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('sends a code and signs up a verified email with it (controlled OTP signup)', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.signInWithOtp.mockResolvedValue({ status: true })
    render('/register?returnTo=%2Flibrary')
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.sendOtp).toHaveBeenCalledWith({
      email: 'verified@example.com',
      type: 'sign-in',
      intent: 'sign-up',
    })
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'We sent a sign-up code to verified@example.com.',
    )
    expect(document.body.textContent).not.toContain('If an account exists')
    change(document.querySelector<HTMLInputElement>('#register-otp-code')!, '654321')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.signInWithOtp).toHaveBeenCalledWith({
      email: 'verified@example.com',
      otp: '654321',
      name: 'Ada Lovelace',
      intent: 'sign-up',
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('shows a typed error when the code is wrong and does not navigate', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.signInWithOtp.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'That code did not work. Try again.',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#register-otp-code')!, '000000')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('That code did not work. Try again.')
    expect(document.body.textContent).not.toContain('If you already have an account')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })

  it('shows a typed rate-limit error when sending is throttled', async () => {
    mocks.authClient.sendOtp.mockRejectedValue(
      new ProductApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: 60,
      }),
    )
    render()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many requests. Try again in 60s.',
    )
    expect(document.querySelector('#register-otp-code')).toBeNull()
  })

  it('maps an already-registered mailbox to the same copy as password signup', async () => {
    // P6: Register keeps the already-registered copy (accepted enumeration oracle).
    mocks.authClient.sendOtp.mockRejectedValue(
      new ProductApiError({
        status: 401,
        code: 'invalid_credentials',
        message: 'The email or password is incorrect.',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'taken@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'We could not create your account. If you already have an account, sign in instead.',
    )
    expect(document.body.textContent).not.toContain('If an account exists')
  })

  it('enforces the resend cooldown with fake timers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      mocks.authClient.sendOtp.mockResolvedValue({ success: true })
      render()
      openOtpMode()
      change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
      change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
      await act(async () => {
        document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        )
      })

      const resend = document.querySelector<HTMLButtonElement>('#register-resend-otp')!
      expect(resend.disabled).toBe(true)
      expect(resend.textContent).toBe(`Resend code in ${OTP_RESEND_COOLDOWN_SECONDS}s`)
      act(() => {
        vi.advanceTimersByTime(OTP_RESEND_COOLDOWN_SECONDS * 1000)
      })
      expect(resend.disabled).toBe(false)
      expect(resend.textContent).toBe('Resend code')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to /onboarding for a cross-origin returnTo (R7-06)', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.signInWithOtp.mockResolvedValue({ status: true })
    render('/register?returnTo=https%3A%2F%2Fevil.example%2Fphish')
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#register-otp-name')!, 'Ada Lovelace')
    change(document.querySelector<HTMLInputElement>('#register-otp-email')!, 'verified@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#register-otp-code')!, '654321')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.signInWithOtp).toHaveBeenCalledWith({
      email: 'verified@example.com',
      otp: '654321',
      name: 'Ada Lovelace',
      intent: 'sign-up',
    })
    expect(document.querySelector('[data-testid="page-onboarding"]')).not.toBeNull()
  })
})
