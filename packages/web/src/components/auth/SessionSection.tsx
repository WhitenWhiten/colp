import { useEffect, useState } from 'react'
import { authClient, type ProductSessionInfo } from '../../api/authClient'
import { useAuth } from '../../auth/AuthContext'
import { useAuthAction } from './useAuthAction'

function formatSessionTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Session inventory (P4).
 *
 * Other devices are listed by BA session id from GET /api/v1/auth/sessions.
 * Revoke posts that id (never a token). Signing out this device still goes
 * through product logout (DELETE /api/v1/session).
 */
export function SessionSection() {
  const { user, logout } = useAuth()
  const { run, busy, error } = useAuthAction()
  const [pending, setPending] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [sessions, setSessions] = useState<readonly ProductSessionInfo[]>([])

  useEffect(() => {
    let cancelled = false
    authClient
      .listSessions()
      .then((result) => {
        if (!cancelled) setSessions(result.sessions)
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const otherSessions = sessions.filter((session) => !session.current)

  async function signOutThisDevice() {
    if (!user || busy) return
    setMessage(null)
    setPending(true)
    const outcome = await run(logout)
    setPending(false)
    if (outcome === 'signed-out') {
      setMessage('This session was signed out.')
    } else if (outcome === 'failed') {
      setMessage("Couldn't sign out. You may still be signed in on this device.")
    }
  }

  async function revokeOther(sessionId: string) {
    if (!user || busy) return
    setMessage(null)
    setRevokingId(sessionId)
    const ok = await run(async () => {
      await authClient.revokeSessionById({ sessionId })
      return true
    })
    setRevokingId(null)
    if (ok) {
      setSessions((current) => current.filter((session) => session.id !== sessionId))
      setMessage('That session was signed out.')
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-toggle-label">Sessions</h3>
        <p className="meta">Devices signed in to this account.</p>
      </div>
      {/* This device first, then the others. Every row signs its session out;
          the device has to sign in again. */}
      <ul className="security-list" aria-label="Sessions">
        <li className="toggle-row">
          <strong>This device</strong>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="revoke-session"
            disabled={busy || !user}
            onClick={() => {
              void signOutThisDevice()
            }}
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </li>
        {otherSessions.map((session) => (
          <li key={session.id} className="toggle-row" data-testid="other-session">
            <span>Last active {formatSessionTime(session.updatedAt)}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="revoke-other-session"
              disabled={busy || !user}
              onClick={() => {
                void revokeOther(session.id)
              }}
            >
              {revokingId === session.id ? 'Signing out…' : 'Sign out'}
            </button>
          </li>
        ))}
      </ul>
      {otherSessions.length === 0 && <p className="meta">No other devices are signed in.</p>}
      {pending && (
        <p className="auth-notice" role="status">
          Signing out this session…
        </p>
      )}

      {message && (
        <p className="auth-notice" role="status">
          {message}
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
