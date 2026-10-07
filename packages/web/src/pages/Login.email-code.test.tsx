// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { OTP_LENGTH, OTP_RESEND_COOLDOWN_SECONDS } from './Login'
import {
  change,
  cleanup,
  loginCardText,
  mocks,
  renderLogin,
  resetLoginMocks,
  sendOtpButton,
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

describe('Login email-code mode', () => {

  beforeEach(() => {
    resetLoginMocks()
  })

  afterEach(() => cleanup())

    function openOtpMode() {
    act(() => {
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click()
    })
  }

  it('moves focus to the sign-in code field when the email-code step is shown', () => {
    renderLogin()
    expect(document.activeElement?.id).not.toBe('login-password')
    openOtpMode()
    expect(document.activeElement?.id).toBe('login-otp-code')
    act(() => {
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0]!.click()
    })
    expect(document.activeElement?.id).toBe('login-password')
  })

  it('sends a sign-in code with a non-enumerating toast and starts a 20s cooldown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      mocks.authClient.sendOtp.mockResolvedValue({ success: true })
      renderLogin()
      openOtpMode()
      change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
      await act(async () => {
        sendOtpButton().click()
      })

      expect(mocks.authClient.sendOtp).toHaveBeenCalledWith({
        email: 'ada@example.com',
        type: 'sign-in',
      })
      // P6: Login must omit signup intent so send stays non-enumerating.
      expect(mocks.authClient.sendOtp.mock.calls[0]?.[0]).not.toHaveProperty('intent')
      expect(JSON.stringify(mocks.authClient.sendOtp.mock.calls[0]?.[0])).not.toContain('sign-up')
      expect(mocks.toast.toast).toHaveBeenCalledWith(
        'If an account exists for ada@example.com, a sign-in code was sent.',
      )
      expect(document.querySelector('#login-server-error')).toBeNull()
      expect(mocks.toast.error).not.toHaveBeenCalled()
      expect(sendOtpButton().disabled).toBe(true)
      expect(sendOtpButton().textContent).toBe(`Resend code in ${OTP_RESEND_COOLDOWN_SECONDS}s`)
      expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('login sendOtp never sends signup intent (P6 non-enumerating send)', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ghost@example.com')
    await act(async () => {
      sendOtpButton().click()
    })

    expect(mocks.authClient.sendOtp).toHaveBeenCalledTimes(1)
    expect(mocks.authClient.sendOtp).toHaveBeenCalledWith({
      email: 'ghost@example.com',
      type: 'sign-in',
    })
    expect(mocks.authClient.sendOtp.mock.calls[0]?.[0]).not.toHaveProperty('intent')
    expect(JSON.stringify(mocks.authClient.sendOtp.mock.calls[0]?.[0])).not.toContain('sign-up')
    expect(mocks.toast.toast).toHaveBeenCalledWith(
      'If an account exists for ghost@example.com, a sign-in code was sent.',
    )
    expect(document.body.textContent).not.toContain('already have an account')
    expect(document.body.textContent).not.toContain('We could not create your account')
  })

  it('allows resend only after the cooldown elapses', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      mocks.authClient.sendOtp.mockResolvedValue({ success: true })
      renderLogin()
      openOtpMode()
      change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
      await act(async () => {
        sendOtpButton().click()
      })

      act(() => {
        vi.advanceTimersByTime(OTP_RESEND_COOLDOWN_SECONDS * 500)
      })
      expect(sendOtpButton().disabled).toBe(true)

      act(() => {
        vi.advanceTimersByTime(OTP_RESEND_COOLDOWN_SECONDS * 500)
      })
      expect(sendOtpButton().disabled).toBe(false)
      expect(sendOtpButton().textContent).toBe('Send code')

      await act(async () => {
        sendOtpButton().click()
      })
      expect(mocks.authClient.sendOtp).toHaveBeenCalledTimes(2)
      expect(sendOtpButton().disabled).toBe(true)
      expect(sendOtpButton().textContent).toBe(`Resend code in ${OTP_RESEND_COOLDOWN_SECONDS}s`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('verifies the code through the shared Sign in button and redirects', async () => {
    mocks.authClient.sendOtp.mockResolvedValue({ success: true })
    mocks.authClient.signInWithOtp.mockResolvedValue({ status: true })
    renderLogin('/login?returnTo=%2Flibrary')
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    await act(async () => {
      sendOtpButton().click()
    })
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '123456')
    expect('123456'.length).toBe(OTP_LENGTH)
    await act(async () => {
      submitForm()
    })

    expect(mocks.authClient.signInWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      otp: '123456',
    })
    expect(mocks.authClient.signInWithOtp.mock.calls[0]?.[0]).not.toHaveProperty('intent')
    expect(mocks.authClient.signInWithOtp.mock.calls[0]?.[0]).not.toHaveProperty('name')
    expect(mocks.auth.refreshSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('toasts a wrong code without setting a session', async () => {
    mocks.authClient.signInWithOtp.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'That code did not work. Try again.',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '000000')
    await act(async () => {
      submitForm()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('That code did not work. Try again.')
    expect(document.querySelector('#login-server-error')).toBeNull()
    expect(loginCardText()).not.toContain('That code did not work.')
    expect(document.querySelector('#login-otp-code')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement?.id).toBe('login-otp-code')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })

  it('toasts when the code expired', async () => {
    mocks.authClient.signInWithOtp.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'That code has expired. Request a new one.',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '999999')
    await act(async () => {
      submitForm()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('That code has expired. Request a new one.')
    expect(loginCardText()).not.toContain('That code has expired.')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
  })

  it('toasts verification_required on OTP occupancy', async () => {
    mocks.authClient.signInWithOtp.mockRejectedValue(
      new ProductApiError({
        status: 403,
        code: 'verification_required',
        message: 'Email verification is required to complete this action.',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }),
    )
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '123456')
    await act(async () => {
      submitForm()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('Please verify your email before signing in.')
    expect(document.querySelector('#login-server-error')).toBeNull()
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })

  it('toasts a rate-limit error when sending is throttled', async () => {
    mocks.authClient.sendOtp.mockRejectedValue(
      new ProductApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: 45,
      }),
    )
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    await act(async () => {
      sendOtpButton().click()
    })

    expect(mocks.toast.error).toHaveBeenCalledWith('Too many requests. Try again in 45s.')
    expect(loginCardText()).not.toContain('Too many requests.')
    expect(document.querySelector('#login-otp-code')).not.toBeNull()
  })

  it('keeps Sign in enabled and shows a field error until the code is exactly six digits', async () => {
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    expect(signInButton().disabled).toBe(false)
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '12345')
    await act(async () => {
      submitForm()
    })
    expect(mocks.authClient.signInWithOtp).not.toHaveBeenCalled()
    expect(document.querySelector('#login-otp-code')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#login-secret-error')?.textContent).toBe('Enter the 6-digit sign-in code.')
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '123456')
    expect(document.querySelector('#login-secret-error')).toBeNull()
    expect(signInButton().disabled).toBe(false)
  })

  it('does not submit an incomplete email code', async () => {
    renderLogin()
    openOtpMode()
    change(document.querySelector<HTMLInputElement>('#login-email')!, 'ada@example.com')
    change(document.querySelector<HTMLInputElement>('#login-otp-code')!, '123')
    await act(async () => {
      submitForm()
    })
    expect(mocks.authClient.signInWithOtp).not.toHaveBeenCalled()
  })
})
