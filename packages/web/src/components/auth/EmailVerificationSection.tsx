import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { authClient } from '../../api/authClient'
import { SECURITY_SETTINGS_URL } from '../../lib/useSettingsDialog'
import { useAuthAction } from './useAuthAction'

/**
 * Verified-email status + verification resend (D3 §10).
 *
 * The verified fact comes from the compat auth session
 * (GET /api/v1/auth/get-session) — never from the product /me shape — and
 * the send action goes through the typed auth client. Email-delivery
 * failures surface as accessible inline feedback.
 */
export function EmailVerificationSection() {
  const { user, verificationRequired } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [verified, setVerified] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(true)
  const [sent, setSent] = useState(false)
  const [sessionEmail, setSessionEmail] = useState('')

  const occupancy = verificationRequired || !!user

  useEffect(() => {
    if (!occupancy) return
    let cancelled = false
    setChecking(true)
    setSent(false)
    authClient
      .getAuthSession()
      .then((info) => {
        if (cancelled) return
        setSessionEmail(info?.user.email ?? '')
        setVerified(info?.user.emailVerified === true)
        setChecking(false)
      })
      .catch(() => {
        if (cancelled) return
        setVerified(null)
        setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [occupancy])

  if (!occupancy) return null
  const email = user?.email || sessionEmail

  async function resend() {
    setSent(false)
    const ok = await run(() =>
      authClient.sendVerificationEmail({ email, callbackURL: SECURITY_SETTINGS_URL }),
    )
    if (ok) setSent(true)
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Email address</h3>
        <p className="meta">{email || 'No email on this account.'}</p>
      </div>
      {checking ? (
        <p className="meta" role="status">
          Checking verification status…
        </p>
      ) : verified === true ? (
        <p className="auth-notice" data-testid="email-verified" role="status">
          Email verified
        </p>
      ) : (
        <>
          <p className="meta">
            Your email is not verified yet. Verify it to keep full account recovery access.
          </p>
          <div className="auth-action-row">
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="verify-email"
              disabled={busy || !email}
              onClick={() => {
                void resend()
              }}
            >
              {busy ? 'Sending…' : 'Send verification email'}
            </button>
          </div>
        </>
      )}
      {sent && (
        <p className="auth-notice" role="status">
          A verification email was sent to {email}.
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
