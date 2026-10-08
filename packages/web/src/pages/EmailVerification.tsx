import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useFocusWhen } from '../lib/useFocusWhen'
import { BrandName } from '../components/Brand'
import { safeReturnTo } from './safeReturnTo'
import '../styles/auth-pages.css'

export const OTP_RESEND_COOLDOWN_SECONDS = 30

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

export function EmailVerification() {
  useDocumentTitle('Verify email')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [busy, setBusy] = useState<'verify-token' | 'send-otp' | 'verify-otp' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<'idle' | 'success'>('idle')
  const inFlightRef = useRef(false)
  useFocusWhen(otpSent, 'verify-otp-code')

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isLoggedIn, refreshSession } = useAuth()

  const token = searchParams.get('token')
  const alreadyMarkedVerified = searchParams.get('verified') === '1'
  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const withReturn = (path: string) => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`
  const emailParam = searchParams.get('email')

  // Prefill from the register/login links.
  useEffect(() => {
    if (emailParam) setEmail(emailParam)
  }, [emailParam])

  // Password-signup callback / already-verified session: show congratulations
  // without requiring another token or code.
  useEffect(() => {
    if (token || result === 'success') return
    if (alreadyMarkedVerified) {
      setResult('success')
      return
    }
    let cancelled = false
    void authClient
      .getAuthSession()
      .then((info) => {
        if (cancelled) return
        if (info?.user.emailVerified === true) {
          setResult('success')
          return
        }
        if (!emailParam && info?.user.email) setEmail(info.user.email)
      })
      .catch(() => {
        // Stay on the code-entry form when the session cannot be read.
      })
    return () => {
      cancelled = true
    }
  }, [token, alreadyMarkedVerified, result, emailParam])

  // Email-link verification: ?token=… arrives from the verification email.
  useEffect(() => {
    if (!token) return
    // No cross-run "already verified" ref: it survives StrictMode's effect leg 2
    // while leg 1's `cancelled` flag has already been set by its cleanup, so leg
    // 2 returned early and leg 1's result was discarded — the page stayed on
    // "verifying" forever. Verifying the same token again is idempotent, so each
    // run owns its request and only its own cancellation can drop the result.
    let cancelled = false
    void (async () => {
      setBusy('verify-token')
      try {
        await authClient.verifyEmail({ token })
        if (cancelled) return
        await refreshSession().catch(() => {
          // Verification does not issue a session; a failed re-bootstrap
          // must not turn a verified link into an error panel.
        })
        if (cancelled) return
        setResult('success')
      } catch (err) {
        if (cancelled) return
        setError(authErrorMessage(err, 'This verification link is invalid or has expired.'))
      } finally {
        if (!cancelled) setBusy(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, refreshSession])

  const resendCooldownActive = resendCooldown > 0
  useEffect(() => {
    if (!resendCooldownActive) return
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendCooldownActive])

  const handleSendOtp = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (inFlightRef.current || resendCooldown > 0) return
    inFlightRef.current = true
    setBusy('send-otp')
    setError(null)
    setNotice(null)
    const target = email.trim().toLowerCase()
    try {
      await authClient.sendOtp({ email: target, type: 'email-verification' })
      setOtpSent(true)
      setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS)
      // Non-enumerating: identical copy whether or not the email exists.
      setNotice(`If an account exists for ${target}, we sent a verification code.`)
    } catch (err) {
      setError(authErrorMessage(err, 'We could not send a verification code. Try again.'))
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleVerifyOtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy('verify-otp')
    setError(null)
    try {
      await authClient.verifyEmailWithOtp({
        email: email.trim().toLowerCase(),
        otp: otp.trim(),
      })
      await refreshSession().catch(() => {
        // See the token effect.
      })
      setResult('success')
    } catch (err) {
      setError(authErrorMessage(err, 'That code did not work. Try again.'))
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  if (result === 'success') {
    return (
      <div className="auth-page">
        <div className="auth-card rise">
          <p className="auth-brand"><BrandName /></p>
          <p className="section-label">Almost there</p>
          <div className="auth-success" role="status">
            <h1 className="display display-sm">Congratulations</h1>
            <p className="sub">Your email is verified and your account is ready.</p>
          </div>
          <div className="auth-cta-stack">
            {isLoggedIn ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => navigate(returnTo, { replace: true })}
              >
                Continue
              </button>
            ) : (
              <Link className="btn btn-primary" to={withReturn('/login')}>
                Go to sign in
              </Link>
            )}
          </div>
          <p className="auth-alt">
            Wrong account? <Link to={withReturn('/login')}>Sign in with a different email</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Email verification</p>
        <h1>Verify your email</h1>
        <p className="sub">
          Enter the verification code we sent, or open the link from your verification email.
        </p>

        {error ? (
          <div className="panel panel-pad auth-alert auth-feedback" role="alert">
            <p className="auth-alert-text">{error}</p>
          </div>
        ) : busy === 'verify-token' ? (
          <p className="auth-notice auth-feedback" role="status">Verifying your link…</p>
        ) : notice ? (
          <p className="auth-notice auth-feedback" role="status">{notice}</p>
        ) : null}

        <form className="auth-form" onSubmit={otpSent ? handleVerifyOtp : handleSendOtp} noValidate>
          <div className="field">
            <label htmlFor="verify-email">Email</label>
            <input
              id="verify-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy !== null}
              required
            />
          </div>
          {otpSent && (
            <div className="field">
              <label htmlFor="verify-otp-code">Verification code</label>
              <input
                id="verify-otp-code"
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
          )}
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === 'send-otp'
              ? 'Sending…'
              : otpSent
                ? busy === 'verify-otp'
                  ? 'Verifying…'
                  : 'Verify email'
                : 'Send code'}
          </button>
          {otpSent && (
            <button
              type="button"
              id="verify-resend-otp"
              className="btn btn-secondary"
              disabled={busy !== null || resendCooldown > 0}
              onClick={() => {
                void handleSendOtp()
              }}
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
            </button>
          )}
        </form>

        <p className="auth-alt">
          Back to <Link to={withReturn('/login')}>sign in</Link>
        </p>
      </div>
    </div>
  )
}
