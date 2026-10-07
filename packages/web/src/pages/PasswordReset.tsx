import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { authClient } from '../api/authClient'
import { isProductApiError, type ProductApiError } from '../api/errors'
import { BrandName } from '../components/Brand'
import { TabList } from '../components/TabList'
import { MIN_PASSWORD_LENGTH, PasswordField } from '../components/auth/PasswordField'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useFocusWhen } from '../lib/useFocusWhen'
import { safeReturnTo } from './safeReturnTo'
import '../styles/auth-pages.css'

export const OTP_RESEND_COOLDOWN_SECONDS = 30

export type ResetMode = 'otp' | 'link'

const MODE_LABELS: Record<ResetMode, string> = {
  otp: 'Email code',
  link: 'Email link',
}

function authErrorMessage(err: unknown, fallback: string): string {
  if (isProductApiError(err)) {
    if (err.code === 'rate_limited') {
      return err.retryAfterSeconds != null
        ? `Too many requests. Try again in ${err.retryAfterSeconds}s.`
        : 'Too many requests. Try again shortly.'
    }
    if (err.code === 'transport_error') return 'Network error. Check your connection and try again.'
    if (err.code === 'email_delivery_unavailable') {
      return 'Email delivery is temporarily unavailable. Try again shortly.'
    }
    return err.recoveryHint || err.message
  }
  return fallback
}

/**
 * Request-step errors that surface verbatim. Everything else (invalid
 * credentials, verification state, unknown account) is folded into the
 * uniform "if an account exists" copy so the UI never distinguishes a
 * registered from an unknown email.
 */
function isVisibleRequestError(err: ProductApiError): boolean {
  return (
    err.code === 'rate_limited' ||
    err.code === 'transport_error' ||
    err.code === 'email_delivery_unavailable' ||
    err.code === 'csrf_failed' ||
    err.code === 'invalid_request'
  )
}

export function PasswordReset() {
  useDocumentTitle('Reset password')
  const [mode, setMode] = useState<ResetMode>('otp')
  const [step, setStep] = useState<'request' | 'verify' | 'token'>('request')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const [busy, setBusy] = useState<'request' | 'reset' | null>(null)
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  useFocusWhen(step === 'verify', 'reset-otp')
  useFocusWhen(step === 'token', 'reset-token-password')

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { refreshSession } = useAuth()

  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const withReturn = (path: string) => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`
  const token = searchParams.get('token')
  const emailParam = searchParams.get('email')

  // Prefill from the login page's "Forgot password?" link.
  useEffect(() => {
    if (emailParam) setEmail(emailParam)
  }, [emailParam])

  // An emailed reset link lands here with ?token=… — switch to the token step.
  useEffect(() => {
    if (token) setStep('token')
  }, [token])

  const resendCooldownActive = resendCooldown > 0
  useEffect(() => {
    if (!resendCooldownActive) return
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendCooldownActive])

  const validatePasswords = (): boolean => {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setFieldError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return false
    }
    if (newPassword !== confirmPassword) {
      setFieldError('Passwords do not match.')
      return false
    }
    setFieldError(null)
    return true
  }

  const handleRequestOtp = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (inFlightRef.current || resendCooldown > 0) return
    inFlightRef.current = true
    setBusy('request')
    setError(null)
    setNotice(null)
    const target = email.trim().toLowerCase()
    try {
      await authClient.requestForgetPasswordOtp({ email: target })
      setNotice(`If an account exists for ${target}, we sent a reset code.`)
      setStep('verify')
      setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS)
    } catch (err) {
      if (isProductApiError(err) && isVisibleRequestError(err)) {
        setError({ message: authErrorMessage(err, 'We could not send a reset code. Try again.'), code: err.code })
      } else {
        // Non-enumerating: identical copy whether or not the email exists.
        setNotice(`If an account exists for ${target}, we sent a reset code.`)
        setStep('verify')
        setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS)
      }
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleRequestLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy('request')
    setError(null)
    setNotice(null)
    const target = email.trim().toLowerCase()
    try {
      await authClient.requestPasswordReset({ email: target, redirectTo: '/reset-password' })
      setNotice(`If an account exists for ${target}, we sent a reset link.`)
    } catch (err) {
      if (isProductApiError(err) && isVisibleRequestError(err)) {
        setError({ message: authErrorMessage(err, 'We could not send a reset link. Try again.'), code: err.code })
      } else {
        setNotice(`If an account exists for ${target}, we sent a reset link.`)
      }
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleVerifyReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlightRef.current) return
    if (!validatePasswords()) return
    inFlightRef.current = true
    setBusy('reset')
    setError(null)
    try {
      await authClient.resetPasswordWithOtp({
        email: email.trim().toLowerCase(),
        otp: otp.trim(),
        password: newPassword,
      })
      await refreshSession().catch(() => {
        // The auth client already refreshed the product session store; the
        // reset issues a fresh browser session.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError({
        message: authErrorMessage(err, 'We could not reset your password. Try again.'),
        code: isProductApiError(err) ? err.code : null,
      })
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleTokenReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlightRef.current) return
    if (!validatePasswords()) return
    inFlightRef.current = true
    setBusy('reset')
    setError(null)
    try {
      await authClient.resetPassword({ token: token ?? '', newPassword })
      await refreshSession().catch(() => {
        // See handleVerifyReset.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError({
        message: authErrorMessage(err, 'We could not reset your password. Try again.'),
        code: isProductApiError(err) ? err.code : null,
      })
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Account recovery</p>
        <h1>Reset your password</h1>
        <p className="sub">
          If an account exists for your email, we'll send a code or a link to set a new password.
        </p>

        {error ? (
          <div className="panel panel-pad auth-alert auth-feedback" role="alert">
            <p className="auth-alert-text">{error.message}</p>
          </div>
        ) : notice ? (
          <p className="auth-notice auth-feedback" role="status">{notice}</p>
        ) : null}

        {step === 'token' ? (
          <form className="auth-form" onSubmit={handleTokenReset} noValidate>
            <div className="field">
              <label htmlFor="reset-token-password">New password</label>
              <PasswordField
                id="reset-token-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value)
                  setFieldError(null)
                }}
                disabled={busy !== null}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'reset-token-field-error' : undefined}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="reset-token-confirm">Confirm new password</label>
              <PasswordField
                id="reset-token-confirm"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  setFieldError(null)
                }}
                disabled={busy !== null}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'reset-token-field-error' : undefined}
                required
              />
            </div>
            {fieldError && <p id="reset-token-field-error" className="field-error" role="alert">{fieldError}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>
              {busy === 'reset' ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        ) : step === 'verify' ? (
          <form className="auth-form" onSubmit={handleVerifyReset} noValidate>
            <div className="field">
              <label htmlFor="reset-otp">Reset code</label>
              <input
                id="reset-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
                disabled={busy !== null}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="reset-new-password">New password</label>
              <PasswordField
                id="reset-new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value)
                  setFieldError(null)
                }}
                disabled={busy !== null}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'reset-verify-field-error' : undefined}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="reset-confirm-password">Confirm new password</label>
              <PasswordField
                id="reset-confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  setFieldError(null)
                }}
                disabled={busy !== null}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'reset-verify-field-error' : undefined}
                required
              />
            </div>
            {fieldError && <p id="reset-verify-field-error" className="field-error" role="alert">{fieldError}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>
              {busy === 'reset' ? 'Saving…' : 'Set new password'}
            </button>
            <button
              type="button"
              id="reset-resend-otp"
              className="btn btn-secondary"
              disabled={busy !== null || resendCooldown > 0}
              onClick={() => {
                void handleRequestOtp()
              }}
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
          </form>
        ) : (
          <>
            <TabList
              label="Reset delivery method"
              className="view-switch auth-tabs"
              tabClassName="auth-tab"
              value={mode}
              options={(Object.keys(MODE_LABELS) as ResetMode[]).map((id) => ({
                id,
                label: MODE_LABELS[id],
              }))}
              tabIdFor={(id) => `reset-tab-${id}`}
              panelIdFor={() => 'reset-panel-request'}
              disabled={busy !== null}
              onChange={setMode}
            />

            <form
              id="reset-panel-request"
              role="tabpanel"
              aria-labelledby={`reset-tab-${mode}`}
              className="auth-form"
              onSubmit={mode === 'otp' ? handleRequestOtp : handleRequestLink}
              noValidate
            >
              <div className="field">
                <label htmlFor="reset-email">Email</label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={busy !== null}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                {busy === 'request'
                  ? 'Sending…'
                  : mode === 'otp'
                    ? 'Send reset code'
                    : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p className="auth-alt">
          Remembered it? <Link to={withReturn('/login')}>Back to sign in</Link>
        </p>
      </div>
    </div>
  )
}
