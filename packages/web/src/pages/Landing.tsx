import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

/** A personal server has no marketing page: `/` opens the library or sign-in. */
export function Landing() {
  const { isLoggedIn, bootstrapping } = useAuth()
  if (bootstrapping) return null
  return <Navigate to={isLoggedIn ? '/library' : '/login'} replace />
}
