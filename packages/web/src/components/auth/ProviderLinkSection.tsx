import { useEffect, useState, type FormEvent } from 'react'
import { authClient, type AuthReauthProof } from '../../api/authClient'
import { useAuth } from '../../auth/AuthContext'
import { SECURITY_SETTINGS_ERROR_CALLBACK_URL, SECURITY_SETTINGS_URL } from '../../lib/useSettingsDialog'
import { PasswordField } from './PasswordField'
import { useAuthAction } from './useAuthAction'

const PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
] as const

export type ProviderId = (typeof PROVIDERS)[number]['id']

type LinkedMap = ReadonlyMap<ProviderId, string>

/**
 * Sign-in provider link/unlink (D3 §10).
 *
 * Linking/unlinking are sensitive operations: the backend requires a
 * re-auth proof (password or verified-email OTP). The provider account
 * list is loaded from GET /api/v1/auth/linked-accounts so Google/GitHub
 * sign-in is shown as Connected without a separate explicit link.
 */
export function ProviderLinkSection() {
  const { user } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null)
  const [linked, setLinked] = useState<LinkedMap>(new Map())
  const [message, setMessage] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    authClient
      .listLinkedAccounts()
      .then((result) => {
        if (cancelled) return
        const next = new Map<ProviderId, string>()
        for (const account of result.accounts) {
          if (account.providerId === 'google' || account.providerId === 'github') {
            next.set(account.providerId, account.accountId)
          }
        }
        setLinked(next)
      })
      .catch(() => {
        if (!cancelled) setLinked(new Map())
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function proof(): AuthReauthProof | null {
    const code = otp.trim()
    if (code.length > 0 && user?.email) {
      return { kind: 'otp', email: user.email, otp: code }
    }
    if (password.length > 0) {
      return { kind: 'password', password }
    }
    return null
  }

  async function sendReauthCode() {
    if (!user?.email || busy) return
    setValidationError(null)
    setMessage(null)
    const ok = await run(() => authClient.sendOtp({ email: user.email, type: 'email-verification' }))
    if (ok) {
      setOtpSent(true)
      setMessage(`We sent a confirmation code to ${user.email}.`)
    }
  }

  async function connect(providerId: ProviderId) {
    if (pendingProvider) return
    const reauth = proof()
    if (!reauth) {
      setValidationError('Confirm it is you with your password or an email code.')
      return
    }
    setValidationError(null)
    setMessage(null)
    setPendingProvider(providerId)
    const result = await run(() =>
      authClient.linkOAuth({
        providerId,
        callbackURL: SECURITY_SETTINGS_URL,
        errorCallbackURL: SECURITY_SETTINGS_ERROR_CALLBACK_URL,
        reauth,
      }),
    )
    setPendingProvider(null)
    if (!result) return
    if (result.redirect && result.url) {
      const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location
      if (loc && typeof loc.assign === 'function') {
        loc.assign(result.url)
        return
      }
    }
    setLinked((prev) => new Map(prev).set(providerId, providerId))
    setMessage(`${PROVIDERS.find((p) => p.id === providerId)!.label} is connected.`)
  }

  async function disconnect(providerId: ProviderId) {
    if (pendingProvider) return
    const accountId = linked.get(providerId)
    if (!accountId) return
    const reauth = proof()
    if (!reauth) {
      setValidationError('Confirm it is you with your password or an email code.')
      return
    }
    setValidationError(null)
    setMessage(null)
    setPendingProvider(providerId)
    const ok = await run(() => authClient.unlinkOAuth({ providerId, accountId, reauth }))
    setPendingProvider(null)
    if (ok) {
      const next = new Map(linked)
      next.delete(providerId)
      setLinked(next)
      setMessage(`${PROVIDERS.find((p) => p.id === providerId)!.label} is disconnected.`)
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Sign-in providers</h3>
        <p className="meta">
          Connect Google or GitHub to sign in without a password. Linking and unlinking require re-authentication.
        </p>
      </div>
      <form className="stack settings-form gap-4" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="link-reauth-password">Current password</label>
          <PasswordField
            id="link-reauth-password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="link-reauth-otp">Confirmation code</label>
          <input
            id="link-reauth-otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            disabled={busy}
            onChange={(e) => setOtp(e.target.value)}
          />
        </div>
        <div className="auth-action-row">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="link-send-otp"
            disabled={busy || !user?.email}
            onClick={() => {
              void sendReauthCode()
            }}
          >
            {otpSent ? 'Resend code' : 'Send code'}
          </button>
        </div>
      </form>
      <div className="stack">
        {PROVIDERS.map((provider) => {
          const isLinked = linked.has(provider.id)
          const isPending = pendingProvider === provider.id
          return (
            <div className="toggle-row" key={provider.id}>
              <div>
                <strong className="settings-toggle-label">{provider.label}</strong>
                <span className="meta">
                  {loading ? 'Checking…' : isLinked ? 'Connected' : 'Not connected'}
                </span>
              </div>
              {isLinked ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid={`unlink-${provider.id}`}
                  disabled={busy}
                  onClick={() => {
                    void disconnect(provider.id)
                  }}
                >
                  {isPending ? 'Waiting for re-authentication…' : 'Disconnect'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid={`link-${provider.id}`}
                  disabled={busy || loading}
                  onClick={() => {
                    void connect(provider.id)
                  }}
                >
                  {isPending ? 'Waiting for re-authentication…' : 'Connect'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {pendingProvider && (
        <p className="auth-notice" role="status">
          Waiting for re-authentication…
        </p>
      )}
      {message && (
        <p className="auth-notice" role="status">
          {message}
        </p>
      )}
      {validationError && (
        <p className="field-error" role="alert">
          {validationError}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
