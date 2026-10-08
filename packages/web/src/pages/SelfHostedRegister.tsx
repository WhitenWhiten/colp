import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import { BrandName } from '../components/Brand'
import { MIN_PASSWORD_LENGTH, PasswordField } from '../components/auth/PasswordField'
import { parseRegistrationState, registrationView, type RegistrationState, type RegistrationView } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import '../styles/auth-pages.css'

type Load =
  | { status: 'loading' }
  | { status: 'ready'; state: RegistrationState }
  | { status: 'error'; message: string }

function errorMessage(err: unknown): string {
  if (isProductApiError(err)) return err.recoveryHint || err.message
  if (err instanceof Error && err.message) return err.message
  return 'Could not read registration state.'
}

export function SelfHostedRegister() {
  useDocumentTitle('Create account')
  const navigate = useNavigate()
  const { refreshSession } = useAuth()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const state = parseRegistrationState(await authClient.getRegistrationState({ signal: controller.signal }))
        if (!controller.signal.aborted) setLoad({ status: 'ready', state })
      } catch (err) {
        if (controller.signal.aborted) return
        setLoad({ status: 'error', message: errorMessage(err) })
      }
    })()
    return () => controller.abort()
  }, [])

  const view: RegistrationView | 'loading' | 'error' = load.status === 'ready'
    ? registrationView(load.state)
    : load.status

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (view !== 'owner' && view !== 'invite') return
    setFormError(null)
    const nextUsername = username.trim()
    if (!nextUsername) {
      setFormError('Enter a username.')
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (view === 'invite' && inviteCode.trim() === '') {
      setFormError('Enter an invite code.')
      return
    }
    if (view === 'owner' && setupToken.trim() === '') {
      setFormError('Enter the setup token from the server log.')
      return
    }
    setBusy(true)
    try {
      await authClient.signUpWithUsername({
        username: nextUsername,
        password,
        ...(email.trim() ? { email: email.trim().toLowerCase() } : {}),
        ...(view === 'invite' ? { inviteCode: inviteCode.trim() } : {}),
        ...(view === 'owner' ? { setupToken: setupToken.trim() } : {}),
        callbackURL: '/library',
      })
      await refreshSession().catch(() => {
        // The auth client already refreshed the product session store.
      })
      navigate('/library', { replace: true })
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        {view === 'loading' && <p className="sub" role="status">Checking registration…</p>}
        {view === 'error' && load.status === 'error' && (
          <div className="panel panel-pad auth-alert auth-feedback" role="alert" data-testid="registration-error">
            <p className="auth-alert-text">{load.message}</p>
          </div>
        )}
        {view === 'closed' && (
          <div data-testid="registration-closed">
            <h1>Registration is closed</h1>
            <p className="sub">This server already has its owner account. Sign in instead.</p>
            <Link className="btn btn-primary" to="/login">Sign in</Link>
          </div>
        )}
        {(view === 'owner' || view === 'invite') && (
          <form className="auth-form" onSubmit={submit} noValidate data-testid={view === 'owner' ? 'registration-owner' : 'registration-invite'}>
            <h1>{view === 'owner' ? 'Create the owner account' : 'Accept an invite'}</h1>
            <p className="sub">
              {view === 'owner'
                ? 'Choose a username and a password. Email is optional.'
                : 'Use the invite code from the server owner. Email is optional.'}
            </p>
            {view === 'owner' && (
              <p className="sub" data-testid="setup-token-help">
                The setup token proves you run this server. Find it with{' '}
                <code>docker compose logs server | grep "setup token"</code> or{' '}
                <code>docker compose exec server colp-server setup-token</code>.
              </p>
            )}
            {formError && (
              <div className="panel panel-pad auth-alert auth-feedback" role="alert">
                <p className="auth-alert-text">{formError}</p>
              </div>
            )}
            {view === 'owner' && (
              <div className="field">
                <label htmlFor="register-setup-token">Setup token</label>
                <input
                  id="register-setup-token"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={setupToken}
                  onChange={(event) => setSetupToken(event.target.value)}
                  disabled={busy}
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="register-username">Username</label>
              <input
                id="register-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
                required
              />
            </div>
            {view === 'invite' && (
              <div className="field">
                <label htmlFor="register-invite">Invite code</label>
                <input
                  id="register-invite"
                  type="text"
                  autoComplete="off"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  disabled={busy}
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="register-email">Email <span className="meta">(optional)</span></label>
              <input
                id="register-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor="register-password">Password</label>
              <PasswordField
                id="register-password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : view === 'owner' ? 'Create the owner account' : 'Create account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
