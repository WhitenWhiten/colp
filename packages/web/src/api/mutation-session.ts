import { ProductApiError } from './errors'
import { getSessionSnapshot } from './sessionStore'

/** Capture primitive identity facts before any asynchronous session refresh. */
export function captureMutationSession(): () => void {
  const { sessionEpoch, authenticated, me } = getSessionSnapshot()
  const accountId = me?.account.id
  return () => {
    const current = getSessionSnapshot()
    if (
      current.sessionEpoch !== sessionEpoch
      || current.authenticated !== authenticated
      || (accountId !== undefined && current.me?.account.id !== accountId)
    ) {
      // A new session (even for the same account) needs a fresh user decision.
      // Never turn this into an automatic retry under replacement cookies.
      throw new ProductApiError({
        status: 409,
        code: 'mutation_conflict',
        message: 'Your session changed. Review the action and submit it again.',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      })
    }
  }
}
