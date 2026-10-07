// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailVerification, OTP_RESEND_COOLDOWN_SECONDS } from './EmailVerification'
import { ProductApiError } from '../api/errors'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'

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
    verifyEmail: vi.fn(),
    verifyEmailWithOtp: vi.fn(),
    sendOtp: vi.fn(),
    sendVerificationEmail: vi.fn(),
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

describe('Email verification link (token)', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.toast.success.mockReset()
    mocks.authClient.verifyEmail.mockReset()
    mocks.authClient.verifyEmailWithOtp.mockReset()
    mocks.authClient.sendOtp.mockReset()
    mocks.authClient.getAuthSession.mockReset().mockResolvedValue(null)
  })

  afterEach(() => cleanup())

  function render(initialPath = '/verify-email') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/verify-email" element={<EmailVerification />} />
            <Route path="/login" element={<div data-testid="page-login" />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('verifies a token from the email link and refreshes the session', async () => {
    mocks.authClient.verifyEmail.mockResolvedValue({ status: true })
    render('/verify-email?token=tok-1&returnTo=%2Flibrary')
    // StrictMode mounts twice, so the effect's async chain runs twice and a
    // fixed number of microtask ticks is not enough to observe the result.
    await waitForDom(() => document.querySelector('[role="status"].auth-success') !== null)

    expect(mocks.authClient.verifyEmail).toHaveBeenCalledWith({ token: 'tok-1' })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[role="status"].auth-success')?.textContent).toContain(
      'Congratulations',
    )
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('shows congratulations when the password-signup callback marks the mailbox verified', async () => {
    render('/verify-email?verified=1&returnTo=%2Flibrary')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.authClient.verifyEmail).not.toHaveBeenCalled()
    expect(document.querySelector('[role="status"].auth-success')?.textContent).toContain(
      'Congratulations',
    )
  })

  it('shows a typed error for an invalid or expired token and never refreshes the session', async () => {
    mocks.authClient.verifyEmail.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'This verification link is invalid or has expired',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render('/verify-email?token=expired-token')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'This verification link is invalid or has expired',
    )
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(document.querySelector('[role="status"].auth-success')).toBeNull()
  })

  it('offers a code-based recovery after a failed token', async () => {
    mocks.authClient.verifyEmail.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'This verification link is invalid or has expired',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.verifyEmailWithOtp.mockResolvedValue({ status: true })
    render('/verify-email?token=expired-token&email=ada%40example.com')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('#verify-email')).not.toBeNull()
    expect((document.querySelector<HTMLInputElement>('#verify-email')!).value).toBe(
      'ada@example.com',
    )
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#verify-otp-code')!, '112233')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.verifyEmailWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      otp: '112233',
    })
    expect(document.querySelector('[role="status"].auth-success')?.textContent).toContain(
      'Congratulations',
    )
  })
})

describe('Email verification code (OTP)', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.toast.success.mockReset()
    mocks.authClient.sendOtp.mockReset()
    mocks.authClient.verifyEmailWithOtp.mockReset()
    mocks.authClient.getAuthSession.mockReset().mockResolvedValue(null)
  })

  afterEach(() => cleanup())

  function render(initialPath = '/verify-email') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/verify-email" element={<EmailVerification />} />
            <Route path="/login" element={<div data-testid="page-login" />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  // P8: /verify-email must stay reachable when signed out. A future auth-guard
  // on this route would hide the form and fail this pin. Do not add a client
  // guard that blocks this page.
  it('renders the verification form when isLoggedIn is false', () => {
    expect(mocks.auth.isLoggedIn).toBe(false)
    expect(mocks.auth.user).toBeNull()
    render('/verify-email')
    expect(document.querySelector('#verify-email')).not.toBeNull()
    expect(document.querySelector('form.auth-form')).not.toBeNull()
    expect(document.body.textContent).toContain('Verify your email')
    expect(document.querySelector('[data-testid="page-login"]')).toBeNull()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })

  it('sends a verification code with a non-enumerating notice', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    render('/verify-email?email=ada%40example.com')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.sendOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      type: 'email-verification',
    })
    expect(document.querySelector('[role="status"].auth-notice')?.textContent).toBe(
      'If an account exists for ada@example.com, we sent a verification code.',
    )
    expect(document.activeElement?.id).toBe('verify-otp-code')
  })

  it('verifies the email with a code and shows the success panel', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.verifyEmailWithOtp.mockResolvedValue({ status: true })
    render('/verify-email?email=ada%40example.com')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#verify-otp-code')!, '998877')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.verifyEmailWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      otp: '998877',
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[role="status"].auth-success')?.textContent).toContain(
      'Congratulations',
    )
  })

  it('shows a typed error on a wrong code and does not navigate', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.verifyEmailWithOtp.mockRejectedValue(
      new ProductApiError({
        status: 401,
        code: 'invalid_credentials',
        message: 'Invalid or expired code',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render('/verify-email?email=ada%40example.com')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#verify-otp-code')!, '000000')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Invalid or expired code')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(document.querySelector('[role="status"].auth-success')).toBeNull()
  })

  it('enforces the resend cooldown with fake timers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      mocks.authClient.sendOtp.mockResolvedValue({ success: true })
      render('/verify-email?email=ada%40example.com')
      change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
      await act(async () => {
        document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        )
      })

      const resend = document.querySelector<HTMLButtonElement>('#verify-resend-otp')!
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

  it('shows a network error when sending fails', async () => {
    mocks.authClient.sendOtp.mockRejectedValue(
      new ProductApiError({
        status: 0,
        code: 'transport_error',
        message: 'Failed to fetch',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }),
    )
    render('/verify-email?email=ada%40example.com')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Network error. Check your connection and try again.',
    )
    expect(document.querySelector('#verify-otp-code')).toBeNull()
  })

  it('navigates a signed-in user to the returnTo from the success panel', async () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = { name: 'Ada' }
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.verifyEmailWithOtp.mockResolvedValue({ status: true })
    render('/verify-email?email=ada%40example.com&returnTo=%2Flibrary')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#verify-otp-code')!, '998877')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    const continueButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Continue')!
    expect(continueButton.textContent).toBe('Continue')
    await act(async () => {
      continueButton.click()
    })
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('links to sign in from the success panel when signed out', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.verifyEmailWithOtp.mockResolvedValue({ status: true })
    render('/verify-email?email=ada%40example.com')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#verify-otp-code')!, '998877')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="status"].auth-success')?.textContent).toContain(
      'Congratulations',
    )
    expect(document.querySelector('a[href^="/login"]')).not.toBeNull()
  })

  it('submits with keyboard activation on the verify button', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.verifyEmailWithOtp.mockResolvedValue({ status: true })
    render('/verify-email?email=ada%40example.com')
    change(document.querySelector<HTMLInputElement>('#verify-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    change(document.querySelector<HTMLInputElement>('#verify-otp-code')!, '998877')
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

    expect(mocks.authClient.verifyEmailWithOtp).toHaveBeenCalledTimes(1)
  })
})
