import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  isProductApiError,
  productClient,
} from '../api'
import type { MeView, SessionSnapshot } from '../api'
import { captureMutationSession } from '../api/mutation-session'

export type AuthUser = {
  name: string
  handle: string
  email: string
  initials: string
  accountId: string
  profileId: string
  /** HTTPS avatar URL when the profile has one. */
  avatarUrl?: string | null
  /** Public self-introduction. Empty string when unset. */
  about?: string
}

/**
 * Accessible auth-state feedback (D3 §10): the UI announces loading,
 * offline, expired, and verification-required occupancy; ready/signed-out
 * render nothing in AuthStatusRegion.
 */
export type AuthSessionState =
  | 'loading'
  | 'ready'
  | 'signed-out'
  | 'expired'
  | 'offline'
  | 'verification-required'

type AuthCtx = {
  user: AuthUser | null
  isLoggedIn: boolean
  /** True until first session bootstrap finishes. */
  bootstrapping: boolean
  /** In-memory CSRF token (never persisted to localStorage). */
  csrfToken: string | null
  /**
   * Accessible session state for loading / expired / offline / occupancy feedback.
   * 'expired' means a session that existed ended (or could not be
   * established); 'signed-out' is the normal signed-out baseline;
   * 'verification-required' is unverified Better Auth occupancy (not a product actor).
   */
  sessionState: AuthSessionState
  /** True when product /session reported unverified occupancy. */
  verificationRequired: boolean
  /**
   * Re-run GET /session + GET /me (e.g. after refresh or CSRF failure).
   * Bootstrap always starts from the product /api/v1/session contract and
   * never reads the Better Auth session cookie value (the browser manages
   * the cookie; the CSRF token stays in memory only).
   */
  refreshSession: () => Promise<void>
  /**
   * Re-read the session after sensitive auth settings actions. A csrf_failed
   * response permits at most one refresh/retry, and only while the original
   * account and session epoch are unchanged. A replacement session requires
   * a fresh user action instead of replaying the retained mutation body.
   */
  runAuthMutation: <T>(action: () => Promise<T>) => Promise<T>
  /**
   * Clear local state, then DELETE /api/v1/session. Resolves 'failed' when
   * the server session may have survived; the session is then re-read so
   * the UI shows whether this device is still signed in (R15-21).
   */
  logout: () => Promise<LogoutOutcome>
}

export type LogoutOutcome = 'signed-out' | 'failed'

function meToUser(me: MeView): AuthUser {
  const name = me.profile.displayName || me.profile.handle
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || me.profile.handle.slice(0, 2).toUpperCase()
  return {
    name,
    handle: me.profile.handle,
    email: me.account.email ?? '',
    initials,
    accountId: me.account.id,
    profileId: me.profile.id,
    avatarUrl: me.profile.avatarUrl,
    about: me.profile.about ?? '',
  }
}

const Ctx = createContext<AuthCtx>({
  user: null,
  isLoggedIn: false,
  bootstrapping: true,
  csrfToken: null,
  sessionState: 'loading',
  verificationRequired: false,
  refreshSession: async () => {},
  runAuthMutation: async (action) => action(),
  logout: async () => 'signed-out',
})

const OFFLINE_RETRY_BASE_MS = 5_000
const OFFLINE_RETRY_MAX_MS = 60_000

export function useAuth() {
  return useContext(Ctx)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [sessionState, setSessionState] = useState<AuthSessionState>('loading')
  const sessionOperation = useRef(0)
  const refreshController = useRef<AbortController | null>(null)
  /* R15-23: consecutive failed bootstraps; drives the offline retry backoff. */
  const [offlineAttempt, setOfflineAttempt] = useState(0)

  const applySnapshot = useCallback((snap: SessionSnapshot) => {
    setCsrfToken(snap.csrfToken)
    if (snap.authenticated && snap.me) {
      setUser(meToUser(snap.me))
      setSessionState('ready')
    } else if (snap.verificationRequired) {
      setUser(null)
      setSessionState('verification-required')
    } else if (!snap.authenticated) {
      setUser(null)
      // A session store flip to signed-out while the app was running means
      // the session ended (server revocation) rather than a clean sign-out.
      setSessionState((prev) =>
        prev === 'ready' || prev === 'offline' || prev === 'expired' ? 'expired' : 'signed-out',
      )
    }
  }, [])

  const refreshSession = useCallback(async () => {
    const operation = ++sessionOperation.current
    refreshController.current?.abort()
    const controller = new AbortController()
    refreshController.current = controller
    try {
      // Bootstrap contract (Task D1): GET /api/v1/session first, then
      // GET /api/v1/me when authenticated. The Better Auth session cookie
      // is never read here — credentials:'include' lets the browser attach
      // it, and the CSRF token stays in memory only.
      const { session, me } = await productClient.bootstrapSession({ signal: controller.signal })
      if (controller.signal.aborted || operation !== sessionOperation.current) return
      setOfflineAttempt(0)
      if (me) {
        setUser(meToUser(me))
        setSessionState('ready')
      } else if (!session.authenticated && session.verificationRequired === true) {
        setUser(null)
        setSessionState('verification-required')
      } else {
        setUser(null)
        setSessionState((prev) =>
          prev === 'ready' || prev === 'offline' || prev === 'expired' ? 'expired' : 'signed-out',
        )
      }
    } catch (err) {
      if (controller.signal.aborted || operation !== sessionOperation.current) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      // Unified error mapping (Task D1): both authentication_required and
      // csrf_failed are terminal — the session cannot be established, so the
      // UI must behave as signed out (recoveryForCode maps both to
      // 'reauthenticate'). An existing session that just ended is announced
      // as 'expired' (D3) instead of a plain sign-out.
      if (isProductApiError(err) && err.isVerificationRequired) {
        setUser(null)
        setCsrfToken(null)
        setSessionState('verification-required')
        return
      }
      if (isProductApiError(err) && (err.isAuthRequired || err.isCsrfFailed)) {
        setUser(null)
        setCsrfToken(null)
        setSessionState((prev) =>
          prev === 'ready' || prev === 'offline' || prev === 'expired' ? 'expired' : 'signed-out',
        )
        return
      }
      // Transient failures keep the previous user; announce offline (D3).
      setSessionState('offline')
      setOfflineAttempt((n) => n + 1)
      console.warn('[auth] bootstrap failed', err)
    } finally {
      if (refreshController.current === controller) refreshController.current = null
    }
  }, [])

  const runAuthMutation = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    const assertOriginalSession = captureMutationSession()
    try {
      const result = await action()
      // After any sensitive auth mutation, re-read /api/v1/session + /me so
      // the UI never shows stale credentials (D3 contract).
      await refreshSession().catch(() => {})
      return result
    } catch (err) {
      if (isProductApiError(err) && err.isCsrfFailed) {
        assertOriginalSession()
        await refreshSession().catch(() => {})
        // CSRF refresh may have discovered another tab's replacement login.
        // Never replay the old account's sensitive settings action in that case.
        assertOriginalSession()
        const retried = await action()
        await refreshSession().catch(() => {})
        return retried
      }
      throw err
    }
  }, [refreshSession])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setBootstrapping(true)
      try {
        await refreshSession()
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    })()
    return () => {
      cancelled = true
      sessionOperation.current += 1
      refreshController.current?.abort()
    }
  }, [refreshSession])

  /* R15-23: while the session cannot be read (API down, not the network),
     retry with backoff and on reconnect so the outage banner clears itself. */
  useEffect(() => {
    if (sessionState !== 'offline') return
    const delay = Math.min(OFFLINE_RETRY_MAX_MS, OFFLINE_RETRY_BASE_MS * 2 ** Math.max(0, offlineAttempt - 1))
    const retry = () => { void refreshSession().catch(() => {}) }
    const timer = setTimeout(retry, delay)
    window.addEventListener('online', retry)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('online', retry)
    }
  }, [sessionState, offlineAttempt, refreshSession])

  useEffect(() => productClient.subscribeSession(applySnapshot), [applySnapshot])

  const logout = useCallback(async (): Promise<LogoutOutcome> => {
    sessionOperation.current += 1
    refreshController.current?.abort()
    setUser(null)
    setCsrfToken(null)
    setSessionState('signed-out')
    try {
      await productClient.deleteSession()
      return 'signed-out'
    } catch (err) {
      console.warn('[auth] logout failed', err)
      await refreshSession().catch(() => {})
      return 'failed'
    }
  }, [refreshSession])

  const value = useMemo(
    () => ({
      user,
      isLoggedIn: !!user,
      bootstrapping,
      csrfToken,
      sessionState,
      verificationRequired: sessionState === 'verification-required',
      refreshSession,
      runAuthMutation,
      logout,
    }),
    [user, bootstrapping, csrfToken, sessionState, refreshSession, runAuthMutation, logout],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
