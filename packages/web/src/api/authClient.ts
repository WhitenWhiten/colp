/**
 * Task D1: Know-N authentication client (Better Auth compatibility layer).
 *
 * The backend mounts the allowlisted Better Auth 1.6.29 operations as
 * Know-N compatibility endpoints under /api/v1/auth/* (A4 auth-route
 * manifest; G1 ADR §10). This module is the typed fetch wrapper for that
 * surface:
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
 * - operations that establish a new browser session (sign-in, OTP sign-in,
 *   reset, MFA verify, sign-out) refresh the product session store through
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

/** Better Auth email OTP purposes (G1 §8 / C2). */
export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'

export type AuthStatusResult = { readonly status: boolean }
export type AuthOtpSendResult = { readonly success: boolean }
export type AuthOtpCheckResult = { readonly success: boolean }
export type AuthOAuthStartResult = { readonly url: string; readonly redirect: boolean }

/** Better Auth 1.7 `POST /oauth2/consent` (`authClient.oauth2.consent`). */
export type OAuthConsentInput = {
  accept: boolean
  scope?: string
  claims?: string | Record<string, unknown>
  oauth_query?: string
}

export type OAuthConsentResult = { readonly url: string; readonly redirect: boolean }

/** Better Auth 1.7 `GET /oauth2/public-client` public CIMD/client fields. */
export type OAuthPublicClient = {
  readonly client_id?: string
  readonly client_name?: string
  readonly client_uri?: string
  readonly logo_uri?: string
}

/** Session-gated signed-query lookup for the consent page callback. */
export type OAuthConsentTransaction = {
  readonly client_id: string
  readonly redirect_uri: string
  readonly client_name?: string
}
export type AuthTotpEnableResult = { readonly totpURI: string; readonly backupCodes: string[] }
export type AuthTotpUriResult = { readonly totpURI: string }
export type AuthBackupCodesResult = { readonly backupCodes: string[] }

/**
 * Narrow view of the compat get-session response. Raw session `token` fields
 * are stripped server-side (A4 R9), and the client keeps the shape minimal:
 * product state must still come from /api/v1/session + /api/v1/me.
 */
export type AuthSessionInfo = {
  readonly session: {
    readonly id: string
    readonly userId: string
    readonly expiresAt: string
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly user: {
    readonly id: string
    readonly email: string | null
    readonly emailVerified: boolean | null
    readonly name: string | null
    readonly image: string | null
  }
}

// ─── Inputs ────────────────────────────────────────────────────────────────

export type SignInWithPasswordInput = {
  email: string
  password: string
  rememberMe?: boolean
  callbackURL?: string
}

export type SignUpWithPasswordInput = {
  name: string
  email: string
  password: string
  image?: string
  callbackURL?: string
  rememberMe?: boolean
}

export type ChangePasswordInput = {
  newPassword: string
  currentPassword: string
  revokeOtherSessions?: boolean
}

export type SendOtpInput = { email: string; type: OtpPurpose; intent?: 'sign-up' }

export type SignInWithOtpInput = {
  email: string
  otp: string
  name?: string
  /** Register OTP verify; Login must omit this (non-enumerating, never creates). */
  intent?: 'sign-up'
}

export type CheckOtpInput = { email: string; otp: string; type: OtpPurpose }

export type VerifyEmailWithOtpInput = { email: string; otp: string }

export type SendVerificationEmailInput = { email: string; callbackURL?: string }

/** Email-link verification (GET /verify-email?token=…). */
export type VerifyEmailInput = { token: string; callbackURL?: string }

export type RequestPasswordResetInput = { email: string; redirectTo?: string }

export type ResetPasswordInput = { token: string; newPassword: string }

/** BA email-OTP reset uses the `password` field name. */
export type ResetPasswordWithOtpInput = { email: string; otp: string; password: string }

export type RequestPasswordRecoveryInput = { email: string }

/** Product recovery facade uses the `newPassword` field name. */
export type RecoverWithOtpInput = { email: string; otp: string; newPassword: string }

export type StartOAuthInput = {
  providerId: string
  callbackURL?: string
  errorCallbackURL?: string
  newUserCallbackURL?: string
  disableRedirect?: boolean
  requestSignUp?: boolean
}

export type AuthReauthProof =
  | { kind: 'password'; password: string }
  | { kind: 'otp'; email: string; otp: string }

export type LinkOAuthInput = {
  providerId: string
  callbackURL: string
  errorCallbackURL?: string
  reauth: AuthReauthProof
}

export type UnlinkOAuthInput = { providerId: string; accountId: string; reauth: AuthReauthProof }

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

export type RequestEmailChangeInput = { newEmail: string; otp?: string }

export type ChangeEmailInput = { newEmail: string; otp: string }

export type DeleteAccountInput = {
  confirmation: 'DELETE'
  reauth: AuthReauthProof
}

// ─── MFA (two-factor) ──────────────────────────────────────────────────────

export type EnableTwoFactorInput = { password: string; issuer?: string }

export type DisableTwoFactorInput = { password: string }

export type GetTotpUriInput = { password: string }

export type VerifyTotpInput = { code: string; trustDevice?: boolean }

export type VerifyBackupCodeInput = { code: string; trustDevice?: boolean; disableSession?: boolean }

export type GenerateBackupCodesInput = { password: string }

export type SendTwoFactorOtpInput = { trustDevice?: boolean }

export type VerifyTwoFactorOtpInput = { otp: string; trustDevice?: boolean }

export type RevokeSessionInput = { token: string }

// ─── Transport ─────────────────────────────────────────────────────────────

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
      /* fall through to location */
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

  const body = await readAuthBody(res)
  if (!res.ok) {
    // The shared envelope parser maps auth codes (invalid_credentials,
    // verification_required, account_link_required, rate_limited, …) and
    // retryAfterSeconds into ProductApiError; raw BA bodies fail closed.
    throw new ProductApiError(parseProductError(res.status, body, authHeadersToRecord(res)))
  }
  return body as T
}

// ─── Session refresh (login / logout races) ────────────────────────────────

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

// ─── Callback-URL (returnTo) validation ────────────────────────────────────

function invalidAuthRequest(): ProductApiError {
  return new ProductApiError({
    status: 400,
    code: 'invalid_request',
    message: 'The request is invalid.',
    recovery: 'user_action',
    sameRequestRetrySafe: false,
  })
}

/**
 * Same-origin callback-URL guard mirroring the backend OAuth start/link
 * validation (C3): a relative path starting with `/` (never `//`, no
 * backslashes or control characters) or an absolute URL on the product
 * origin. Cross-origin values fail closed before any network call.
 */
function assertSafeCallbackUrl(raw: string | undefined, field: string): void {
  if (raw === undefined) return
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw invalidAuthRequest()
  }
  if (raw.startsWith('/') && (raw.startsWith('//') || raw.includes('\\'))) throw invalidAuthRequest()
  const origin = authOrigin()
  if (!origin) {
    if (raw.startsWith('/')) return
    throw invalidAuthRequest()
  }
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    throw invalidAuthRequest()
  }
  // R15-20: `https://<origin>//evil.com` and `/.//evil.com` keep the origin
  // but normalize to a protocol-relative `//` path.
  if (url.origin !== origin || url.pathname.startsWith('//')) throw invalidAuthRequest()
}

function assertSafeOAuthUrls(input: StartOAuthInput | LinkOAuthInput): void {
  const candidate = input as StartOAuthInput
  assertSafeCallbackUrl(candidate.callbackURL, 'callbackURL')
  assertSafeCallbackUrl(candidate.errorCallbackURL, 'errorCallbackURL')
  assertSafeCallbackUrl(candidate.newUserCallbackURL, 'newUserCallbackURL')
}

// ─── Auth operations ───────────────────────────────────────────────────────

async function signInWithPassword(
  input: SignInWithPasswordInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/sign-in/email',
    body: {
      email: input.email,
      password: input.password,
      ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
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
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function signUpWithPassword(
  input: SignUpWithPasswordInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/sign-up/email',
    body: {
      name: input.name,
      email: input.email,
      password: input.password,
      ...(input.image === undefined ? {} : { image: input.image }),
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
      ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
    },
    withCsrf: true,
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

async function sendOtp(input: SendOtpInput, options?: AuthCallOptions): Promise<AuthOtpSendResult> {
  return authRequest<AuthOtpSendResult>({
    method: 'POST',
    path: '/email-otp/send-verification-otp',
    body: { email: input.email, type: input.type },
    extraHeaders: input.intent === 'sign-up' ? { 'X-Known-Auth-Intent': 'sign-up' } : undefined,
    withCsrf: true,
    signal: options?.signal,
  })
}

async function signInWithOtp(
  input: SignInWithOtpInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/sign-in/email-otp',
    body: {
      email: input.email,
      otp: input.otp,
      ...(input.name === undefined ? {} : { name: input.name }),
    },
    extraHeaders: isSignupOtpIntent(input) ? { 'X-Known-Auth-Intent': 'sign-up' } : undefined,
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

function isSignupOtpIntent(input: { intent?: 'sign-up'; name?: string }): boolean {
  return input.intent === 'sign-up' || (typeof input.name === 'string' && input.name.length > 0)
}

async function checkOtp(input: CheckOtpInput, options?: AuthCallOptions): Promise<AuthOtpCheckResult> {
  return authRequest<AuthOtpCheckResult>({
    method: 'POST',
    path: '/email-otp/check-verification-otp',
    body: { email: input.email, otp: input.otp, type: input.type },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function verifyEmailWithOtp(
  input: VerifyEmailWithOtpInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/email-otp/verify-email',
    body: { email: input.email, otp: input.otp },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function sendVerificationEmail(
  input: SendVerificationEmailInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/send-verification-email',
    body: {
      email: input.email,
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function verifyEmail(
  input: VerifyEmailInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'GET',
    path: '/verify-email',
    query: {
      token: input.token,
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
    },
    withCsrf: false,
    signal: options?.signal,
  })
}

async function requestPasswordReset(
  input: RequestPasswordResetInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/request-password-reset',
    body: {
      email: input.email,
      ...(input.redirectTo === undefined ? {} : { redirectTo: input.redirectTo }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function resetPassword(
  input: ResetPasswordInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/reset-password',
    body: { token: input.token, newPassword: input.newPassword },
    withCsrf: true,
    signal: options?.signal,
  })
  // Reset revokes every old session and issues a new one — refresh the store.
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function requestOtpPasswordReset(
  input: { email: string },
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/email-otp/request-password-reset',
    body: { email: input.email },
    withCsrf: true,
    signal: options?.signal,
  })
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

async function requestEmailChange(
  input: RequestEmailChangeInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/email-otp/request-email-change',
    body: {
      newEmail: input.newEmail,
      ...(input.otp === undefined ? {} : { otp: input.otp }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function changeEmail(
  input: ChangeEmailInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/email-otp/change-email',
    body: { newEmail: input.newEmail, otp: input.otp },
    withCsrf: true,
    signal: options?.signal,
  })
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

async function requestPasswordRecovery(
  input: RequestPasswordRecoveryInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/recovery/password-reset',
    body: { email: input.email },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function recoverWithOtp(
  input: RecoverWithOtpInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/recovery/otp-reset',
    body: { email: input.email, otp: input.otp, newPassword: input.newPassword },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function getOAuthPublicClient(
  input: { clientId: string },
  options?: AuthCallOptions,
): Promise<OAuthPublicClient> {
  return authRequest<OAuthPublicClient>({
    method: 'GET',
    path: '/oauth2/public-client',
    query: { client_id: input.clientId },
    withCsrf: false,
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

async function startOAuth(
  input: StartOAuthInput,
  options?: AuthCallOptions,
): Promise<AuthOAuthStartResult> {
  assertSafeOAuthUrls(input)
  return authRequest<AuthOAuthStartResult>({
    method: 'POST',
    // Better Auth built-in social chain (production socialProviders
    // google/github): the provider authorize URL answers with
    // redirect_uri={baseURL}/callback/{providerId}.
    path: '/sign-in/social',
    body: {
      provider: input.providerId,
      ...(input.callbackURL === undefined ? {} : { callbackURL: input.callbackURL }),
      ...(input.errorCallbackURL === undefined ? {} : { errorCallbackURL: input.errorCallbackURL }),
      ...(input.newUserCallbackURL === undefined ? {} : { newUserCallbackURL: input.newUserCallbackURL }),
      ...(input.disableRedirect === undefined ? {} : { disableRedirect: input.disableRedirect }),
      ...(input.requestSignUp === undefined ? {} : { requestSignUp: input.requestSignUp }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function linkOAuth(
  input: LinkOAuthInput,
  options?: AuthCallOptions,
): Promise<AuthOAuthStartResult> {
  assertSafeOAuthUrls(input)
  return authRequest<AuthOAuthStartResult>({
    method: 'POST',
    path: '/oauth2/link',
    body: {
      providerId: input.providerId,
      callbackURL: input.callbackURL,
      ...(input.errorCallbackURL === undefined ? {} : { errorCallbackURL: input.errorCallbackURL }),
      reauth: input.reauth,
    },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function unlinkOAuth(
  input: UnlinkOAuthInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/unlink-account',
    body: {
      providerId: input.providerId,
      accountId: input.accountId,
      reauth: input.reauth,
    },
    withCsrf: true,
    signal: options?.signal,
  })
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

async function getAuthSession(options?: AuthCallOptions): Promise<AuthSessionInfo | null> {
  return authRequest<AuthSessionInfo | null>({
    method: 'GET',
    path: '/get-session',
    withCsrf: false,
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

async function revokeSession(
  input: RevokeSessionInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/revoke-session',
    body: { token: input.token },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function enableTwoFactor(
  input: EnableTwoFactorInput,
  options?: AuthCallOptions,
): Promise<AuthTotpEnableResult> {
  return authRequest<AuthTotpEnableResult>({
    method: 'POST',
    path: '/two-factor/enable',
    body: {
      password: input.password,
      ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function disableTwoFactor(
  input: DisableTwoFactorInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/two-factor/disable',
    body: { password: input.password },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function getTotpUri(
  input: GetTotpUriInput,
  options?: AuthCallOptions,
): Promise<AuthTotpUriResult> {
  return authRequest<AuthTotpUriResult>({
    method: 'POST',
    path: '/two-factor/get-totp-uri',
    body: { password: input.password },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function verifyTotp(
  input: VerifyTotpInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/two-factor/verify-totp',
    body: {
      code: input.code,
      ...(input.trustDevice === undefined ? {} : { trustDevice: input.trustDevice }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  // MFA proof completes the login — the browser session is now established.
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function verifyBackupCode(
  input: VerifyBackupCodeInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/two-factor/verify-backup-code',
    body: {
      code: input.code,
      ...(input.trustDevice === undefined ? {} : { trustDevice: input.trustDevice }),
      ...(input.disableSession === undefined ? {} : { disableSession: input.disableSession }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

async function generateBackupCodes(
  input: GenerateBackupCodesInput,
  options?: AuthCallOptions,
): Promise<AuthBackupCodesResult> {
  return authRequest<AuthBackupCodesResult>({
    method: 'POST',
    path: '/two-factor/generate-backup-codes',
    body: { password: input.password },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function sendTwoFactorOtp(
  input: SendTwoFactorOtpInput = {},
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  return authRequest<AuthStatusResult>({
    method: 'POST',
    path: '/two-factor/send-otp',
    body: input.trustDevice === undefined ? {} : { trustDevice: input.trustDevice },
    withCsrf: true,
    signal: options?.signal,
  })
}

async function verifyTwoFactorOtp(
  input: VerifyTwoFactorOtpInput,
  options?: AuthCallOptions,
): Promise<AuthStatusResult> {
  await authRequest<unknown>({
    method: 'POST',
    path: '/two-factor/verify-otp',
    body: {
      otp: input.otp,
      ...(input.trustDevice === undefined ? {} : { trustDevice: input.trustDevice }),
    },
    withCsrf: true,
    signal: options?.signal,
  })
  await refreshProductSession(options?.signal)
  return { status: true }
}

/** The sole application-level authentication client instance. */
export const authClient = Object.freeze({
  getRegistrationState,
  signInWithPassword,
  signUpWithPassword,
  signUpWithUsername,
  changePassword,
  sendOtp,
  signInWithOtp,
  checkOtp,
  verifyEmailWithOtp,
  sendVerificationEmail,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  requestOtpPasswordReset,
  requestForgetPasswordOtp,
  resetPasswordWithOtp,
  requestEmailChange,
  changeEmail,
  deleteAccount,
  requestPasswordRecovery,
  recoverWithOtp,
  getOAuthPublicClient,
  getOAuthConsentTransaction,
  submitOAuthConsent,
  startOAuth,
  linkOAuth,
  unlinkOAuth,
  listLinkedAccounts,
  listSessions,
  revokeSessionById,
  getAuthSession,
  signOut,
  revokeSession,
  enableTwoFactor,
  disableTwoFactor,
  getTotpUri,
  verifyTotp,
  verifyBackupCode,
  generateBackupCodes,
  sendTwoFactorOtp,
  verifyTwoFactorOtp,
})
