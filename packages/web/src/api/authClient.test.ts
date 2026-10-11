/**
 * Task D1: Know-N authentication client — typed calls over the allowlisted
 * /api/v1/auth/* compatibility surface (A4 auth-route manifest; G1 ADR §10).
 *
 * Production: src/api/authClient.ts
 *
 * Password, email OTP, verification, reset, and recovery. OAuth, session,
 * MFA, and error mapping live in sibling files.
 *
 * False-negative guards: every test asserts the REAL request init
 * (method / path / body / credentials / headers) recorded by installFetchMock
 * — not mock function call counts. The session cookie is asserted to be
 * browser-managed: credentials:'include' on every request, no explicit
 * Cookie header, and no session material written to storage.
 *
 * False-positive guards: tests never fake a login through localStorage; the
 * product session store only changes through /api/v1/session responses
 * (applySessionView) or explicit clearSession().
 */
import { describe, expect, it } from 'vitest'
import { authClient } from './authClient'
import { getCsrfToken } from './sessionStore'
import { authenticatedSessionBody, installAuthClientTestLifecycle } from './authClient.test-helper'
import {
  installFetchMock,
  jsonResponse,
  requestHeaders,
  requestMethod,
  requestPathAndSearch,
  seedAuthenticatedSession,
} from './test-helpers'

describe('authClient password and email flows', () => {
  const harness = installAuthClientTestLifecycle()

  // -------------------------------------------------------------------------
  // email / password
  // -------------------------------------------------------------------------

  it('signInWithPassword posts the exact body with credentials + Origin and refreshes the product session', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email') {
        return jsonResponse({ user: { id: 'u-1', email: 'ada@example.com' }, session: { id: 's-1' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-login'))
      }
      throw new Error(`unexpected request ${requestMethod({ input, init })} ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    const result = await authClient.signInWithPassword({
      email: 'ada@example.com',
      password: 'correct-horse-battery',
      rememberMe: true,
      callbackURL: '/library',
    })
    expect(result).toEqual({ status: true })

    expect(mock.calls).toHaveLength(2)
    const signIn = mock.calls[0]!
    expect(requestMethod(signIn)).toBe('POST')
    expect(requestPathAndSearch(signIn).pathname).toBe('/api/v1/auth/sign-in/email')
    expect(signIn.init?.credentials).toBe('include')
    expect(JSON.parse(String(signIn.init?.body))).toEqual({
      email: 'ada@example.com',
      password: 'correct-horse-battery',
      rememberMe: true,
      callbackURL: '/library',
    })
    const headers = requestHeaders(signIn)
    expect(headers.get('Origin')).toBe('http://localhost')
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
    // No in-memory session yet: the X-CSRF-Token header must be absent, never empty.
    expect(headers.get('X-CSRF-Token')).toBeNull()
    // The in-memory CSRF is refreshed through the product contract.
    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/session')
    expect(requestMethod(mock.calls[1]!)).toBe('GET')
    expect(getCsrfToken()).toBe('csrf-after-login')
  })

  it('signInWithUsername carries a paused OAuth query and returns the URL Better Auth resumes at', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/username') {
        return jsonResponse({ redirect: true, url: '/consent?client_id=agent&sig=next' })
      }
      if (pathname === '/api/v1/session') return jsonResponse(authenticatedSessionBody('csrf-after-login'))
      throw new Error(`unexpected request ${requestMethod({ input, init })} ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    const result = await authClient.signInWithUsername({
      username: 'alice',
      password: 'correct-horse-battery',
      oauthQuery: 'client_id=agent&sig=signed',
    })
    expect(result).toEqual({ status: true, redirectUrl: 'http://localhost/consent?client_id=agent&sig=next' })
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({
      username: 'alice',
      password: 'correct-horse-battery',
      oauth_query: 'client_id=agent&sig=signed',
    })
  })

  it('a sign-in without an OAuth query ignores the url Better Auth echoes', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email') return jsonResponse({ redirect: true, url: '/library' })
      if (pathname === '/api/v1/session') return jsonResponse(authenticatedSessionBody('csrf-after-login'))
      throw new Error(`unexpected request ${requestMethod({ input, init })} ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    const result = await authClient.signInWithPassword({ email: 'ada@example.com', password: 'pw', callbackURL: '/library' })
    expect(result).toEqual({ status: true })
  })

  it('changePassword posts the current + new password with the in-memory CSRF token and refreshes', async () => {
    seedAuthenticatedSession('csrf-auth')
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/change-password') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-1' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-change'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.changePassword({
      newPassword: 'new-password-456',
      currentPassword: 'old-password-123',
      revokeOtherSessions: true,
    })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/change-password')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      newPassword: 'new-password-456',
      currentPassword: 'old-password-123',
      revokeOtherSessions: true,
    })
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-auth')
    expect(headers.get('Origin')).toBe('http://localhost')
    expect(getCsrfToken()).toBe('csrf-after-change')
  })

  it('deleteAccount posts confirmation DELETE and reauth with session CSRF', async () => {
    seedAuthenticatedSession('csrf-delete-account')
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/account/delete') {
        return jsonResponse({ status: true })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.deleteAccount({
      confirmation: 'DELETE',
      reauth: { kind: 'password', password: 'pass-123' }, // secret-scan: allow 'pass-123'
    })

    expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/auth/account/delete')
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({
      confirmation: 'DELETE',
      reauth: { kind: 'password', password: 'pass-123' }, // secret-scan: allow 'pass-123'
    })
    expect(requestHeaders(mock.calls[0]!).get('X-CSRF-Token')).toBe('csrf-delete-account')
    expect(requestMethod(mock.calls[0]!)).toBe('POST')
  })

  it('resetPasswordWithOtp posts email + otp + password (BA field names) and refreshes', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/email-otp/reset-password') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-otp-reset'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.resetPasswordWithOtp({ email: 'ada@example.com', otp: '112233', password: 'fresh-password-789' })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/email-otp/reset-password')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      email: 'ada@example.com',
      otp: '112233',
      password: 'fresh-password-789',
    })
    expect(getCsrfToken()).toBe('csrf-after-otp-reset')
  })

  it('getRegistrationState reads GET /api/v1/auth/registration-state', async () => {
    const mock = installFetchMock(() => jsonResponse({ open: true, reason: 'first-run' }))
    harness.restoreFetch = mock.restore

    await expect(authClient.getRegistrationState()).resolves.toEqual({ open: true, reason: 'first-run' })

    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/registration-state')
    expect(call.init?.credentials).toBe('include')
    expect(requestHeaders(call).get('X-CSRF-Token')).toBeNull()
  })

  it('signUpWithUsername posts username and password and refreshes the product session', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-up/email') return jsonResponse({ status: true })
      if (pathname === '/api/v1/session') return jsonResponse(authenticatedSessionBody('csrf-after-owner'))
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signUpWithUsername({
      username: 'alice',
      password: 'correct-horse',
      callbackURL: '/library',
    })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/sign-up/email')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      username: 'alice',
      name: 'alice',
      password: 'correct-horse',
      callbackURL: '/library',
    })
    expect(getCsrfToken()).toBe('csrf-after-owner')
    expect(new Headers(call.init?.headers).get('Colp-Setup-Token')).toBeNull()
  })

  it('signUpWithUsername sends the first-run setup token as a header, not in the body', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-up/email') return jsonResponse({ status: true })
      if (pathname === '/api/v1/session') return jsonResponse(authenticatedSessionBody('csrf-after-owner'))
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signUpWithUsername({
      username: 'alice',
      password: 'correct-horse',
      setupToken: 'token-from-log',
    })

    const call = mock.calls[0]!
    expect(new Headers(call.init?.headers).get('Colp-Setup-Token')).toBe('token-from-log')
    expect(JSON.parse(String(call.init?.body))).not.toHaveProperty('setupToken')
  })
})
