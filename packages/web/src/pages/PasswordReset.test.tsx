// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasswordReset, OTP_RESEND_COOLDOWN_SECONDS } from './PasswordReset'
import { ProductApiError } from '../api/errors'
import { cleanup, mountTree } from '../test/render'

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
    requestForgetPasswordOtp: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPasswordWithOtp: vi.fn(),
    resetPassword: vi.fn(),
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

function showPasswordFor(id: string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`)!
  expect(input.type).toBe('password')
  const toggle = input.parentElement!.querySelector<HTMLButtonElement>(
    'button[aria-label="Show password"]',
  )!
  act(() => toggle.click())
  expect(input.type).toBe('text')
}

describe('Password reset request', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.toast.success.mockReset()
    mocks.authClient.requestForgetPasswordOtp.mockReset()
    mocks.authClient.requestPasswordReset.mockReset()
  })

  afterEach(() => cleanup())

  function render(initialPath = '/reset-password') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/reset-password" element={<PasswordReset />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  function openLinkMode() {
    act(() => {
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click()
    })
  }

  it('requests a reset code and advances to the code step with a non-enumerating notice', async () => {
    mocks.authClient.requestForgetPasswordOtp.mockResolvedValue({ status: true })
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.requestForgetPasswordOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
    })
    expect(document.querySelector('[role="status"].auth-notice')?.textContent).toBe(
      'If an account exists for ada@example.com, we sent a reset code.',
    )
    expect(document.querySelector('#reset-otp')).not.toBeNull()
    expect(document.activeElement?.id).toBe('reset-otp')
  })

  it('keeps the notice non-enumerating when the request errors with invalid_credentials', async () => {
    mocks.authClient.requestForgetPasswordOtp.mockRejectedValue(
      new ProductApiError({
        status: 401,
        code: 'invalid_credentials',
        message: 'no account found',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ghost@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.body.textContent).not.toContain('no account found')
    expect(document.querySelector('[role="status"].auth-notice')?.textContent).toBe(
      'If an account exists for ghost@example.com, we sent a reset code.',
    )
  })

  it('requests a reset link with a non-enumerating notice', async () => {
    mocks.authClient.requestPasswordReset.mockResolvedValue({ status: true })
    render()
    openLinkMode()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.requestPasswordReset).toHaveBeenCalledWith({
      email: 'ada@example.com',
      redirectTo: '/reset-password',
    })
    expect(document.querySelector('[role="status"].auth-notice')?.textContent).toBe(
      'If an account exists for ada@example.com, we sent a reset link.',
    )
  })

  it('shows the identical notice for a known and an unknown email (no enumeration)', async () => {
    mocks.authClient.requestForgetPasswordOtp.mockResolvedValue({ status: true })
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'known@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    const knownNotice = document.querySelector('[role="status"].auth-notice')?.textContent

    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ghost@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    const ghostNotice = document.querySelector('[role="status"].auth-notice')?.textContent

    expect(ghostNotice).toBe(knownNotice?.replace('known@example.com', 'ghost@example.com'))
    expect(ghostNotice).toContain('If an account exists')
  })

  it('surfaces a typed rate-limit error without advancing', async () => {
    mocks.authClient.requestForgetPasswordOtp.mockRejectedValue(
      new ProductApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: 90,
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many requests. Try again in 90s.',
    )
    expect(document.querySelector('#reset-otp')).toBeNull()
  })

  it('shows a network error message', async () => {
    mocks.authClient.requestForgetPasswordOtp.mockRejectedValue(
      new ProductApiError({
        status: 0,
        code: 'transport_error',
        message: 'Failed to fetch',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ada@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Network error. Check your connection and try again.',
    )
    expect(document.querySelector('[role="status"].auth-notice')).toBeNull()
  })

  it('prefills the email from the login page link', () => {
    render('/reset-password?email=ada%40example.com')
    expect((document.querySelector<HTMLInputElement>('#reset-email')!).value).toBe('ada@example.com')
  })

  it('submits with keyboard activation on the request button', async () => {
    mocks.authClient.requestForgetPasswordOtp.mockResolvedValue({ status: true })
    render()
    change(document.querySelector<HTMLInputElement>('#reset-email')!, 'ada@example.com')
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

    expect(mocks.authClient.requestForgetPasswordOtp).toHaveBeenCalledTimes(1)
  })
})

describe('Password reset completion', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.toast.success.mockReset()
    mocks.authClient.requestForgetPasswordOtp.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.resetPasswordWithOtp.mockReset()
    mocks.authClient.resetPassword.mockReset()
  })

  afterEach(() => cleanup())

  function render(initialPath = '/reset-password') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/reset-password" element={<PasswordReset />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  async function reachOtpStep(email = 'ada@example.com') {
    change(document.querySelector<HTMLInputElement>('#reset-email')!, email)
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
  }

  it('toggles visibility on both password fields at the code step', async () => {
    render()
    await reachOtpStep()
    showPasswordFor('reset-new-password')
    showPasswordFor('reset-confirm-password')
  })

  it('toggles visibility on both password fields from a token link', () => {
    render('/reset-password?token=tok-9')
    showPasswordFor('reset-token-password')
    showPasswordFor('reset-token-confirm')
  })

  it('sets a new password with a code and refreshes session state', async () => {
    mocks.authClient.resetPasswordWithOtp.mockResolvedValue({ status: true })
    render('/reset-password?returnTo=%2Flibrary')
    await reachOtpStep()
    change(document.querySelector<HTMLInputElement>('#reset-otp')!, '445566')
    change(document.querySelector<HTMLInputElement>('#reset-new-password')!, 'fresh-password-789')
    change(document.querySelector<HTMLInputElement>('#reset-confirm-password')!, 'fresh-password-789')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.resetPasswordWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      otp: '445566',
      password: 'fresh-password-789',
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('rejects mismatched passwords before calling the API', async () => {
    render()
    await reachOtpStep()
    change(document.querySelector<HTMLInputElement>('#reset-otp')!, '445566')
    change(document.querySelector<HTMLInputElement>('#reset-new-password')!, 'fresh-password-789')
    change(document.querySelector<HTMLInputElement>('#reset-confirm-password')!, 'different-password')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.resetPasswordWithOtp).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Passwords do not match.')
    expect(document.querySelector('#reset-new-password')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#reset-confirm-password')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#reset-new-password')?.getAttribute('aria-describedby')).toBe('reset-verify-field-error')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
  })

  it('rejects a password below the minimum length before calling the API', async () => {
    render()
    await reachOtpStep()
    change(document.querySelector<HTMLInputElement>('#reset-otp')!, '445566')
    change(document.querySelector<HTMLInputElement>('#reset-new-password')!, 'short')
    change(document.querySelector<HTMLInputElement>('#reset-confirm-password')!, 'short')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.resetPasswordWithOtp).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Password must be at least 8 characters.',
    )
  })

  it('sets a new password from an emailed token link', async () => {
    mocks.authClient.resetPassword.mockResolvedValue({ status: true })
    render('/reset-password?token=tok-9&returnTo=%2Flibrary')
    change(document.querySelector<HTMLInputElement>('#reset-token-password')!, 'fresh-password-789')
    change(document.querySelector<HTMLInputElement>('#reset-token-confirm')!, 'fresh-password-789')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.authClient.resetPassword).toHaveBeenCalledWith({
      token: 'tok-9',
      newPassword: 'fresh-password-789',
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('shows a typed error for an invalid or expired token and never refreshes the session', async () => {
    mocks.authClient.resetPassword.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'This reset token is invalid or has expired',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render('/reset-password?token=expired-token')
    change(document.querySelector<HTMLInputElement>('#reset-token-password')!, 'fresh-password-789')
    change(document.querySelector<HTMLInputElement>('#reset-token-confirm')!, 'fresh-password-789')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'This reset token is invalid or has expired',
    )
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })

  it('shows a typed error for an invalid code', async () => {
    mocks.authClient.resetPasswordWithOtp.mockRejectedValue(
      new ProductApiError({
        status: 401,
        code: 'invalid_credentials',
        message: 'Invalid or expired code',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    render()
    await reachOtpStep()
    change(document.querySelector<HTMLInputElement>('#reset-otp')!, '000000')
    change(document.querySelector<HTMLInputElement>('#reset-new-password')!, 'fresh-password-789')
    change(document.querySelector<HTMLInputElement>('#reset-confirm-password')!, 'fresh-password-789')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Invalid or expired code')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
  })

  it('does not double-submit while resetting', async () => {
    let resolveReset!: (value: { status: boolean }) => void
    mocks.authClient.resetPasswordWithOtp.mockReturnValue(
      new Promise((resolve) => {
        resolveReset = resolve
      }),
    )
    render()
    await reachOtpStep()
    change(document.querySelector<HTMLInputElement>('#reset-otp')!, '445566')
    change(document.querySelector<HTMLInputElement>('#reset-new-password')!, 'fresh-password-789')
    change(document.querySelector<HTMLInputElement>('#reset-confirm-password')!, 'fresh-password-789')
    const form = document.querySelector<HTMLFormElement>('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(mocks.authClient.resetPasswordWithOtp).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveReset({ status: true })
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the code-step resend cooldown with fake timers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      render()
      await reachOtpStep()
      const resend = document.querySelector<HTMLButtonElement>('#reset-resend-otp')!
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
})
