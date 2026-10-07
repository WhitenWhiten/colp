import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { BrandName } from '../components/Brand'
import { safeReturnTo } from './safeReturnTo'
import '../styles/auth-pages.css'

type RecoveryKind = 'restart' | 'failed' | 'verification' | 'link' | 'none'

export function AuthRecovery() {
  const [loggingOut, setLoggingOut] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isLoggedIn, logout } = useAuth()

  const returnTo = safeReturnTo(searchParams.get('returnTo'))
  const withReturn = (path: string) => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`
  const authParam = searchParams.get('auth')
  const errorParam = searchParams.get('error')

  let kind: RecoveryKind = 'none'
  if (authParam === 'restart') kind = 'restart'
  else if (authParam === 'failed') kind = 'failed'
  else if (errorParam === 'verification_required') kind = 'verification'
  else if (errorParam === 'account_link_required' || errorParam === 'link_required') kind = 'link'
  else if (errorParam) kind = 'failed'

  const title =
    kind === 'restart'
      ? 'Session ended'
      : kind === 'failed'
        ? 'Sign-in failed'
        : kind === 'verification'
          ? 'Verify your email'
          : kind === 'link'
            ? 'Account linking required'
            : 'Authentication recovery'
  useDocumentTitle(title)

  const body =
    kind === 'restart'
      ? 'Your previous session ended. Sign in again to continue.'
      : kind === 'failed'
        ? 'Your session was not created. Please try again.'
        : kind === 'verification'
          ? 'You need to verify your email before continuing.'
          : kind === 'link'
            ? 'This provider account is not linked to a Know-N account. Sign in with your email and password (or a code) first, then link the provider from your settings.'
            : 'There is nothing to recover on this page.'

  const handleRestart = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logout()
    } finally {
      // Navigate even if logout could not reach the network: the local
      // session state is already cleared by AuthContext.
      navigate(withReturn('/login'), { replace: true })
    }
  }

  const goToLogin = () => {
    navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`)
  }

  return (
    <div className="auth-page">
      <div className="auth-card rise">
        <p className="auth-brand"><BrandName /></p>
        <p className="section-label">Account recovery</p>
        <h1>{title}</h1>
        <p className="sub">{body}</p>

        <div className="auth-cta-stack">
          {kind === 'restart' && (
            <button
              type="button"
              data-testid="recovery-logout"
              className="btn btn-primary"
              disabled={loggingOut}
              onClick={() => {
                void handleRestart()
              }}
            >
              {loggingOut ? 'Signing out…' : 'Sign out and sign in again'}
            </button>
          )}
          {kind === 'failed' && (
            <button
              type="button"
              data-testid="recovery-login"
              className="btn btn-primary"
              onClick={goToLogin}
            >
              Try signing in again
            </button>
          )}
          {kind === 'verification' && (
            <button
              type="button"
              data-testid="recovery-verify"
              className="btn btn-primary"
              onClick={() => navigate(withReturn('/verify-email'))}
            >
              Verify my email
            </button>
          )}
          {kind === 'link' && (
            <button
              type="button"
              data-testid="recovery-login"
              className="btn btn-primary"
              onClick={() => navigate(withReturn('/login'))}
            >
              Sign in instead
            </button>
          )}
          {kind === 'none' && (
            <Link className="btn btn-primary" to={withReturn('/login')}>
              Go to sign in
            </Link>
          )}
          {isLoggedIn && kind !== 'restart' && (
            <button
              type="button"
              data-testid="recovery-continue"
              className="btn btn-secondary"
              onClick={() => navigate(returnTo, { replace: true })}
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
