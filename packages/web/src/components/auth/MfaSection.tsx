import { useState } from 'react'
import { authClient } from '../../api/authClient'
import { PasswordField } from './PasswordField'
import { useAuthAction } from './useAuthAction'

type MfaAction = 'enable' | 'disable' | 'codes'

const PENDING_LABELS: Record<MfaAction, string> = {
  enable: 'Enabling two-factor authentication…',
  disable: 'Disabling two-factor authentication…',
  codes: 'Generating recovery codes…',
}

/**
 * Two-factor authentication enrollment, disable, and recovery codes (D3 §10).
 *
 * Every MFA action requires the current password as the re-auth proof (C4
 * contract). Recovery codes are shown exactly once after enrollment or
 * regeneration and announced as an alert.
 */
export function MfaSection() {
  const { run, busy, error } = useAuthAction()
  const [password, setPassword] = useState('')
  const [totpUri, setTotpUri] = useState<string | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [pending, setPending] = useState<MfaAction | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  async function enable() {
    if (busy) return
    if (!password) {
      setValidationError('Enter your password to continue.')
      return
    }
    setValidationError(null)
    setRecoveryCodes(null)
    setTotpUri(null)
    setPending('enable')
    const result = await run(() => authClient.enableTwoFactor({ password, issuer: 'Know-N' }))
    setPending(null)
    if (result) {
      setTotpUri(result.totpURI)
      setRecoveryCodes(result.backupCodes)
      setPassword('')
    }
  }

  async function regenerateCodes() {
    if (busy) return
    if (!password) {
      setValidationError('Enter your password to continue.')
      return
    }
    setValidationError(null)
    setRecoveryCodes(null)
    setPending('codes')
    const result = await run(() => authClient.generateBackupCodes({ password }))
    setPending(null)
    if (result) {
      setRecoveryCodes(result.backupCodes)
      setPassword('')
    }
  }

  async function disable() {
    if (busy) return
    if (!password) {
      setValidationError('Enter your password to continue.')
      return
    }
    setValidationError(null)
    setPending('disable')
    const ok = await run(() => authClient.disableTwoFactor({ password }))
    setPending(null)
    if (ok) {
      setTotpUri(null)
      setRecoveryCodes(null)
      setPassword('')
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Two-factor authentication</h3>
        <p className="meta">
          Protect your account with an authenticator app. Sensitive changes require your password.
        </p>
      </div>
      <div className="field">
        <label htmlFor="mfa-password">Confirm your password</label>
        <PasswordField
          id="mfa-password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {totpUri && (
        <div className="panel panel-pad" data-testid="mfa-totp-uri">
          <p className="meta">Authenticator app setup URI:</p>
          <code>{totpUri}</code>
        </div>
      )}
      {recoveryCodes && (
        <div className="panel panel-pad auth-alert" data-testid="mfa-recovery-codes">
          <div role="alert">
            <p className="auth-alert-text">
              Save these recovery codes now. They are shown only once.
            </p>
          </div>
          <ul className="security-codes">
            {recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Secondary first: the row is right-aligned, so the primary action is
          last in both reading and tab order. */}
      <div className="auth-action-row">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="mfa-codes"
          disabled={busy}
          onClick={() => {
            void regenerateCodes()
          }}
        >
          Regenerate recovery codes
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="mfa-enable"
          disabled={busy}
          onClick={() => {
            void enable()
          }}
        >
          Enable two-factor authentication
        </button>
      </div>
      <div className="auth-action-row auth-action-row--danger">
        <button
          type="button"
          className="btn btn-danger-ghost"
          data-testid="mfa-disable"
          disabled={busy}
          onClick={() => {
            void disable()
          }}
        >
          Disable two-factor authentication
        </button>
      </div>
      {pending && (
        <p className="auth-notice" role="status">
          {PENDING_LABELS[pending]}
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
