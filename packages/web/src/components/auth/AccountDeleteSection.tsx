import { useState, type FormEvent } from 'react'
import { authClient, type AuthReauthProof } from '../../api/authClient'
import { useAuth } from '../../auth/AuthContext'
import { PasswordField } from './PasswordField'
import { useAuthAction } from './useAuthAction'

const CONFIRMATION = 'DELETE'

/**
 * Irreversible account deletion (P10).
 *
 * Submit is disabled until the user types DELETE. Re-auth is password or
 * a verified-email OTP (same pattern as ProviderLinkSection). On success the
 * product cookie is already cleared; logout() refreshes the signed-out UI.
 */
export function AccountDeleteSection() {
  const { user, logout } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [confirmation, setConfirmation] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const confirmReady = confirmation === CONFIRMATION

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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user || busy || !confirmReady) return
    const reauth = proof()
    if (!reauth) {
      setValidationError('Confirm it is you with your password or an email code.')
      return
    }
    setValidationError(null)
    setMessage(null)
    const ok = await run(() =>
      authClient.deleteAccount({ confirmation: CONFIRMATION, reauth }),
    )
    if (ok) {
      await logout()
    }
  }

  if (!user) return null

  return (
    <section className="settings-section settings-danger" data-testid="delete-account">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Delete account</h3>
        <p className="meta">
          Permanently delete this account. This cannot be undone. Type DELETE to enable deletion,
          then confirm with your password or an email code.
        </p>
      </div>
      <form className="stack settings-form gap-4" data-testid="delete-account-form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="delete-account-confirm">Type DELETE to confirm</label>
          <input
            id="delete-account-confirm"
            data-testid="delete-account-confirm"
            type="text"
            autoComplete="off"
            value={confirmation}
            disabled={busy}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="delete-account-password">Current password</label>
          <PasswordField
            id="delete-account-password"
            data-testid="delete-account-password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="delete-account-otp">Confirmation code</label>
          <input
            id="delete-account-otp"
            data-testid="delete-account-otp"
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
            data-testid="delete-account-send-otp"
            disabled={busy || !user.email}
            onClick={() => {
              void sendReauthCode()
            }}
          >
            {otpSent ? 'Resend code' : 'Send code'}
          </button>
        </div>
        <div className="auth-action-row auth-action-row--danger">
          <button
            type="submit"
            className="btn btn-danger"
            data-testid="delete-account-submit"
            disabled={busy || !confirmReady}
          >
            {busy ? 'Deleting account…' : 'Delete account'}
          </button>
        </div>
      </form>
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
