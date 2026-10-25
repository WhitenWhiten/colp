import { useState, type FormEvent } from 'react'
import { authClient, type AuthReauthProof } from '../../api/authClient'
import { useAuth } from '../../auth/AuthContext'
import { PasswordField } from './PasswordField'
import { useAuthAction } from './useAuthAction'

const CONFIRMATION = 'DELETE'

/**
 * Irreversible account deletion (P10).
 *
 * Submit is disabled until the user types DELETE. The server sends no email
 * (D28), so the password is the only re-auth. On success the product cookie
 * is already cleared; logout() refreshes the signed-out UI.
 */
export function AccountDeleteSection() {
  const { user, logout } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [confirmation, setConfirmation] = useState('')
  const [password, setPassword] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const confirmReady = confirmation === CONFIRMATION

  function proof(): AuthReauthProof | null {
    return password.length > 0 ? { kind: 'password', password } : null
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!user || busy || !confirmReady) return
    const reauth = proof()
    if (!reauth) {
      setValidationError('Enter your password to confirm.')
      return
    }
    setValidationError(null)
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
        <p className="meta">Permanently delete this account. This can't be undone.</p>
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
