/**
 * In-memory session/CSRF store.
 * csrfToken must NEVER be written to localStorage or sessionStorage.
 */
import type { AuthenticatedSessionView, CsrfToken, MeView, SessionView } from './types'

export type SessionSnapshot = {
  authenticated: boolean
  csrfToken: CsrfToken | null
  idleExpiresAt: string | null
  absoluteExpiresAt: string | null
  me: MeView | null
  sessionEpoch: number
  /**
   * True when GET /api/v1/session reports unverified Better Auth occupancy.
   * Occupancy is not a product actor (`authenticated` stays false, `me` is null).
   */
  verificationRequired: boolean
}

type Listener = (snapshot: SessionSnapshot) => void

let csrfToken: CsrfToken | null = null
let idleExpiresAt: string | null = null
let absoluteExpiresAt: string | null = null
let authenticated = false
let verificationRequired = false
let me: MeView | null = null
let sessionEpoch = 0
const listeners = new Set<Listener>()

function snapshot(): SessionSnapshot {
  return {
    authenticated,
    csrfToken,
    idleExpiresAt,
    absoluteExpiresAt,
    me,
    sessionEpoch,
    verificationRequired,
  }
}

function emit(): void {
  const s = snapshot()
  for (const l of listeners) l(s)
}

export function getSessionSnapshot(): SessionSnapshot {
  return snapshot()
}

/** Cache key for private GETs that may start after /session, before /me. */
export function privateSessionIdentity(snapshot: SessionSnapshot = getSessionSnapshot()): string {
  return `${snapshot.authenticated ? 'session' : 'anonymous'}:${snapshot.sessionEpoch}`
}

export function getCsrfToken(): CsrfToken | null {
  return csrfToken
}

export function isAuthenticated(): boolean {
  return authenticated
}

export function getMe(): MeView | null {
  return me
}

export function applySessionView(view: SessionView): void {
  const previousAuthenticated = authenticated
  const previousCsrf = csrfToken
  const previousOccupancy = verificationRequired
  if (view.authenticated) {
    const auth = view as AuthenticatedSessionView
    authenticated = true
    csrfToken = auth.csrfToken
    idleExpiresAt = auth.idleExpiresAt
    absoluteExpiresAt = auth.absoluteExpiresAt
    verificationRequired = false
  } else {
    authenticated = false
    csrfToken = null
    idleExpiresAt = null
    absoluteExpiresAt = null
    me = null
    verificationRequired = view.verificationRequired === true
  }
  if (
    previousAuthenticated !== authenticated
    || previousCsrf !== csrfToken
    || previousOccupancy !== verificationRequired
  ) sessionEpoch += 1
  emit()
}

export function applyMeView(view: MeView | null): void {
  const previousId = me?.account.id
  const nextId = view?.account.id
  const hydratingFirstActor = previousId === undefined && nextId !== undefined
  if (previousId !== nextId && !hydratingFirstActor) sessionEpoch += 1
  me = view
  emit()
}

export function clearSession(): void {
  if (authenticated || csrfToken || me || verificationRequired) sessionEpoch += 1
  authenticated = false
  csrfToken = null
  idleExpiresAt = null
  absoluteExpiresAt = null
  me = null
  verificationRequired = false
  emit()
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
