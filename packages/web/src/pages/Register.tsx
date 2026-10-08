import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { BrandName } from '../components/Brand'
import { Icon } from '../components/Icon'
import { TabList } from '../components/TabList'
import { MIN_PASSWORD_LENGTH, PasswordField } from '../components/auth/PasswordField'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useEmailVerifiedPoll } from '../lib/useEmailVerifiedPoll'
import { useFocusWhen } from '../lib/useFocusWhen'
import { safeReturnTo } from './safeReturnTo'
import { isSelfHostedEdition } from '../lib/edition'
import { SelfHostedRegister } from './SelfHostedRegister'
import '../styles/auth-pages.css'

async function readEmailVerified(): Promise<boolean> {
  const session = await authClient.getAuthSession()
  return session?.user.emailVerified === true
}

export const OTP_RESEND_COOLDOWN_SECONDS = 30
export const OTP_LENGTH = 6

export type RegisterMode = 'password' | 'otp'

const MODE_LABELS: Record<RegisterMode, string> = {
  password: 'Password',
  otp: 'Email code',
}

/* R7-06: registration's default landing is onboarding — the same place OAuth
   sends first-time accounts (newUserCallbackURL) — so both signup paths meet. */
const RETURN_TO_FALLBACK = '/onboarding'

function otpComplete(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`, 'u').test(value.trim())
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

export function Register() {
  if (isSelfHostedEdition()) return <SelfHostedRegister />
  return <CloudRegister />
}

function CloudRegister() {
  useDocumentTitle('Create account')
  const [mode, setMode] = useState<RegisterMode>('password')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [busy, setBusy] = useState<'sign-up' | 'send-otp' | 'oauth' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [otpError, setOtpError] = useState<string | null>(null)
  const [createdEmail, setCreatedEmail] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { refreshSession } = useAuth()

  const returnTo = safeReturnTo(searchParams.get('returnTo'), RETURN_TO_FALLBACK)
  const withReturn = (path: string) => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`

  const resendCooldownActive = resendCooldown > 0
  useEffect(() => {
    if (!resendCooldownActive) return
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendCooldownActive])

  const pending = createdEmail !== null
  useFocusWhen(otpSent, 'register-otp-code')
  /* R15-36: a pointer choice of method moves on to its first field; arrow
     keys roam the tablist and leave focus there. */
  const [fieldFocus, setFieldFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!fieldFocus) return
    document.getElementById(fieldFocus)?.focus()
    setFieldFocus(null)
  }, [fieldFocus])

  const { verified: emailVerified, gaveUp: verifyPollGaveUp, checkAgain } = useEmailVerifiedPoll(
    pending,
    readEmailVerified,
  )

  /* R15-36: the focused form is replaced by the pending (then verified)
     panel; move focus to its heading so the change is announced and focus
     does not fall to <body>. */
  const statusHeadingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (pending) statusHeadingRef.current?.focus()
  }, [pending, emailVerified])

  const handlePasswordSignup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setNotice(null)
    const nextNameError = name.trim() ? null : 'Enter your name.'
    const nextEmailError = email.trim() ? null : 'Enter your email.'
    const nextPasswordError = password.length === 0
      ? 'Enter a password.'
      : password.length < MIN_PASSWORD_LENGTH
        ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
        : null
    setNameError(nextNameError)
    setEmailError(nextEmailError)
    setPasswordError(nextPasswordError)
    if (nextNameError || nextEmailError || nextPasswordError) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy('sign-up')
    try {
      await authClient.signUpWithPassword({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        callbackURL: `/verify-email?verified=1&returnTo=${encodeURIComponent(returnTo)}`,
      })
      await refreshSession().catch(() => {
        // The auth client already refreshed the product session store.
      })
      setCreatedEmail(email.trim().toLowerCase())
    } catch (err) {
      if (isProductApiError(err)) {
        if (err.code === 'rate_limited') {
          setError(authErrorMessage(err, 'We could not create your account. Try again.'))
        } else if (err.code === 'transport_error') {
          setError(authErrorMessage(err, 'We could not create your account. Try again.'))
        } else if (err.code === 'invalid_request') {
          setError("We couldn't create your account. Check the details and try again.")
        } else {
          // Non-enumerating: a duplicate email, a rejected signup and any
          // other account-level failure get the same copy — the server's
          // text (which may distinguish existing accounts) never surfaces.
          setError(
            'We could not create your account. If you already have an account, sign in instead.',
          )
        }
      } else {
        setError('We could not create your account. Try again.')
      }
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  const handleSendOtp = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    const nextNameError = name.trim() ? null : 'Enter your name.'
    const nextEmailError = email.trim() ? null : 'Enter your email.'
    setNameError(nextNameError)
    setEmailError(nextEmailError)
    if (nextNameError || nextEmailError) return
    if (inFlightRef.current || resendCooldown > 0) return
    inFlightRef.current = true
    setBusy('send-otp')
    setError(null)
    setNotice(null)
    try {
      await authClient.sendOtp({
        email: email.trim().toLowerCase(),
        type: 'sign-in',
        intent: 'sign-up',
      })
      setOtpSent(true)
      setResendCooldown(OTP_RESEND_COOLDOWN_SECONDS)
      setNotice(`We sent a sign-up code to ${email.trim().toLowerCase()}.`)
    } catch (err) {
      if (isProductApiError(err) && err.code === 'invalid_credentials') {
        setError(
          'We could not create your account. If you already have an account, sign in instead.',
        )
      } else {
        setError(authErrorMessage(err, 'We could not send a sign-up code. Try again.'))
      }
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  /* R7-06: the register page carries the same providers as Login — people
     who want a one-click start should not meet a longer form here. */
  const startOAuthFlow = async (providerId: 'google' | 'github') => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy('oauth')
    setError(null)
    setNotice(null)
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
      setError(authErrorMessage(err, 'Could not start sign-up with this provider. Try again.'))
    }
  }

  const handleOtpSignup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    const nextNameError = name.trim() ? null : 'Enter your name.'
    const nextEmailError = email.trim() ? null : 'Enter your email.'
    const nextOtpError = otpComplete(otp) ? null : `Enter the ${OTP_LENGTH}-digit sign-up code.`
    setNameError(nextNameError)
    setEmailError(nextEmailError)
    setOtpError(nextOtpError)
    if (nextNameError || nextEmailError || nextOtpError) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy('sign-up')
    try {
      // Controlled OTP signup: the server decides whether the verified email
      // maps to a new account or an existing one — the client only proves
      // possession of the code.
      await authClient.signInWithOtp({
        email: email.trim().toLowerCase(),
        otp: otp.trim(),
        name: name.trim(),
        intent: 'sign-up',
      })
      await refreshSession().catch(() => {
        // See handlePasswordSignup.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(
        authErrorMessage(err, 'That code did not work. Try again.'),
      )
    } finally {
      inFlightRef.current = false
      setBusy(null)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Get started</p>
        <h1>Create your Know-N account</h1>
        <p className="sub">Use your email — with a password or a one-time code.</p>

        {error ? (
          <div className="panel panel-pad auth-alert auth-feedback" role="alert">
            <p className="auth-alert-text">{error}</p>
          </div>
        ) : notice ? (
          <p className="auth-notice auth-feedback" role="status">{notice}</p>
        ) : null}

        {pending ? (
          emailVerified ? (
            <div className="auth-pending" data-testid="auth-pending">
              <div className="auth-success" role="status">
                <h2 className="display display-sm" ref={statusHeadingRef} tabIndex={-1}>Congratulations</h2>
                <p className="sub">Your email is verified and your account is ready.</p>
              </div>
              <div className="auth-cta-stack">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => navigate(returnTo, { replace: true })}
                >
                  Continue
                </button>
              </div>
            </div>
          ) : (
          <div className="auth-pending" data-testid="auth-pending">
            <h2 className="display display-sm" ref={statusHeadingRef} tabIndex={-1}>Check your email</h2>
            <p className="sub">
              We sent a verification link to {createdEmail}. Your account is active once you verify.
            </p>
            <div className="auth-cta-stack">
              <Link
                className="btn btn-secondary"
                to={`/verify-email?email=${encodeURIComponent(createdEmail ?? '')}&returnTo=${encodeURIComponent(returnTo)}`}
              >
                Enter the verification code instead
              </Link>
              <Link className="btn btn-ghost" to={withReturn('/login')}>
                Back to sign in
              </Link>
            </div>
            {verifyPollGaveUp ? (
              <p className="sub" data-testid="register-verify-stopped">
                Verified already?{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={checkAgain}>
                  Check again
                </button>
              </p>
            ) : null}
          </div>
          )
        ) : (
          <>
            <TabList
              label="Registration method"
              className="view-switch auth-tabs"
              tabClassName="auth-tab"
              value={mode}
              options={(Object.keys(MODE_LABELS) as RegisterMode[]).map((id) => ({
                id,
                label: MODE_LABELS[id],
              }))}
              tabIdFor={(id) => `register-tab-${id}`}
              panelIdFor={(id) => `register-panel-${id}`}
              disabled={busy !== null}
              onChange={(id, via) => {
                setMode(id)
                setNameError(null)
                setEmailError(null)
                setPasswordError(null)
                setOtpError(null)
                if (via === 'pointer' && id !== mode && id === 'otp') {
                  setFieldFocus(otpSent ? 'register-otp-code' : 'register-otp-name')
                }
              }}
            />

            {mode === 'password' && (
              <form
                id="register-panel-password"
                role="tabpanel"
                aria-labelledby="register-tab-password"
                className="auth-form"
                onSubmit={handlePasswordSignup}
                noValidate
              >
                <div className="field">
                  <label htmlFor="register-name">Name</label>
                  <input
                    id="register-name"
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value)
                      setNameError(null)
                    }}
                    disabled={busy !== null}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={nameError ? 'register-name-error' : undefined}
                    required
                  />
                  {nameError && <p id="register-name-error" className="field-error" role="alert">{nameError}</p>}
                </div>
                <div className="field">
                  <label htmlFor="register-email">Email</label>
                  <input
                    id="register-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setEmailError(null)
                    }}
                    disabled={busy !== null}
                    aria-invalid={emailError ? true : undefined}
                    aria-describedby={emailError ? 'register-email-error' : undefined}
                    required
                  />
                  {emailError && <p id="register-email-error" className="field-error" role="alert">{emailError}</p>}
                </div>
                <div className="field">
                  <label htmlFor="register-password">Password</label>
                  <PasswordField
                    id="register-password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setPasswordError(null)
                    }}
                    disabled={busy !== null}
                    aria-invalid={passwordError ? true : undefined}
                    aria-describedby={passwordError ? 'register-password-hint register-password-error' : 'register-password-hint'}
                    required
                  />
                  <span className="field-hint" id="register-password-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
                  {passwordError && (
                    <p id="register-password-error" className="field-error" role="alert">{passwordError}</p>
                  )}
                </div>
                <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                  {busy === 'sign-up' ? 'Creating…' : 'Create account'}
                </button>
              </form>
            )}

            {mode === 'otp' && (
              <form
                id="register-panel-otp"
                role="tabpanel"
                aria-labelledby="register-tab-otp"
                className="auth-form"
                onSubmit={otpSent ? handleOtpSignup : handleSendOtp}
                noValidate
              >
                <div className="field">
                  <label htmlFor="register-otp-name">Name</label>
                  <input
                    id="register-otp-name"
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value)
                      setNameError(null)
                    }}
                    disabled={busy !== null}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={nameError ? 'register-otp-name-error' : undefined}
                    required
                  />
                  {nameError && <p id="register-otp-name-error" className="field-error" role="alert">{nameError}</p>}
                </div>
                <div className="field">
                  <label htmlFor="register-otp-email">Email</label>
                  <input
                    id="register-otp-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setEmailError(null)
                    }}
                    disabled={busy !== null}
                    aria-invalid={emailError ? true : undefined}
                    aria-describedby={emailError ? 'register-otp-email-error' : undefined}
                    required
                  />
                  {emailError && <p id="register-otp-email-error" className="field-error" role="alert">{emailError}</p>}
                </div>
                {otpSent && (
                  <div className="field">
                    <label htmlFor="register-otp-code">Sign-up code</label>
                    <input
                      id="register-otp-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={OTP_LENGTH}
                      value={otp}
                      onChange={(event) => {
                        setOtp(event.target.value)
                        setOtpError(null)
                      }}
                      disabled={busy !== null}
                      aria-invalid={otpError ? true : undefined}
                      aria-describedby={otpError ? 'register-otp-code-error' : undefined}
                      required
                    />
                    {otpError && <p id="register-otp-code-error" className="field-error" role="alert">{otpError}</p>}
                  </div>
                )}
                <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                  {busy === 'send-otp'
                    ? 'Sending…'
                    : otpSent
                      ? busy === 'sign-up'
                        ? 'Creating…'
                        : 'Sign up with code'
                      : 'Send code'}
                </button>
                {otpSent && (
                  <button
                    type="button"
                    id="register-resend-otp"
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
            )}

            <div className="auth-oauth-row">
              <button
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
          </>
        )}

        <p className="auth-alt">
          Already have an account? <Link to={withReturn('/login')}>Log in</Link>
        </p>
      </div>
    </div>
  )
}
