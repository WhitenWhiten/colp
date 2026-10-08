import { isAuthenticated } from './sessionStore'

/** A locally anonymous read must not recover a member projection through a stale cookie. */
export function productRequestCredentials(method = 'GET'): RequestCredentials {
  return ['GET', 'HEAD'].includes(method.toUpperCase()) && !isAuthenticated() ? 'omit' : 'include'
}
