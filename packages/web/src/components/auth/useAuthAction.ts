import { useCallback, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { isProductApiError } from '../../api/errors'

/** Typed ProductApiError → user-facing message for auth settings actions. */
export function authActionErrorMessage(
  err: unknown,
  fallback = 'That action could not be completed. Try again.',
): string {
  if (isProductApiError(err)) {
    if (err.code === 'rate_limited') {
      return err.retryAfterSeconds != null
        ? `Too many requests. Try again in ${err.retryAfterSeconds}s.`
        : 'Too many requests. Try again shortly.'
    }
    if (err.code === 'email_delivery_unavailable') {
      return 'Email delivery is temporarily unavailable. Try again shortly.'
    }
    if (err.code === 'authentication_required') {
      return 'Your session ended. Sign in again to continue.'
    }
    if (err.code === 'csrf_failed') {
      return 'Session security token expired. Try again.'
    }
    if (err.code === 'transport_error') {
      return 'Network error. Check your connection and try again.'
    }
    if (err.code === 'invalid_request') {
      // P7: linking/unlinking returns distinct product `message` values on the
      // existing invalid_request wire code — surface them verbatim.
      return err.message
    }
    return err.recoveryHint || err.message
  }
  return fallback
}

/**
 * Shared busy/error state for sensitive auth settings actions (D3 §10).
 * The CSRF-retry-once and refresh-after-success semantics live in
 * AuthContext.runAuthMutation; this hook only tracks UI state and maps
 * typed errors to accessible feedback. `run` returns the action result on
 * success and `undefined` when the action failed or was already in flight.
 */
export function useAuthAction() {
  const { runAuthMutation } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlightRef.current) return undefined
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    try {
      return await runAuthMutation(action)
    } catch (err) {
      setError(authActionErrorMessage(err))
      return undefined
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }, [runAuthMutation])

  return { run, busy, error }
}
