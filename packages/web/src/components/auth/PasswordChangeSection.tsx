import { useEffect, useState, type FormEvent } from 'react'
import { authClient } from '../../api/authClient'
import { useAuth } from '../../auth/AuthContext'
import { PasswordField } from './PasswordField'
import { useAuthAction } from './useAuthAction'

/**
 * Password change or first-time set (P3).
 *
 * Users with a credential keep today's change-password form (current + new,
 * other sessions revoked). OAuth-only users have no credential: they set a
 * password with a mailbox OTP bound to the session user's email, then the
 * section switches to change-password. MFA stays password-gated.
 */
export function PasswordChangeSection() {
  const { user } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [changed, setChanged] = useState(false)
  const [passwordSet, setPasswordSet] = useState(false)
  const [pending, setPending] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const sessionEmail = user?.email ?? null

  useEffect(() => {
    let cancelled = false
    authClient
      .listLinkedAccounts()
      .then((result) => {
        if (cancelled) return
        // Explicit false → set-password. Missing/true → today's change form.
        setHasPassword(result.hasPassword !== false)
      })
      .catch(() => {
        if (!cancelled) setHasPassword(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function submitChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (!currentPassword || !newPassword) {
      setValidationError('Enter your current and new password.')
      return
    }
    setValidationError(null)
    setChanged(false)
    setPending(true)
    const ok = await run(() =>
      authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions: true }),
    )
    setPending(false)
    if (ok) {
      setChanged(true)
      setCurrentPassword('')
      setNewPassword('')
    }
  }

  async function sendSetPasswordOtp() {
    if (busy) return
    if (!sessionEmail) {
      setValidationError('Your session has no email. Sign in again to continue.')
      return
    }
    setValidationError(null)
    setNotice(null)
    const ok = await run(() => authClient.requestForgetPasswordOtp({ email: sessionEmail }))
    if (ok) {
      setOtpSent(true)
      setNotice(`We sent a confirmation code to ${sessionEmail}.`)
    }
  }

  async function submitSetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (!sessionEmail) {
      setValidationError('Your session has no email. Sign in again to continue.')
      return
    }
    if (!otp || !newPassword) {
      setValidationError('Enter the confirmation code and a new password.')
      return
    }
    setValidationError(null)
    setNotice(null)
    setPending(true)
    const ok = await run(() =>
      authClient.resetPasswordWithOtp({
        email: sessionEmail,
        otp: otp.trim(),
        password: newPassword,
      }),
    )
    setPending(false)
    if (ok) {
      setHasPassword(true)
      setPasswordSet(true)
      setOtp('')
      setNewPassword('')
      setOtpSent(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">{hasPassword === false ? 'Set a password' : 'Password'}</h3>
        {hasPassword === null && <p className="meta">Checking…</p>}
        {hasPassword === false && (
          <p className="meta">
            Set a password so you can change it later and enable two-factor authentication.
            {sessionEmail ? ` We'll send a confirmation code to ${sessionEmail}.` : ''}
          </p>
        )}
        {hasPassword === true && (
          <p className="meta">Change the password you use to sign in.</p>
        )}
      </div>
      {hasPassword === false && (
        <>
          <form className="stack settings-form gap-4" data-testid="set-password-form" onSubmit={submitSetPassword}>
            {otpSent && (
              <>
                <div className="field">
                  <label htmlFor="set-pw-otp">Confirmation code</label>
                  <input
                    id="set-pw-otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otp}
                    disabled={busy}
                    onChange={(e) => setOtp(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="set-pw-new">New password</label>
                  <PasswordField
                    id="set-pw-new"
                    autoComplete="new-password"
                    value={newPassword}
                    disabled={busy}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
              </>
            )}
            {/* Secondary first: the row is right-aligned, so the primary action
                is last in both reading and tab order. */}
            <div className="auth-action-row">
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="set-password-send-otp"
                disabled={busy || !sessionEmail}
                onClick={() => {
                  void sendSetPasswordOtp()
                }}
              >
                {otpSent ? 'Resend code' : 'Send code'}
              </button>
              {otpSent && (
                <button type="submit" className="btn btn-primary" data-testid="set-password" disabled={busy}>
                  {busy ? 'Setting password…' : 'Set a password'}
                </button>
              )}
            </div>
          </form>
          {pending && (
            <p className="auth-notice" role="status">
              Setting your password…
            </p>
          )}
        </>
      )}
      {hasPassword === true && (
        <>
          <form className="stack settings-form gap-4" onSubmit={submitChange}>
            <div className="field">
              <label htmlFor="pw-current">Current password</label>
              <PasswordField
                id="pw-current"
                autoComplete="current-password"
                value={currentPassword}
                disabled={busy}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="pw-new">New password</label>
              <PasswordField
                id="pw-new"
                autoComplete="new-password"
                value={newPassword}
                disabled={busy}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <p className="meta">Other signed-in devices will be signed out.</p>
            <div className="auth-action-row">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Changing password…' : 'Change password'}
              </button>
            </div>
          </form>
          {pending && (
            <p className="auth-notice" role="status">
              Changing your password. Other sessions are being signed out.
            </p>
          )}
          {passwordSet && (
            <p className="auth-notice" role="status">
              Password set.
            </p>
          )}
          {changed && (
            <p className="auth-notice" role="status">
              Password changed.
            </p>
          )}
        </>
      )}
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
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
