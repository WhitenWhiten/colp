import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'

/**
 * Accessible authentication status feedback (migration plan §10 D3).
 *
 * The region renders nothing in the normal signed-in / signed-out states and
 * announces the states a screen reader must not miss: bootstrap loading,
 * transient offline failures, and an expired session (with an auth-restart
 * action). role="status" is a polite live region and role="alert" an
 * assertive one — announcements are delivered without moving focus.
 */
export function AuthStatusRegion() {
  const { sessionState } = useAuth()

  if (sessionState === 'loading') {
    return (
      <p className="auth-notice" role="status">
        Loading your session…
      </p>
    )
  }
  if (sessionState === 'offline') {
    return (
      <p className="auth-notice" role="status">
        You're offline. Some actions may not be available until your connection returns.
      </p>
    )
  }
  if (sessionState === 'verification-required') {
    return (
      <div className="panel panel-pad auth-alert" role="status">
        <p className="auth-alert-text">Verify your email to keep using your account.</p>
        <p className="auth-alert-action">
          <Link to="/verify-email">Verify email</Link>
        </p>
      </div>
    )
  }
  if (sessionState === 'expired') {
    return (
      <div className="panel panel-pad auth-alert" role="alert">
        <p className="auth-alert-text">Your session has expired. Please sign in again.</p>
        <p className="auth-alert-action">
          <Link to="/auth/recovery?auth=restart">Restart your session</Link>
        </p>
      </div>
    )
  }
  return null
}
