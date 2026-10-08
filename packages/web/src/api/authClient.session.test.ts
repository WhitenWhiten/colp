/**
 * authClient session, MFA, error mapping, abort, and cookie guards.
 * Shared harness: authClient.test-helper.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { authClient } from './authClient'
import { ProductApiError, isProductApiError } from './errors'
import { getCsrfToken, getSessionSnapshot } from './sessionStore'
import { authenticatedSessionBody, installAuthClientTestLifecycle } from './authClient.test-helper'
import {
  installFetchMock,
  jsonResponse,
  productErrorBody,
  requestHeaders,
  requestMethod,
  requestPathAndSearch,
  seedAuthenticatedSession,
} from './test-helpers'

describe('authClient session', () => {
  const harness = installAuthClientTestLifecycle()

  it('getAuthSession reads the compat session endpoint without CSRF/Origin headers', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({
        session: {
          id: 's-9',
          userId: 'u-9',
          expiresAt: '2026-07-26T00:00:00.000Z',
          createdAt: '2026-07-25T00:00:00.000Z',
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
        user: {
          id: 'u-9',
          email: 'ada@example.com',
          emailVerified: true,
          name: 'Ada',
          image: null,
        },
      }),
    )
    harness.restoreFetch = mock.restore

    const info = await authClient.getAuthSession()

    expect(info?.session.id).toBe('s-9')
    expect(info?.user.email).toBe('ada@example.com')
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/get-session')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Origin')).toBeNull()
  })

  it('signOut posts /sign-out with the in-memory CSRF token and clears the local store', async () => {
    seedAuthenticatedSession('csrf-logout')
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-out') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse({ authenticated: false })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signOut()

    const signOut = mock.calls[0]!
    expect(requestPathAndSearch(signOut).pathname).toBe('/api/v1/auth/sign-out')
    expect(requestMethod(signOut)).toBe('POST')
    const headers = requestHeaders(signOut)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-logout')
    expect(headers.get('Origin')).toBe('http://localhost')
    // The store converges through the product contract: no stale CSRF survives.
    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/session')
    expect(getCsrfToken()).toBeNull()
    expect(getSessionSnapshot().authenticated).toBe(false)
  })

  it('signOut clears the store when the post-sign-out refresh fails', async () => {
    seedAuthenticatedSession('csrf-logout')
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-out') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(productErrorBody({ code: 'internal_error' }), { status: 500 })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signOut()

    expect(getCsrfToken()).toBeNull()
    expect(getSessionSnapshot().authenticated).toBe(false)
  })

  it('revokeSession posts the session token', async () => {
    seedAuthenticatedSession('csrf-revoke')
    const mock = installFetchMock(() => jsonResponse({ status: true }))
    harness.restoreFetch = mock.restore

    await authClient.revokeSession({ token: 'session-token-1' })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/revoke-session')
    expect(JSON.parse(String(call.init?.body))).toEqual({ token: 'session-token-1' })
    expect(requestHeaders(call).get('X-CSRF-Token')).toBe('csrf-revoke')
  })

  it('listSessions GETs the product inventory without CSRF and never sends a token', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({
        sessions: [
          { id: 'ba-session-current', createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T12:00:00.000Z', current: true },
          { id: 'ba-session-other', createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T08:00:00.000Z', current: false },
        ],
      }),
    )
    harness.restoreFetch = mock.restore

    const result = await authClient.listSessions()
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[1]?.id).toBe('ba-session-other')
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/sessions')
    expect(requestHeaders(call).get('X-CSRF-Token')).toBeNull()
    expect(requestHeaders(call).get('Origin')).toBeNull()
    expect(JSON.stringify(result).includes('token')).toBe(false)
  })

  it('revokeSessionById posts the session id, never a token', async () => {
    seedAuthenticatedSession('csrf-revoke-id')
    const mock = installFetchMock(() => jsonResponse({ status: true }))
    harness.restoreFetch = mock.restore

    await authClient.revokeSessionById({ sessionId: 'ba-session-other' })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/sessions/revoke')
    expect(JSON.parse(String(call.init?.body))).toEqual({ sessionId: 'ba-session-other' })
    expect(String(call.init?.body)).not.toContain('token')
    expect(requestHeaders(call).get('X-CSRF-Token')).toBe('csrf-revoke-id')
  })

  it('two-factor enrollment/status calls hit the MFA surface with exact bodies', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/two-factor/enable') {
        return jsonResponse({ totpURI: 'otpauth://totp/known:ada@example.com?secret=ABC', backupCodes: ['AAAAA-BBBBB'] })
      }
      if (pathname === '/api/v1/auth/two-factor/get-totp-uri') {
        return jsonResponse({ totpURI: 'otpauth://totp/known:ada@example.com?secret=ABC' })
      }
      if (pathname === '/api/v1/auth/two-factor/generate-backup-codes') {
        return jsonResponse({ backupCodes: ['CCCCC-DDDDD'] })
      }
      if (pathname === '/api/v1/auth/two-factor/send-otp') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/auth/two-factor/disable') {
        return jsonResponse({ status: false })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore
    seedAuthenticatedSession('csrf-mfa')

    const enrolled = await authClient.enableTwoFactor({ password: 'password-1', issuer: 'known' })
    expect(enrolled.totpURI).toContain('otpauth://totp/')
    expect(enrolled.backupCodes).toEqual(['AAAAA-BBBBB'])

    const uri = await authClient.getTotpUri({ password: 'password-1' })
    expect(uri.totpURI).toContain('otpauth://totp/')

    const codes = await authClient.generateBackupCodes({ password: 'password-1' })
    expect(codes.backupCodes).toEqual(['CCCCC-DDDDD'])

    await authClient.sendTwoFactorOtp({ trustDevice: true })

    const disabled = await authClient.disableTwoFactor({ password: 'password-1' })
    expect(disabled.status).toBe(false)

    expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/auth/two-factor/enable')
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ password: 'password-1', issuer: 'known' })
    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/auth/two-factor/get-totp-uri')
    expect(JSON.parse(String(mock.calls[1]!.init?.body))).toEqual({ password: 'password-1' })
    expect(requestPathAndSearch(mock.calls[2]!).pathname).toBe('/api/v1/auth/two-factor/generate-backup-codes')
    expect(requestPathAndSearch(mock.calls[3]!).pathname).toBe('/api/v1/auth/two-factor/send-otp')
    expect(JSON.parse(String(mock.calls[3]!.init?.body))).toEqual({ trustDevice: true })
    expect(requestPathAndSearch(mock.calls[4]!).pathname).toBe('/api/v1/auth/two-factor/disable')
    expect(mock.calls.every((call) => requestHeaders(call).get('X-CSRF-Token') === 'csrf-mfa')).toBe(true)
    // Enrollment/disable never touch the product session store.
    expect(mock.calls).toHaveLength(5)
  })

  it('two-factor verify calls refresh the product session after the MFA proof', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/two-factor/verify-totp') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-9' } })
      }
      if (pathname === '/api/v1/auth/two-factor/verify-backup-code') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-9' } })
      }
      if (pathname === '/api/v1/auth/two-factor/verify-otp') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-9' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-mfa'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.verifyTotp({ code: '123456', trustDevice: true })
    await authClient.verifyBackupCode({ code: 'AAAAA-BBBBB' })
    await authClient.verifyTwoFactorOtp({ otp: '654321' })

    expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/auth/two-factor/verify-totp')
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ code: '123456', trustDevice: true })
    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/session')
    expect(requestPathAndSearch(mock.calls[2]!).pathname).toBe('/api/v1/auth/two-factor/verify-backup-code')
    expect(JSON.parse(String(mock.calls[2]!.init?.body))).toEqual({ code: 'AAAAA-BBBBB' })
    expect(requestPathAndSearch(mock.calls[4]!).pathname).toBe('/api/v1/auth/two-factor/verify-otp')
    expect(JSON.parse(String(mock.calls[4]!.init?.body))).toEqual({ otp: '654321' })
    expect(getCsrfToken()).toBe('csrf-after-mfa')
  })

  it.each([
    [401, 'invalid_credentials'],
    [403, 'verification_required'],
    [403, 'csrf_failed'],
    [409, 'account_link_required'],
    [503, 'email_delivery_unavailable'],
    [400, 'invalid_request'],
  ] as const)('maps the %s auth envelope to ProductApiError with code %s', async (status, code) => {
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({ code, message: `server message for ${code}` }), { status }),
    )
    harness.restoreFetch = mock.restore

    const error = await authClient
      .sendOtp({ email: 'ada@example.com', type: 'sign-in' })
      .then(() => null, (err) => err)

    expect(isProductApiError(error)).toBe(true)
    expect(error).toMatchObject({ status, code })
    expect(error.message).toBe(`server message for ${code}`)
    expect(error.requestId).toBe('req-test')
  })

  it.each([null, { raw: 'Forbidden' }, { code: 'FORBIDDEN' }])(
    'does not infer CSRF recovery from a non-envelope 403 (%j)', async (body) => {
      const mock = installFetchMock(() => jsonResponse(body, { status: 403 }))
      harness.restoreFetch = mock.restore
      const error = await authClient.sendOtp({ email: 'ada@example.com', type: 'sign-in' })
        .then(() => null, (err) => err)
      expect(error).toMatchObject({ status: 403, code: 'unknown_error', recovery: 'user_action' })
      expect(error.isCsrfFailed).toBe(false)
      expect(mock.calls).toHaveLength(1)
    },
  )

  it('maps rate_limited with retryAfterSeconds from the envelope and the Retry-After header', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({ code: 'rate_limited', retryAfterSeconds: 12, sameRequestRetrySafe: true }), {
        status: 429,
        headers: { 'Retry-After': '12' },
      }),
    )
    harness.restoreFetch = mock.restore

    const error = await authClient
      .sendOtp({ email: 'ada@example.com', type: 'sign-in' })
      .then(() => null, (err) => err)

    expect(isProductApiError(error)).toBe(true)
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 12 })
    expect(error.recovery).toBe('same_request')
    expect(error.sameRequestRetrySafe).toBe(true)
  })

  it('fails closed on raw Better Auth error bodies instead of parsing BA codes', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, { status: 401 }),
    )
    harness.restoreFetch = mock.restore

    const error = await authClient
      .signInWithPassword({ email: 'ada@example.com', password: 'wrong-password' })
      .then(() => null, (err) => err)

    expect(isProductApiError(error)).toBe(true)
    // Status-based fallback only — the raw BA code must never leak into product code.
    expect(error.code).toBe('authentication_required')
    expect(error.message).not.toContain('INVALID_EMAIL_OR_PASSWORD')
  })

  it('maps network failures to transport_error ProductApiError', async () => {
    const mock = installFetchMock(() => {
      throw new TypeError('Failed to fetch')
    })
    harness.restoreFetch = mock.restore

    const error = await authClient
      .sendOtp({ email: 'ada@example.com', type: 'sign-in' })
      .then(() => null, (err) => err)

    expect(isProductApiError(error)).toBe(true)
    expect(error).toMatchObject({ status: 0, code: 'transport_error' })
  })

  it('propagates abort while the post-login session refresh is in flight', async () => {
    const controller = new AbortController()
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email') {
        return jsonResponse({ user: { id: 'u-1' }, session: { id: 's-1' } })
      }
      if (pathname === '/api/v1/session') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    const call = authClient.signInWithPassword(
      { email: 'ada@example.com', password: 'correct-horse-battery' },
      { signal: controller.signal },
    )
    await vi.waitFor(() =>
      expect(mock.calls.some((c) => requestPathAndSearch(c).pathname === '/api/v1/session')).toBe(true),
    )
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(getCsrfToken()).toBeNull()
  })

  it('drops a superseded post-login refresh when a duplicate submission wins', async () => {
    let resolveFirstSession!: (response: Response) => void
    const firstSession = new Promise<Response>((resolve) => {
      resolveFirstSession = resolve
    })
    let sessionFetches = 0
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email') {
        return jsonResponse({ user: { id: 'u-1' }, session: { id: 's-1' } })
      }
      if (pathname === '/api/v1/session') {
        sessionFetches += 1
        if (sessionFetches === 1) return firstSession
        return jsonResponse(authenticatedSessionBody('csrf-second-login'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    const first = authClient.signInWithPassword({ email: 'a@example.com', password: 'password-1' })
    await vi.waitFor(() => expect(sessionFetches).toBe(1))
    const second = authClient.signInWithPassword({ email: 'b@example.com', password: 'password-2' })

    await second
    expect(getCsrfToken()).toBe('csrf-second-login')

    // The first refresh resolves late with a stale CSRF — it must be dropped,
    // never applied to the store.
    resolveFirstSession(jsonResponse(authenticatedSessionBody('csrf-stale-login')))
    await first
    expect(getCsrfToken()).toBe('csrf-second-login')
    expect(getSessionSnapshot().authenticated).toBe(true)
  })

  it('lets the browser manage the session cookie and never persists session material', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email') {
        return jsonResponse({ user: { id: 'u-1' }, session: { id: 's-1' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-session'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signInWithPassword({ email: 'ada@example.com', password: 'correct-horse-battery' })

    // The client never reads or forwards the cookie; the browser handles it.
    for (const call of mock.calls) {
      expect(call.init?.credentials).toBe('include')
      expect(requestHeaders(call).get('cookie')).toBeNull()
    }
    // Nothing is written to storage — the CSRF token lives in memory only.
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.length).toBe(0)
    expect(getCsrfToken()).toBe('csrf-session')
  })

  it('isProductApiError distinguishes auth errors for UI recovery', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({ code: 'verification_required' }), { status: 403 }),
    )
    harness.restoreFetch = mock.restore

    const error = await authClient
      .sendOtp({ email: 'ada@example.com', type: 'sign-in' })
      .then(() => null, (err) => err)

    expect(error).toBeInstanceOf(ProductApiError)
    expect(isProductApiError(error)).toBe(true)
    expect(error.code).toBe('verification_required')
  })
})
