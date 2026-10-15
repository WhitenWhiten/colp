import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'

/**
 * A personal server has no marketing page: `/` opens the library or sign-in.
 * While the session check fails (the server is down or asked to wait), it
 * stays on the outage state and retries rather than sending a signed-in
 * owner to the sign-in form (R15-23).
 */
export function Landing() {
  const { isLoggedIn, bootstrapping, sessionState } = useAuth()
  if (bootstrapping) return null
  if (!isLoggedIn && sessionState === 'offline') {
    return (
      <PageShell variant="bare">
        <RouteState kind="auth" titleAs="h1" />
      </PageShell>
    )
  }
  return <Navigate to={isLoggedIn ? '/library' : '/login'} replace />
}
