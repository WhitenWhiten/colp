/**
 * Task D1: authentication client (Better Auth compatibility layer).
 *
 * The server mounts the allowlisted Better Auth operations as compatibility
 * endpoints under /api/v1/auth/* (A4 auth-route manifest; G1 ADR §10). This
 * module is the typed fetch wrapper for the part of that surface a
 * self-hosted server uses: username/password sign-in and sign-up, password
 * change, sessions, account deletion and OAuth consent. The server sends no
 * email and has no sign-in providers (D28).
 *
 * - every same-origin POST carries the current in-memory CSRF token
 *   (X-CSRF-Token, when a session bootstrap produced one) and the Origin
 *   header — the same contract product-transport mutations follow; GETs
 *   carry neither;
 * - every error response is translated into the shared ProductApiError
 *   (status / code / retryAfterSeconds / recovery). UI code never parses
 *   raw Better Auth error text, and raw BA bodies fail closed through the
 *   status-based fallback;
 * - credentials: 'include' on every request: the browser manages the
 *   __Host-known_session cookie. This module never reads document.cookie
 *   and never writes session material to sessionStorage/localStorage;
 * - operations that establish a new browser session (sign-in, sign-up,
 *   sign-out) refresh the product session store through
 *   productClient.getSession(), so the in-memory CSRF token always matches
 *   the current browser session. The session-operation generation and
 *   abort/race semantics live in productClient; a superseded refresh is
 *   dropped instead of repopulating the store.
 *
 * Product auth state (user / CSRF) must come from /api/v1/session and
 * /api/v1/me (AuthContext) — never from the Better Auth session shape.
 */
import { apiUrl, getApiBaseUrl } from './config'
import { parseProductError, ProductApiError, wrapProductError } from './errors'
import { productClient } from './productClient'
import { fetchWithTimeout } from './requestTimeout'
import { clearSession, getCsrfToken } from './sessionStore'

export type AuthCallOptions = {
  signal?: AbortSignal
}

export type AuthStatusResult = { readonly status: boolean }
/** `redirectUrl` is set when the sign-in resumed an OAuth authorization. */
export type AuthSignInResult = AuthStatusResult & { readonly redirectUrl?: string }

/** Better Auth 1.7 `POST /oauth2/consent` (`authClient.oauth2.consent`). */
export type OAuthConsentInput = {
  accept: boolean
  scope?: string
  claims?: string | Record<string, unknown>
  oauth_query?: string
}

export type OAuthConsentResult = { readonly url: string; readonly redirect: boolean }

/** Session-gated signed-query lookup for the consent page callback. */
export type OAuthConsentTransaction = {
  readonly client_id: string
  readonly redirect_uri: string
  readonly client_name?: string
}

export type SignInWithPasswordInput = {
  email: string
  password: string
  rememberMe?: boolean
  callbackURL?: string
  /** Signed query of an OAuth authorization Better Auth paused at the login page. */
  oauthQuery?: string
}

/** Self-hosted accounts have a username; email is optional (G2). */
export type SignInWithUsernameInput = {
  username: string
  password: string
  rememberMe?: boolean
  /** Signed query of an OAuth authorization Better Auth paused at the login page. */
  oauthQuery?: string
}

export type ChangePasswordInput = {
  newPassword: string
  currentPassword: string
  revokeOtherSessions?: boolean
}

/** BA email-OTP reset uses the `password` field name. */
export type ResetPasswordWithOtpInput = { email: string; otp: string; password: string }

export type AuthReauthProof =
  | { kind: 'password'; password: string }
  | { kind: 'otp'; email: string; otp: string }

export type LinkedAccount = { readonly providerId: string; readonly accountId: string }

export type LinkedAccountsResult = {
  readonly accounts: readonly LinkedAccount[]
  readonly hasPassword: boolean
}

/** Product session inventory item. `id` is the BA session id — never a token (R9). */
export type ProductSessionInfo = {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly current: boolean
}

export type ListSessionsResult = {
  readonly sessions: readonly ProductSessionInfo[]
}

export type RevokeSessionByIdInput = { sessionId: string }

export type DeleteAccountInput = {
  confirmation: 'DELETE'
  reauth: AuthReauthProof
}

const AUTH_BASE_PATH = '/api/v1/auth'

type AuthRequestInit = {
  method: 'GET' | 'POST'
  /** Path relative to /api/v1/auth, e.g. '/sign-in/email'. */
  path: string
  query?: Record<string, string | undefined>
  body?: unknown
  extraHeaders?: Readonly<Record<string, string>>
  /**
   * Same-origin POST contract: attach the current in-memory CSRF token
   * (X-CSRF-Token) and the Origin header. GETs never carry them.
   */
  withCsrf: boolean
  signal?: AbortSignal
}

/** Same-origin origin for the Origin header (mirrors product-transport). */
function authOrigin(): string | undefined {
  const base = getApiBaseUrl()
  if (base) {
    try {
      return new URL(base).origin
    } catch {
    }
  }
  const loc = (globalThis as { location?: { origin?: string } }).location
  if (typeof loc?.origin === 'string' && loc.origin) {
    return loc.origin
  }
  return undefined
}

function buildAuthUrl(path: string, query?: Record<string, string | undefined>): string {
  const url = apiUrl(`${AUTH_BASE_PATH}${path}`)
  if (!query) return url
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(key, value)
  }
  const qs = search.toString()
  return qs ? `${url}?${qs}` : url
}

async function readAuthBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

function authHeadersToRecord(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

async function authRequest<T>(init: AuthRequestInit): Promise<T> {
  const headers = new Headers()
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (init.withCsrf) {
    // The in-memory CSRF token, when a session bootstrap produced one. An
    // absent token (first login, recovery) is omitted — never an empty header.
    const csrf = getCsrfToken()
    if (csrf) headers.set('X-CSRF-Token', csrf)
    const origin = authOrigin()
    if (origin) headers.set('Origin', origin)
  }
  if (init.extraHeaders) {
    for (const [key, value] of Object.entries(init.extraHeaders)) {
      headers.set(key, value)
    }
  }

  let res: Response
  try {
    res = await fetchWithTimeout(globalThis.fetch, buildAuthUrl(init.path, init.query), {
      method: init.method,
      credentials: 'include',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw wrapProductError(err)
  }

  let body: unknown
  try { body = await readAuthBody(res) } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw wrapProductError(error)
  }
  if (!res.ok) {
    // The shared envelope parser maps auth codes (invalid_credentials,
    // verification_required, account_link_required, rate_limited, …) and
    // retryAfterSeconds into ProductApiError; raw BA bodies fail closed.
    throw new ProductApiError(parseProductError(res.status, body, authHeadersToRecord(res)))
  }
  return body as T
}

/**
 * Refresh the product session store after an operation that established or
 * revoked a browser session. Delegates to productClient.getSession() so the
 * session-operation generation and abort semantics stay in one place: a
 * superseded refresh (a newer logout/refresh started) is dropped instead of
 * repopulating the store, while an abort requested by the caller propagates.
 */
async function refreshProductSession(signal?: AbortSignal): Promise<void> {
  try {
    await productClient.getSession({ signal, maxRetries: 0 })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError' && !signal?.aborted) {
      // Superseded by a newer session operation — that operation owns the store.
      return
    }
    throw err
  }
}

/**
 * A sign-in that carried `oauth_query` makes Better Auth re-run the
 * authorization and answer with the next page (consent, or the client's
 * redirect URI). Only http(s) targets are followed.
 */
function oauthContinuation(oauthQuery: string | undefined, body: unknown): AuthSignInResult {
  if (oauthQuery === undefined) return { status: true }
  const url = (body as { url?: unknown } | null)?.url
  if (typeof url !== 'string' || url === '') return { status: true }
  const target = new URL(url, globalThis.location?.origin ?? 'http://localhost')
  return target.protocol === 'http:' || target.protocol === 'https:'
    ? { status: true, redirectUrl: target.href }
    : { status: true }
}

async function signInWithPassword(
  input: SignInWithPasswordInput,
  options?: AuthCallOptions,
): Promise<AuthSignInResult> {
  const body = await authRequest<unknown>({
    method: 'POST',
    path: '/sign-in/email',
    body: {
      email: input.email,
      password: input.password,
      ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
      ...(input.oauthQuery === undefined ? {} : { oauth_query: input.oauthQuery }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return oauthContinuation(input.oauthQuery, body)
}

async function signInWithUsername(
  input: SignInWithUsernameInput,
  options?: AuthCallOptions,
): Promise<AuthSignInResult> {
  const body = await authRequest<unknown>({
    method: 'POST',
    path: '/sign-in/username',
    body: {
      username: input.username,
      password: input.password,
      ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
      ...(input.oauthQuery === undefined ? {} : { oauth_query: input.oauthQuery }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return oauthContinuation(input.oauthQuery, body)
}

async function getRegistrationState(options?: AuthCallOptions): Promise<unknown> {
  return authRequest<unknown>({
    method: 'GET',
    path: '/registration-state',
    withCsrf: false,
    signal: options?.signal,
  })
}

export type SignUpWithUsernameInput = {
  username: string
  password: string
  email?: string
  inviteCode?: string
  /** First-run token from the server log; sent as the Colp-Setup-Token header (D27). */
  setupToken?: string
  callbackURL?: string
}

async function signUpWithUsername(
  input: SignUpWithUsernameInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/sign-up/email',
    body: {
      username: input.username,
      name: input.username,
      password: input.password,
      ...(input.email === undefined || input.email === '' ? {} : { email: input.email }),
      ...(input.inviteCode === undefined ? {} : { inviteCode: input.inviteCode }),
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
    },
    withCsrf: true,
    extraHeaders: input.setupToken === undefined || input.setupToken === ''
      ? undefined
      : { 'Colp-Setup-Token': input.setupToken },
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function changePassword(
  input: ChangePasswordInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/change-password',
    body: {
      newPassword: input.newPassword,
      currentPassword: input.currentPassword,
      ...(input.revokeOtherSessions === undefined ? {} : { revokeOtherSessions: input.revokeOtherSessions }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  // revokeOtherSessions may rotate the browser session — keep the CSRF current.
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function requestForgetPasswordOtp(
  input: { email: string },
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/forget-password/email-otp',
    body: { email: input.email },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function resetPasswordWithOtp(
  input: ResetPasswordWithOtpInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/email-otp/reset-password',
    body: { email: input.email, otp: input.otp, password: input.password },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function deleteAccount(
  input: DeleteAccountInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/account/delete',
    body: { confirmation: input.confirmation, reauth: input.reauth },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function getOAuthConsentTransaction(
  input: { oauthQuery: string },
  options?: AuthCallOptions,
): Promise<OAuthConsentTransaction> {
  return authRequest<OAuthConsentTransaction>({
    method: 'GET',
    path: '/oauth2/consent-transaction',
    query: { oauth_query: input.oauthQuery },
    withCsrf: false,
    signal: options?.signal,
  })
}

async function submitOAuthConsent(
  input: OAuthConsentInput,
  options?: AuthCallOptions,
): Promise<OAuthConsentResult> {
  const body = await authRequest<{
    url?: string
    redirect?: boolean
    redirect_uri?: string
  }>({
    method: 'POST',
    path: '/oauth2/consent',
    body: {
      accept: input.accept,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.claims === undefined ? {} : { claims: input.claims }),
      ...(input.oauth_query === undefined ? {} : { oauth_query: input.oauth_query }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  const url = typeof body?.url === 'string' && body.url
    ? body.url
    : typeof body?.redirect_uri === 'string' ? body.redirect_uri : ''
  return { url, redirect: body?.redirect === true || Boolean(url) }
}

async function listLinkedAccounts(options?: AuthCallOptions): Promise<LinkedAccountsResult> {
  return authRequest<LinkedAccountsResult>({
    method: 'GET',
    path: '/linked-accounts',
    withCsrf: false,
    signal: options?.signal,
  })
}

async function listSessions(options?: AuthCallOptions): Promise<ListSessionsResult> {
  return authRequest<ListSessionsResult>({
    method: 'GET',
    path: '/sessions',
    withCsrf: false,
    signal: options?.signal,
  })
}

async function revokeSessionById(
  input: RevokeSessionByIdInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/sessions/revoke',
    body: { sessionId: input.sessionId },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function signOut(options?: AuthCallOptions): Promise<AuthStatusResult> {
  const result = await authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/sign-out',
    withCsrf: true,
    signal: options?.signal,
  })
  try {
    await refreshProductSession(options?.signal)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // The server revoked the session; a stale in-memory CSRF must never
    // survive a failed refresh.
    clearSession()
  }
  return result
}

/** The sole application-level authentication client instance. */
export const authClient = Object.freeze({
  getRegistrationState,
  signInWithPassword,
  signInWithUsername,
  signUpWithUsername,
  changePassword,
  requestForgetPasswordOtp,
  resetPasswordWithOtp,
  deleteAccount,
  getOAuthConsentTransaction,
  submitOAuthConsent,
  listLinkedAccounts,
  listSessions,
  revokeSessionById,
  signOut,
})
