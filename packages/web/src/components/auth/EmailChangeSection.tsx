import { useEffect, useState, type FormEvent } from 'react'
import { authClient } from '../../api/authClient'
import { useAuth } from '../../auth/AuthContext'
import { useAuthAction } from './useAuthAction'

/**
 * Change the session user's email (P9).
 *
 * OTP is sent to the **new** address (`requestEmailChange`). Confirm consumes
 * that OTP (`changeEmail`); the product user id stays the same. Occupied
 * targets are non-enumerating on send; confirm failures surface the product
 * `message` via `useAuthAction`.
 *
 * Current mailbox comes from GET /get-session (`auth_users.email`), not
 * `/me` (`accounts.email` is often still null after password occupancy).
 */
export function EmailChangeSection() {
  const { user } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [mailboxEmail, setMailboxEmail] = useState(user?.email ?? '')
  const [newEmail, setNewEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [changed, setChanged] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    authClient
      .getAuthSession()
      .then((info) => {
        if (!cancelled && typeof info?.user.email === 'string' && info.user.email.length > 0) {
          setMailboxEmail(info.user.email)
        }
      })
      .catch(() => {
        /* keep useAuth fallback */
      })
    return () => {
      cancelled = true
    }
  }, [user])

  const currentEmail = mailboxEmail

  async function sendCode() {
    if (busy) return
    const trimmed = newEmail.trim()
    if (!trimmed) {
      setValidationError('Enter a new email address.')
      return
    }
    setValidationError(null)
    setNotice(null)
    setChanged(false)
    const ok = await run(() => authClient.requestEmailChange({ newEmail: trimmed }))
    if (ok) {
      setOtpSent(true)
      setNotice('If that address can receive mail, we sent a confirmation code.')
    }
  }

  async function submitConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const trimmed = newEmail.trim()
    if (!trimmed || !otp.trim()) {
      setValidationError('Enter the new email and confirmation code.')
      return
    }
    setValidationError(null)
    setNotice(null)
    const ok = await run(() => authClient.changeEmail({ newEmail: trimmed, otp: otp.trim() }))
    if (ok) {
      setChanged(true)
      setMailboxEmail(trimmed)
      setOtp('')
      setOtpSent(false)
      setNewEmail('')
    }
  }

  if (!user) return null

  return (
    <section className="settings-section" data-testid="change-email">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Change email</h3>
        <p className="meta">
          Current email: <span data-testid="change-email-current">{currentEmail}</span>
        </p>
      </div>
      <form className="stack settings-form gap-4" data-testid="change-email-form" onSubmit={submitConfirm}>
        <div className="field">
          <label htmlFor="change-email-new">New email</label>
          <input
            id="change-email-new"
            data-testid="change-email-new"
            type="email"
            autoComplete="email"
            value={newEmail}
            disabled={busy}
            onChange={(e) => setNewEmail(e.target.value)}
          />
        </div>
        {otpSent && (
          <div className="field">
            <label htmlFor="change-email-otp">Confirmation code</label>
            <input
              id="change-email-otp"
              data-testid="change-email-otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otp}
              disabled={busy}
              onChange={(e) => setOtp(e.target.value)}
            />
          </div>
        )}
        {/* Secondary first: the row is right-aligned, so the primary action is
            last in both reading and tab order. */}
        <div className="auth-action-row">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="change-email-send"
            disabled={busy}
            onClick={() => {
              void sendCode()
            }}
          >
            {otpSent ? 'Resend code' : 'Send code'}
          </button>
          {otpSent && (
            <button type="submit" className="btn btn-primary" data-testid="change-email-confirm" disabled={busy}>
              {busy ? 'Changing email…' : 'Confirm new email'}
            </button>
          )}
        </div>
      </form>
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      )}
      {changed && (
        <p className="auth-notice" data-testid="change-email-done" role="status">
          Email updated.
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
