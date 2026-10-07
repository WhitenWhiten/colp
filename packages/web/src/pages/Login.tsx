import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { BrandName } from '../components/Brand'
import { useToast } from '../components/AppToast'
import { Icon } from '../components/Icon'
import { TabList } from '../components/TabList'
import { PasswordField } from '../components/auth/PasswordField'
import { useAuth } from '../auth/AuthContext'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { loginReasonMessage } from './loginReason'
import { safeReturnTo } from './safeReturnTo'
import '../styles/auth-pages.css'

export { safeReturnTo } from './safeReturnTo'

export const OTP_RESEND_COOLDOWN_SECONDS = 20
export const OTP_LENGTH = 6

export type LoginMode = 'password' | 'otp'

const MODE_LABELS: Record<LoginMode, string> = {
  password: 'Password',
  otp: 'Email code',
}

/** Typed ProductApiError → user-facing message. Never parses raw server text. */
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

function otpComplete(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`, 'u').test(value.trim())
}

/**
 * Server-side auth failures go through the error toast: it auto-dismisses and
 * a route change clears it, so the card does not resize and the copy does not
 * stick. `invalid` still marks suspect inputs aria-invalid; `focusId` gets
 * focus once the submit settles so the user can retype immediately. Empty-field
 * validation stays inline on the control (`.field-error`).
 */
type SuspectFields = {
  invalid?: ReadonlyArray<'email' | 'secret'>
  focusId?: 'login-email' | 'login-password' | 'login-otp-code' | 'login-submit' | 'login-oauth-google' | 'login-oauth-github'
}

export function Login() {
  useDocumentTitle('Sign in')
  const [mode, setMode] = useState<LoginMode>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)
  const [busy, setBusy] = useState<'sign-in' | 'send-otp' | 'oauth' | null>(null)
  const inFlightRef = useRef(false)

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isLoggedIn, bootstrapping, refreshSession, verificationRequired } = useAuth()
  const { toast, error } = useToast()

  const [emailError, setEmailError] = useState<string | null>(null)
  const [secretError, setSecretError] = useState<string | null>(null)
  const [suspect, setSuspect] = useState<SuspectFields | null>(null)

  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const withReturn = (path: string) => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`
  const reasonMessage = loginReasonMessage(searchParams.get('reason'))
  const authFailed = searchParams.get('auth') === 'failed'
  const authRestart = searchParams.get('auth') === 'restart'
  const canSignInPassword = password.length > 0
  const canSignInOtp = otpComplete(otp)
  const canSendOtp = busy === null && resendCooldown <= 0 && email.trim().length > 0
  /* R15-36: choosing a method with the pointer moves on to its field; arrow
     keys roam the tablist and must leave focus there. */
  const [fieldFocus, setFieldFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!fieldFocus) return
    document.getElementById(fieldFocus)?.focus()
    setFieldFocus(null)
  }, [fieldFocus])

  useEffect(() => {
    if (bootstrapping) return
    // A protected request can return a definitive 401 just before AuthContext
    // observes the expired session. Its controlled reason must keep the login
    // form open instead of bouncing straight back into a redirect loop.
    if (isLoggedIn && !reasonMessage) {
      navigate(returnTo, { replace: true })
      return
    }
    if (verificationRequired) {
      navigate(`/verify-email?returnTo=${encodeURIComponent(returnTo)}`, { replace: true })
    }
  }, [bootstrapping, isLoggedIn, verificationRequired, navigate, reasonMessage, returnTo])

  const shownAuthFailureRef = useRef(false)
  useEffect(() => {
    if (!authFailed || shownAuthFailureRef.current) return
    shownAuthFailureRef.current = true
    error('Sign-in failed. Your session was not created. Please try again.')
  }, [authFailed, error])

  // Focus the suspect field once the failed submit has settled (inputs are
  // disabled while busy, so this cannot run inside the catch block itself).
  useEffect(() => {
    if (!suspect?.focusId) return
    document.getElementById(suspect.focusId)?.focus()
  }, [suspect])

  useEffect(() => {
    if (authRestart && !authFailed && !reasonMessage) {
      toast('Your previous session ended. Please sign in again.')
    }
  }, [authFailed, authRestart, reasonMessage, toast])

  const shownReasonRef = useRef<string | null>(null)
  useEffect(() => {
    if (!reasonMessage || shownReasonRef.current === reasonMessage) return
    shownReasonRef.current = reasonMessage
    toast(reasonMessage)
  }, [reasonMessage, toast])

  const resendCooldownActive = resendCooldown > 0
  useEffect(() => {
    if (!resendCooldownActive) return
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendCooldownActive])

  const handlePasswordSubmit = async () => {
    if (inFlightRef.current || !canSignInPassword) return
    inFlightRef.current = true
    setBusy('sign-in')
    try {
      await authClient.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
        callbackURL: returnTo,
      })
      await refreshSession().catch(() => {
        // The auth client already refreshed the product session store; a
        // failed AuthContext re-bootstrap must not block the redirect.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      if (isProductApiError(err) && err.code === 'verification_required') {
        error('Please verify your email before signing in.')
        setSuspect({ focusId: 'login-submit' })
      } else if (isProductApiError(err) && err.code === 'invalid_credentials') {
        // Non-enumerating: either input may be wrong, so both are marked;
        // focus lands on the password because that is the usual retype.
        error('Incorrect email or password.')
        setSuspect({
          invalid: ['email', 'secret'],
          focusId: 'login-password',
        })
      } else {
        error(authErrorMessage(err, 'Sign-in failed. Try again.'))
        // R15-36: the submit button was disabled while busy, which drops
        // focus to <body>; hand it back so a retry is one keypress away.
        setSuspect({ focusId: 'login-submit' })
      }
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleSendOtp = async () => {
    if (inFlightRef.current || !canSendOtp) return
    inFlightRef.current = true
    setBusy('send-otp')
    setSuspect(null)
    try {
      await authClient.sendOtp({ email: email.trim().toLowerCase(), type: 'sign-in' })
      setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS)
      toast(`If an account exists for ${email.trim().toLowerCase()}, a sign-in code was sent.`)
    } catch (err) {
      error(authErrorMessage(err, 'We could not send a sign-in code. Try again.'))
      setSuspect({ focusId: 'login-email' })
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleVerifyOtp = async () => {
    if (inFlightRef.current || !canSignInOtp) return
    inFlightRef.current = true
    setBusy('sign-in')
    try {
      await authClient.signInWithOtp({ email: email.trim().toLowerCase(), otp: otp.trim() })
      await refreshSession().catch(() => {
        // See handlePasswordSubmit: the session store is already refreshed.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      if (isProductApiError(err) && err.code === 'verification_required') {
        error('Please verify your email before signing in.')
        setSuspect({ focusId: 'login-submit' })
      } else {
        error(authErrorMessage(err, 'That code did not work. Try again.'))
        setSuspect({
          invalid: ['secret'],
          focusId: 'login-otp-code',
        })
      }
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const startOAuthFlow = async (providerId: 'google' | 'github') => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy('oauth')
    setSuspect(null)
    try {
      const result = await authClient.startOAuth({
        providerId,
        callbackURL: returnTo,
        errorCallbackURL: `/auth/recovery?returnTo=${encodeURIComponent(returnTo)}`,
        newUserCallbackURL: '/onboarding',
      })
      if (result.redirect && result.url) {
        const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location
        if (loc && typeof loc.assign === 'function') {
          loc.assign(result.url)
          return
        }
      }
      inFlightRef.current = false
      setBusy(null)
    } catch (err) {
      inFlightRef.current = false
      setBusy(null)
      error(authErrorMessage(err, 'Could not start sign-in with this provider. Try again.'))
      setSuspect({ focusId: `login-oauth-${providerId}` })
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSuspect(null)
    const nextEmailError = email.trim() ? null : 'Enter your email.'
    const nextSecretError = mode === 'password'
      ? (canSignInPassword ? null : 'Enter your password.')
      : (canSignInOtp ? null : `Enter the ${OTP_LENGTH}-digit sign-in code.`)
    setEmailError(nextEmailError)
    setSecretError(nextSecretError)
    if (nextEmailError || nextSecretError || busy !== null) return
    if (mode === 'password') void handlePasswordSubmit()
    else void handleVerifyOtp()
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Welcome back</p>
        <h1>Log in to Know-N</h1>

        <TabList
          label="Sign-in method"
          className="view-switch auth-tabs"
          tabClassName="auth-tab"
          value={mode}
          options={(Object.keys(MODE_LABELS) as LoginMode[]).map((id) => ({
            id,
            label: MODE_LABELS[id],
          }))}
          tabIdFor={(id) => `login-tab-${id}`}
          panelIdFor={(id) => `login-panel-${id}`}
          disabled={busy !== null}
          onChange={(id, via) => {
            setMode(id)
            setSecretError(null)
            setSuspect(null)
            if (via === 'pointer' && id !== mode) setFieldFocus(id === 'otp' ? 'login-otp-code' : 'login-password')
          }}
        />

        <form className="auth-form" method="post" action="/login" autoComplete="on" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              name="username"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setEmailError(null)
                setSuspect(null)
              }}
              disabled={busy !== null}
              aria-invalid={emailError || suspect?.invalid?.includes('email') ? true : undefined}
              aria-describedby={emailError ? 'login-email-error' : undefined}
              required
            />
            {emailError && <p id="login-email-error" className="field-error" role="alert">{emailError}</p>}
          </div>

          <div className="auth-secret-slot">
            <div
              className="field"
              id="login-panel-password"
              role="tabpanel"
              aria-labelledby="login-tab-password"
              data-mode="password"
              data-inactive={mode !== 'password' || undefined}
              aria-hidden={mode !== 'password'}
            >
              <label htmlFor="login-password">Password</label>
              <PasswordField
                id="login-password"
                name="password"
                autoComplete={mode === 'password' ? 'current-password' : 'off'}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setSecretError(null)
                  setSuspect(null)
                }}
                disabled={busy !== null || mode !== 'password'}
                aria-invalid={
                  mode === 'password' && (secretError || suspect?.invalid?.includes('secret'))
                    ? true
                    : undefined
                }
                aria-describedby={
                  mode === 'password' && secretError ? 'login-secret-error' : undefined
                }
                required={mode === 'password'}
              />
              {mode === 'password' && secretError && (
                <p id="login-secret-error" className="field-error" role="alert">{secretError}</p>
              )}
            </div>
            <div
              className="field"
              id="login-panel-otp"
              role="tabpanel"
              aria-labelledby="login-tab-otp"
              data-mode="otp"
              data-inactive={mode !== 'otp' || undefined}
              aria-hidden={mode !== 'otp'}
            >
              <label htmlFor="login-otp-code">Sign-in code</label>
              <div className="auth-otp-row">
                <input
                  id="login-otp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete={mode === 'otp' ? 'one-time-code' : 'off'}
                  maxLength={OTP_LENGTH}
                  value={otp}
                  onChange={(event) => {
                    setOtp(event.target.value)
                    setSecretError(null)
                    setSuspect(null)
                  }}
                  disabled={busy !== null || mode !== 'otp'}
                  aria-invalid={
                    mode === 'otp' && (secretError || suspect?.invalid?.includes('secret'))
                      ? true
                      : undefined
                  }
                  aria-describedby={
                    mode === 'otp' && secretError ? 'login-secret-error' : undefined
                  }
                  required={mode === 'otp'}
                />
                <button
                  type="button"
                  id="login-send-otp"
                  className="btn btn-secondary auth-otp-send"
                  disabled={!canSendOtp || mode !== 'otp'}
                  onClick={() => {
                    void handleSendOtp()
                  }}
                >
                  {busy === 'send-otp'
                    ? 'Sending…'
                    : resendCooldown > 0
                      ? `Resend code in ${resendCooldown}s`
                      : 'Send code'}
                </button>
              </div>
              {mode === 'otp' && secretError && (
                <p id="login-secret-error" className="field-error" role="alert">{secretError}</p>
              )}
            </div>
          </div>

          <button id="login-submit" type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === 'sign-in' ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="auth-inline-link">
            <Link to={withReturn(`/reset-password?email=${encodeURIComponent(email.trim().toLowerCase())}`)}>
              Forgot password?
            </Link>
          </p>
        </form>

        <div className="auth-oauth-row" data-testid="auth-oauth-row">
          <button
            id="login-oauth-google"
            type="button"
            className="btn btn-secondary auth-oauth-btn"
            aria-label="Continue with Google"
            disabled={busy !== null}
            onClick={() => {
              void startOAuthFlow('google')
            }}
          >
            <span className="auth-oauth-letter" aria-hidden="true">
              G
            </span>
          </button>
          <button
            id="login-oauth-github"
            type="button"
            className="btn btn-secondary auth-oauth-btn"
            aria-label="Continue with GitHub"
            disabled={busy !== null}
            onClick={() => {
              void startOAuthFlow('github')
            }}
          >
            <Icon name="github" />
          </button>
        </div>

        <p className="auth-alt">
          New here? <Link to={withReturn('/register')}>Create an account</Link>
        </p>
      </div>
    </div>
  )
}
