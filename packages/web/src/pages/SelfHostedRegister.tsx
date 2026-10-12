import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authClient } from '../api/authClient'
import { isProductApiError } from '../api/errors'
import { useAuth } from '../auth/AuthContext'
import { useToast } from '../components/AppToast'
import { BrandName } from '../components/Brand'
import { CommandBlock } from '../components/CommandBlock'
import { MIN_PASSWORD_LENGTH, PasswordField } from '../components/auth/PasswordField'
import { parseRegistrationState, productName, registrationView, type RegistrationState, type RegistrationView } from '../lib/edition'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import '../styles/auth-pages.css'

type Load =
  | { status: 'loading' }
  | { status: 'ready'; state: RegistrationState }
  | { status: 'error'; message: string }

type Field = 'setupToken' | 'username' | 'invite' | 'email' | 'password'
type FieldErrors = Partial<Record<Field, string>>

/** Field order on screen; the first invalid one takes focus. */
const FIELD_ORDER: readonly Field[] = ['setupToken', 'username', 'invite', 'email', 'password']
const FIELD_IDS: Readonly<Record<Field, string>> = {
  setupToken: 'register-setup-token',
  username: 'register-username',
  invite: 'register-invite',
  email: 'register-email',
  password: 'register-password',
}

/** Better Auth's username plugin defaults (3–30, letters, digits, `_` `.`). */
const USERNAME_MIN = 3
const USERNAME_MAX = 30
const USERNAME_SHAPE = /^[A-Za-z0-9_.]+$/u
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

export const SETUP_TOKEN_COMMAND = 'docker compose exec server colp-server setup-token'

function loadErrorMessage(err: unknown): string {
  if (isProductApiError(err)) return err.recoveryHint || err.message
  if (err instanceof Error && err.message) return err.message
  return 'Could not read registration state.'
}

/**
 * Server refusals that belong to one field stay on that field; the rest go
 * to the error toast. The server's username and password messages are a
 * frozen contract (product-error.ts), so matching on them is stable.
 */
function serverFieldError(err: unknown): { field: Field; message: string } | null {
  if (!isProductApiError(err)) return null
  if (err.code === 'setup_token_required') return { field: 'setupToken', message: err.message }
  // Sign-up existence is reported as invalid_credentials (no enumeration);
  // with a username form the only colliding identifier left is the email.
  if (err.code === 'invalid_credentials') return { field: 'email', message: 'Another account already uses this email.' }
  if (err.code === 'invalid_request') {
    if (/username/iu.test(err.message)) return { field: 'username', message: err.message }
    if (/password/iu.test(err.message)) return { field: 'password', message: err.message }
  }
  return null
}

function submitErrorMessage(err: unknown): string {
  if (isProductApiError(err)) {
    if (err.code === 'rate_limited') {
      return err.retryAfterSeconds != null
        ? `Too many attempts. Try again in ${err.retryAfterSeconds}s.`
        : 'Too many attempts. Try again shortly.'
    }
    if (err.code === 'transport_error') return 'Could not reach the server. Check your connection and try again.'
    return err.recoveryHint || err.message
  }
  return 'Could not create the account. Try again.'
}

export function SelfHostedRegister() {
  useDocumentTitle('Create account')
  const navigate = useNavigate()
  const { refreshSession } = useAuth()
  const { error: toastError } = useToast()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [focusField, setFocusField] = useState<Field | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const state = parseRegistrationState(await authClient.getRegistrationState({ signal: controller.signal }))
        if (!controller.signal.aborted) setLoad({ status: 'ready', state })
      } catch (err) {
        if (controller.signal.aborted) return
        setLoad({ status: 'error', message: loadErrorMessage(err) })
      }
    })()
    return () => controller.abort()
  }, [])

  // Inputs are disabled while busy, so focus moves once the submit settles.
  useEffect(() => {
    if (!focusField || busy) return
    document.getElementById(FIELD_IDS[focusField])?.focus()
    setFocusField(null)
  }, [focusField, busy])

  const view: RegistrationView | 'loading' | 'error' = load.status === 'ready'
    ? registrationView(load.state)
    : load.status

  const clearError = (field: Field) => setErrors((current) => {
    if (!current[field]) return current
    const next = { ...current }
    delete next[field]
    return next
  })

  const validate = (form: 'owner' | 'invite'): FieldErrors => {
    const next: FieldErrors = {}
    if (form === 'owner' && setupToken.trim() === '') next.setupToken = 'Paste the setup token from the server.'
    const name = username.trim()
    if (!name) next.username = 'Choose a username.'
    else if (name.length < USERNAME_MIN) next.username = `Use at least ${USERNAME_MIN} characters.`
    else if (name.length > USERNAME_MAX) next.username = `Use at most ${USERNAME_MAX} characters.`
    else if (!USERNAME_SHAPE.test(name)) next.username = 'Use only letters, numbers, dots, and underscores.'
    if (form === 'invite' && inviteCode.trim() === '') next.invite = 'Paste the invite code you were given.'
    if (email.trim() && !EMAIL_SHAPE.test(email.trim())) next.email = 'Enter a full email address, or leave it empty.'
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`
    return next
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if ((view !== 'owner' && view !== 'invite') || busy) return
    const next = validate(view)
    setErrors(next)
    const first = FIELD_ORDER.find((field) => next[field])
    if (first) {
      setFocusField(first)
      return
    }
    setBusy(true)
    try {
      await authClient.signUpWithUsername({
        username: username.trim(),
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
      const fieldError = serverFieldError(err)
      if (fieldError) {
        setErrors({ [fieldError.field]: fieldError.message })
        setFocusField(fieldError.field)
      } else {
        toastError(submitErrorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  // A field's error replaces its hint, except the setup-token help, which
  // stays because it says where to find the value.
  const fieldProps = (field: Field) => {
    const id = FIELD_IDS[field]
    const hintShown = field === 'setupToken' || !errors[field]
    return {
      'aria-invalid': errors[field] ? true : undefined,
      'aria-describedby': [errors[field] ? `${id}-error` : '', hintShown ? `${id}-hint` : ''].filter(Boolean).join(' '),
    }
  }
  const fieldError = (field: Field) => errors[field]
    ? <p id={`${FIELD_IDS[field]}-error`} className="field-error" role="alert">{errors[field]}</p>
    : null

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        {view === 'loading' && (
          <div role="status">
            <p className="section-label">Get started</p>
            <h1>Checking this server…</h1>
          </div>
        )}
        {view === 'error' && load.status === 'error' && (
          <div data-testid="registration-error">
            <p className="section-label">Get started</p>
            <h1>Could not check registration</h1>
            <div className="auth-notice auth-feedback" role="alert">
              <p className="auth-alert-text">{load.message}</p>
            </div>
            <div className="auth-cta-stack">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
            </div>
          </div>
        )}
        {view === 'closed' && (
          <div data-testid="registration-closed">
            <p className="section-label">Accounts</p>
            <h1>Registration is closed</h1>
            <p className="sub">
              {productName()} already has its owner, so sign-up is closed. If this is your server, sign
              in with the account you created.
            </p>
            <div className="auth-cta-stack">
              <Link className="btn btn-primary" to="/login">Sign in</Link>
            </div>
          </div>
        )}
        {(view === 'owner' || view === 'invite') && (
          <form className="auth-form" onSubmit={submit} noValidate data-testid={view === 'owner' ? 'registration-owner' : 'registration-invite'}>
            <div>
              <p className="section-label">{view === 'owner' ? 'First run' : 'Get started'}</p>
              <h1>{view === 'owner' ? 'Create the owner account' : 'Accept your invite'}</h1>
              <p className="sub">
                {view === 'owner'
                  ? 'The owner runs this server: your library, your browsers, and the agents you connect.'
                  : `Join ${productName()} with the invite code its owner gave you.`}
              </p>
            </div>
            {view === 'owner' && (
              <div className="field">
                <label htmlFor="register-setup-token">Setup token</label>
                <input
                  id="register-setup-token"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={setupToken}
                  onChange={(event) => { setSetupToken(event.target.value); clearError('setupToken') }}
                  disabled={busy}
                  required
                  {...fieldProps('setupToken')}
                />
                {fieldError('setupToken')}
                <div className="auth-token-help" id="register-setup-token-hint" data-testid="setup-token-help">
                  <p className="field-hint">
                    The token proves you run this server. Print it where the server runs, or find
                    “First run” in its log:
                  </p>
                  <CommandBlock label="setup token command" command={SETUP_TOKEN_COMMAND} />
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="register-username">Username</label>
              <input
                id="register-username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={USERNAME_MAX}
                value={username}
                onChange={(event) => { setUsername(event.target.value); clearError('username') }}
                disabled={busy}
                required
                {...fieldProps('username')}
              />
              {fieldError('username') ?? (
                <p className="field-hint" id="register-username-hint">
                  {USERNAME_MIN}–{USERNAME_MAX} letters, numbers, dots, or underscores. You sign in with it.
                </p>
              )}
            </div>
            {view === 'invite' && (
              <div className="field">
                <label htmlFor="register-invite">Invite code</label>
                <input
                  id="register-invite"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={inviteCode}
                  onChange={(event) => { setInviteCode(event.target.value); clearError('invite') }}
                  disabled={busy}
                  required
                  {...fieldProps('invite')}
                />
                {fieldError('invite') ?? <p className="field-hint" id="register-invite-hint">From the person who invited you.</p>}
              </div>
            )}
            <div className="field">
              <label htmlFor="register-email">Email <span className="meta">(optional)</span></label>
              <input
                id="register-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => { setEmail(event.target.value); clearError('email') }}
                disabled={busy}
                {...fieldProps('email')}
              />
              {fieldError('email') ?? (
                <p className="field-hint" id="register-email-hint">Lets you sign in with it too. This server sends no mail.</p>
              )}
            </div>
            <div className="field">
              <label htmlFor="register-password">Password</label>
              <PasswordField
                id="register-password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => { setPassword(event.target.value); clearError('password') }}
                disabled={busy}
                required
                {...fieldProps('password')}
              />
              {fieldError('password') ?? (
                <p className="field-hint" id="register-password-hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
              )}
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : view === 'owner' ? 'Create the owner account' : 'Create account'}
            </button>
          </form>
        )}
        {(view === 'owner' || view === 'invite') && (
          <p className="auth-alt">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        )}
      </div>
    </div>
  )
}
