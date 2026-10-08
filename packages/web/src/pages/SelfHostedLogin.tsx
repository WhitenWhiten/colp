import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { BrandName } from '../components/Brand'
import { PasswordField } from '../components/auth/PasswordField'
import { parseRegistrationState, registrationView } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { loginReasonMessage } from './loginReason'
import { safeReturnTo } from './safeReturnTo'
import '../styles/auth-pages.css'

function signInErrorMessage(err: unknown): string {
  if (isProductApiError(err)) {
    if (err.code === 'invalid_credentials') return 'Incorrect username or password.'
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

/**
 * Sign-in for the self-hosted edition. Accounts have a username and an
 * optional email (G2); the server sends no email (D28), so there is no code
 * sign-in and no mailed reset, and no sign-in providers are configured.
 */
export function SelfHostedLogin() {
  useDocumentTitle('Sign in')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isLoggedIn, bootstrapping, refreshSession } = useAuth()
  const { toast } = useToast()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ownerMissing, setOwnerMissing] = useState(false)
  const [retypePassword, setRetypePassword] = useState(false)

  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const reasonMessage = loginReasonMessage(searchParams.get('reason'))

  useEffect(() => {
    if (bootstrapping) return
    // A controlled 401 reason keeps the form open instead of looping back.
    if (isLoggedIn && !reasonMessage) navigate(returnTo, { replace: true })
  }, [bootstrapping, isLoggedIn, navigate, reasonMessage, returnTo])

  const shownReasonRef = useRef<string | null>(null)
  useEffect(() => {
    if (!reasonMessage || shownReasonRef.current === reasonMessage) return
    shownReasonRef.current = reasonMessage
    toast(reasonMessage)
  }, [reasonMessage, toast])

  // Inputs are disabled while busy, so focus returns once the submit settles.
  useEffect(() => {
    if (!retypePassword || busy) return
    document.getElementById('login-password')?.focus()
    setRetypePassword(false)
  }, [retypePassword, busy])

  // A fresh server has no owner yet: point at first-run setup instead.
  useEffect(() => {
    const controller = new AbortController()
    void authClient.getRegistrationState({ signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) setOwnerMissing(registrationView(parseRegistrationState(body)) === 'owner')
      })
      .catch(() => {
        // Sign-in still works; the setup hint is optional.
      })
    return () => controller.abort()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const id = identifier.trim()
    if (!id) {
      setFormError('Enter your username or email.')
      return
    }
    if (!password) {
      setFormError('Enter your password.')
      return
    }
    setFormError(null)
    setBusy(true)
    try {
      if (id.includes('@')) {
        await authClient.signInWithPassword({ email: id.toLowerCase(), password, callbackURL: returnTo })
      } else {
        await authClient.signInWithUsername({ username: id, password })
      }
      await refreshSession().catch(() => {
        // The auth client already refreshed the product session store.
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      setFormError(signInErrorMessage(err))
      setRetypePassword(true)
    }
    setBusy(false)
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <h1>Sign in</h1>
        <p className="sub">Use the account you created on this server.</p>
        {ownerMissing && (
          <div className="panel panel-pad auth-alert auth-feedback" role="status" data-testid="login-owner-missing">
            <p className="auth-alert-text">
              This server has no owner account yet. <Link to="/register">Create it with the setup token</Link>.
            </p>
          </div>
        )}
        {formError && (
          <div className="panel panel-pad auth-alert auth-feedback" role="alert" data-testid="login-error">
            <p className="auth-alert-text">{formError}</p>
          </div>
        )}
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
              onChange={(event) => setIdentifier(event.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <PasswordField
              id="login-password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
          </div>
          <button id="login-submit" type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="auth-hint" data-testid="login-reset-hint">
          Forgot your password? Whoever runs this server can reset it with{' '}
          <code>colp-server reset-password --username &lt;name&gt;</code>.
        </p>
      </div>
    </div>
  )
}
