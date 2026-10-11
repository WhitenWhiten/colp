import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { BrandName } from '../components/Brand'
import { CommandBlock } from '../components/CommandBlock'
import { PasswordField } from '../components/auth/PasswordField'
import { parseRegistrationState, productName, registrationView, type RegistrationView } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { loginReasonMessage } from './loginReason'
import { safeReturnTo } from './safeReturnTo'
import '../styles/auth-pages.css'

/** Better Auth's username plugin default: letters, digits, `_` and `.`. */
const USERNAME_SHAPE = /^[A-Za-z0-9_.]{1,30}$/u

function signInErrorMessage(err: unknown): string {
  if (isProductApiError(err)) {
    if (err.code === 'rate_limited') {
      return err.retryAfterSeconds != null
        ? `Too many attempts. Try again in ${err.retryAfterSeconds}s.`
        : 'Too many attempts. Try again shortly.'
    }
    if (err.code === 'transport_error') return 'Could not reach the server. Check your connection and try again.'
    return err.recoveryHint || err.message
  }
  return 'Sign-in failed. Try again.'
}

/** The CLI reset for the name typed so far, or a placeholder. */
export function resetPasswordCommand(identifier: string): string {
  const name = identifier.trim()
  const username = USERNAME_SHAPE.test(name) ? name : '<username>'
  return `docker compose exec server colp-server reset-password --username ${username}`
}

/**
 * Server-side failures go through the error toast, as on Know-N: it
 * auto-dismisses and a route change clears it, so the card keeps its size
 * and stale copy does not stick. `invalid` marks suspect inputs
 * aria-invalid; `focusId` gets focus once the submit settles. Empty-field
 * validation stays inline on the control (`.field-error`).
 */
type SuspectFields = {
  invalid?: ReadonlyArray<'identifier' | 'password'>
  focusId?: 'login-password' | 'login-submit'
}

/**
 * Sign-in for COLP Server. Accounts have a username and an optional email
 * (G2); the server sends no email (D28), so there is no code sign-in and no
 * mailed reset, and no sign-in providers are configured. A server without
 * an owner gets the first-run card instead: nobody can sign in yet.
 */
export function SelfHostedLogin() {
  useDocumentTitle('Sign in')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isLoggedIn, bootstrapping, refreshSession } = useAuth()
  const { toast, error } = useToast()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [identifierError, setIdentifierError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [suspect, setSuspect] = useState<SuspectFields | null>(null)
  const [busy, setBusy] = useState(false)
  const [registration, setRegistration] = useState<RegistrationView | null>(null)
  const inFlight = useRef(false)

  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const reasonMessage = loginReasonMessage(searchParams.get('reason'))
  // Better Auth sends a signed-out browser here with the paused OAuth
  // authorization as a signed query; sign-in must carry it to resume.
  const oauthQuery = searchParams.has('sig') ? searchParams.toString() : undefined

  useEffect(() => {
    if (bootstrapping) return
    // A controlled 401 reason keeps the form open instead of looping back.
    // An OAuth sign-in leaves through the URL Better Auth returns instead.
    if (isLoggedIn && !reasonMessage && oauthQuery === undefined) navigate(returnTo, { replace: true })
  }, [bootstrapping, isLoggedIn, navigate, oauthQuery, reasonMessage, returnTo])

  const shownReasonRef = useRef<string | null>(null)
  useEffect(() => {
    if (!reasonMessage || shownReasonRef.current === reasonMessage) return
    shownReasonRef.current = reasonMessage
    toast(reasonMessage)
  }, [reasonMessage, toast])

  // Inputs are disabled while busy, so focus moves once the submit settles.
  useEffect(() => {
    if (!suspect?.focusId || busy) return
    document.getElementById(suspect.focusId)?.focus()
  }, [suspect, busy])

  // A fresh server has no owner yet: show first-run setup instead.
  useEffect(() => {
    const controller = new AbortController()
    void authClient.getRegistrationState({ signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) setRegistration(registrationView(parseRegistrationState(body)))
      })
      .catch(() => {
        // Sign-in still works; the setup and invite pointers are optional.
      })
    return () => controller.abort()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSuspect(null)
    const id = identifier.trim()
    const nextIdentifierError = id ? null : 'Enter your username or email.'
    const nextPasswordError = password ? null : 'Enter your password.'
    setIdentifierError(nextIdentifierError)
    setPasswordError(nextPasswordError)
    if (nextIdentifierError || nextPasswordError || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const oauth = oauthQuery === undefined ? {} : { oauthQuery }
      const result = id.includes('@')
        ? await authClient.signInWithPassword({ email: id.toLowerCase(), password, callbackURL: returnTo, ...oauth })
        : await authClient.signInWithUsername({ username: id, password, ...oauth })
      if (result.redirectUrl) {
        window.location.assign(result.redirectUrl)
        return
      }
      await refreshSession().catch(() => {
        // The auth client already refreshed the product session store.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      if (isProductApiError(err) && err.code === 'invalid_credentials') {
        // Non-enumerating: either input may be wrong, so both are marked;
        // focus lands on the password because that is the usual retype.
        error('Incorrect username or password.')
        setSuspect({ invalid: ['identifier', 'password'], focusId: 'login-password' })
      } else {
        error(signInErrorMessage(err))
        setSuspect({ focusId: 'login-submit' })
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (registration === 'owner') {
    return (
      <div className="auth-page">
        <div className="auth-card rise" data-testid="login-owner-missing">
          <p className="auth-brand"><BrandName /></p>
          <p className="section-label">First run</p>
          <h1>Set up {productName()}</h1>
          <p className="sub">
            This server has no owner yet, so there is no account to sign in to. Create the owner
            account first; registration closes after it.
          </p>
          <ol className="auth-steps">
            <li>Copy the setup token from the server log.</li>
            <li>Choose a username and a password.</li>
            <li>Import your bookmarks or connect a browser.</li>
          </ol>
          <div className="auth-cta-stack">
            <Link to="/register" className="btn btn-primary">Create the owner account</Link>
          </div>
          <p className="auth-alt">
            Prefer the terminal? Run <code>colp-server create-user</code> in the server container.
          </p>
        </div>
      </div>
    )
  }

  const identifierInvalid = !!identifierError || !!suspect?.invalid?.includes('identifier')
  const passwordInvalid = !!passwordError || !!suspect?.invalid?.includes('password')

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Welcome back</p>
        <h1>Sign in to {productName()}</h1>
        <form className="auth-form" method="post" action="/login" autoComplete="on" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="login-identifier">Username or email</label>
            <input
              id="login-identifier"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={identifier}
              onChange={(event) => {
                setIdentifier(event.target.value)
                setIdentifierError(null)
                setSuspect(null)
              }}
              disabled={busy}
              aria-invalid={identifierInvalid || undefined}
              aria-describedby={identifierError ? 'login-identifier-error' : undefined}
              required
            />
            {identifierError && <p id="login-identifier-error" className="field-error" role="alert">{identifierError}</p>}
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <PasswordField
              id="login-password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                setPasswordError(null)
                setSuspect(null)
              }}
              disabled={busy}
              aria-invalid={passwordInvalid || undefined}
              aria-describedby={passwordError ? 'login-password-error' : undefined}
              required
            />
            {passwordError && <p id="login-password-error" className="field-error" role="alert">{passwordError}</p>}
          </div>
          <button id="login-submit" type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <details className="auth-reset" data-testid="login-reset-hint">
          <summary>Forgot your password?</summary>
          <p>
            This server sends no email, so passwords are reset where it runs. Whoever runs it can set a
            new one:
          </p>
          <CommandBlock label="password reset command" command={resetPasswordCommand(identifier)} />
        </details>
        {registration === 'invite' && (
          <p className="auth-alt" data-testid="login-invite">
            Have an invite code? <Link to="/register">Create your account</Link>
          </p>
        )}
      </div>
    </div>
  )
}
