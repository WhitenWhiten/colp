import { useAuth } from '../auth/AuthContext'

/**
 * R15-23: the browser is online but the session read failed (API outage or
 * brownout). AuthProvider keeps retrying; this says so instead of letting
 * pages fall back to "Sign in".
 */
export function ServiceStatusBanner() {
  const { sessionState } = useAuth()
  if (sessionState !== 'offline') return null
  return (
    <div className="offline-banner" role="status">
      Can&apos;t reach Know-N. Retrying…
    </div>
  )
}
