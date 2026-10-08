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

  it('signUpWithPassword posts name/email/password and refreshes the product session', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-up/email') {
        return jsonResponse({ user: { id: 'u-2', email: 'bob@example.com' }, session: { id: 's-2' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-signup'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signUpWithPassword({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'another-password-123',
      callbackURL: '/onboarding',
    })

    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/sign-up/email')
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'another-password-123',
      callbackURL: '/onboarding',
    })
    expect(requestHeaders(call).get('Origin')).toBe('http://localhost')
    expect(getCsrfToken()).toBe('csrf-after-signup')
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

  // -------------------------------------------------------------------------
  // email OTP
  // -------------------------------------------------------------------------

  it('sendOtp posts email + purpose and never touches the session store', async () => {
    const mock = installFetchMock(() => jsonResponse({ success: true }))
    harness.restoreFetch = mock.restore

    const result = await authClient.sendOtp({ email: 'ada@example.com', type: 'sign-in' })

    expect(result).toEqual({ success: true })
    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/email-otp/send-verification-otp')
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({ email: 'ada@example.com', type: 'sign-in' })
    const headers = requestHeaders(call)
    expect(headers.get('Origin')).toBe('http://localhost')
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('X-Known-Auth-Intent')).toBeNull()
  })

  it('sendOtp with sign-up intent adds the signup header and never puts intent in the body', async () => {
    const mock = installFetchMock(() => jsonResponse({ success: true }))
    harness.restoreFetch = mock.restore

    await authClient.sendOtp({ email: 'ada@example.com', type: 'sign-in', intent: 'sign-up' })

    const call = mock.calls[0]!
    expect(JSON.parse(String(call.init?.body))).toEqual({ email: 'ada@example.com', type: 'sign-in' })
    expect(requestHeaders(call).get('X-Known-Auth-Intent')).toBe('sign-up')
  })

  it('signInWithOtp posts email + otp and refreshes the product session', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email-otp') {
        return jsonResponse({ user: { id: 'u-3', email: 'ada@example.com' }, session: { id: 's-3' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-otp'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signInWithOtp({ email: 'ada@example.com', otp: '123456' })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/sign-in/email-otp')
    expect(JSON.parse(String(call.init?.body))).toEqual({ email: 'ada@example.com', otp: '123456' })
    expect(requestHeaders(call).get('Origin')).toBe('http://localhost')
    expect(requestHeaders(call).get('X-Known-Auth-Intent')).toBeNull()
    expect(getCsrfToken()).toBe('csrf-after-otp')
  })

  it('signInWithOtp with name/intent sends the signup header and never puts intent in the body', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email-otp') {
        return jsonResponse({ user: { id: 'u-3b', email: 'ada@example.com' }, session: { id: 's-3b' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-otp-signup'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signInWithOtp({
      email: 'ada@example.com',
      otp: '123456',
      name: 'Ada Lovelace',
      intent: 'sign-up',
    })

    const call = mock.calls[0]!
    expect(JSON.parse(String(call.init?.body))).toEqual({
      email: 'ada@example.com',
      otp: '123456',
      name: 'Ada Lovelace',
    })
    expect(requestHeaders(call).get('X-Known-Auth-Intent')).toBe('sign-up')
  })

  it('signInWithOtp with only name still sends the signup header (register path)', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/sign-in/email-otp') {
        return jsonResponse({ user: { id: 'u-3c', email: 'ada@example.com' }, session: { id: 's-3c' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-otp-name'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.signInWithOtp({ email: 'ada@example.com', otp: '123456', name: 'Ada Lovelace' })

    expect(requestHeaders(mock.calls[0]!).get('X-Known-Auth-Intent')).toBe('sign-up')
  })

  it('checkOtp and verifyEmailWithOtp post their exact bodies without a session refresh', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/email-otp/check-verification-otp') {
        return jsonResponse({ success: true })
      }
      if (pathname === '/api/v1/auth/email-otp/verify-email') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-4', email: 'ada@example.com' } })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.checkOtp({ email: 'ada@example.com', otp: '654321', type: 'email-verification' })
    await authClient.verifyEmailWithOtp({ email: 'ada@example.com', otp: '654321' })

    expect(mock.calls).toHaveLength(2)
    const check = mock.calls[0]!
    expect(requestPathAndSearch(check).pathname).toBe('/api/v1/auth/email-otp/check-verification-otp')
    expect(JSON.parse(String(check.init?.body))).toEqual({
      email: 'ada@example.com',
      otp: '654321',
      type: 'email-verification',
    })
    const verify = mock.calls[1]!
    expect(requestPathAndSearch(verify).pathname).toBe('/api/v1/auth/email-otp/verify-email')
    expect(JSON.parse(String(verify.init?.body))).toEqual({ email: 'ada@example.com', otp: '654321' })
  })

  // -------------------------------------------------------------------------
  // verification (email link contract)
  // -------------------------------------------------------------------------

  it('sendVerificationEmail posts email + callbackURL with the in-memory CSRF token', async () => {
    seedAuthenticatedSession('csrf-verify')
    const mock = installFetchMock(() => jsonResponse({ status: true }))
    harness.restoreFetch = mock.restore

    await authClient.sendVerificationEmail({ email: 'ada@example.com', callbackURL: '/settings' })

    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/send-verification-email')
    expect(JSON.parse(String(call.init?.body))).toEqual({ email: 'ada@example.com', callbackURL: '/settings' })
    expect(requestHeaders(call).get('X-CSRF-Token')).toBe('csrf-verify')
    expect(requestHeaders(call).get('Origin')).toBe('http://localhost')
  })

  it('verifyEmail follows the GET contract (token + callbackURL query) with no CSRF/Origin headers', async () => {
    const mock = installFetchMock(() => jsonResponse({ status: true, user: { id: 'u-5', email: 'ada@example.com' } }))
    harness.restoreFetch = mock.restore

    const result = await authClient.verifyEmail({ token: 'jwt-token-1', callbackURL: '/library' })

    expect(result.status).toBe(true)
    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    const { pathname, searchParams } = requestPathAndSearch(call)
    expect(pathname).toBe('/api/v1/auth/verify-email')
    expect(searchParams.get('token')).toBe('jwt-token-1')
    expect(searchParams.get('callbackURL')).toBe('/library')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Origin')).toBeNull()
  })

  it('requestEmailChange and changeEmail post the new email (+OTP) with session CSRF', async () => {
    seedAuthenticatedSession('csrf-email-change')
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/email-otp/request-email-change') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/auth/email-otp/change-email') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-1' } })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.requestEmailChange({ newEmail: 'new@example.com' })
    await authClient.changeEmail({ newEmail: 'new@example.com', otp: '998877' })

    expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/auth/email-otp/request-email-change')
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ newEmail: 'new@example.com' })
    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/auth/email-otp/change-email')
    expect(JSON.parse(String(mock.calls[1]!.init?.body))).toEqual({ newEmail: 'new@example.com', otp: '998877' })
    expect(mock.calls.every((call) => requestHeaders(call).get('X-CSRF-Token') === 'csrf-email-change')).toBe(true)
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

  // -------------------------------------------------------------------------
  // password reset
  // -------------------------------------------------------------------------

  it('requestPasswordReset and resetPassword post their exact bodies', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/request-password-reset') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/auth/reset-password') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-6' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-reset'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.requestPasswordReset({ email: 'ada@example.com', redirectTo: '/reset/complete' })
    await authClient.resetPassword({ token: 'reset-token-1', newPassword: 'fresh-password-789' })

    const request = mock.calls[0]!
    expect(requestPathAndSearch(request).pathname).toBe('/api/v1/auth/request-password-reset')
    expect(JSON.parse(String(request.init?.body))).toEqual({
      email: 'ada@example.com',
      redirectTo: '/reset/complete',
    })
    const reset = mock.calls[1]!
    expect(requestPathAndSearch(reset).pathname).toBe('/api/v1/auth/reset-password')
    expect(JSON.parse(String(reset.init?.body))).toEqual({ token: 'reset-token-1', newPassword: 'fresh-password-789' })
  })

  it('resetPassword refreshes the product session (reset revokes old sessions)', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/reset-password') {
        return jsonResponse({ status: true, token: null, user: { id: 'u-6' } })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-reset'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.resetPassword({ token: 'reset-token-1', newPassword: 'fresh-password-789' })

    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/session')
    expect(getCsrfToken()).toBe('csrf-after-reset')
  })

  it('requestOtpPasswordReset and requestForgetPasswordOtp post the email', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/email-otp/request-password-reset') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/auth/forget-password/email-otp') {
        return jsonResponse({ status: true })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.requestOtpPasswordReset({ email: 'ada@example.com' })
    await authClient.requestForgetPasswordOtp({ email: 'ada@example.com' })

    expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/auth/email-otp/request-password-reset')
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ email: 'ada@example.com' })
    expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/auth/forget-password/email-otp')
    expect(JSON.parse(String(mock.calls[1]!.init?.body))).toEqual({ email: 'ada@example.com' })
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

  // -------------------------------------------------------------------------
  // product recovery facade
  // -------------------------------------------------------------------------

  it('requestPasswordRecovery posts the email to the non-enumerating facade', async () => {
    const mock = installFetchMock(() => jsonResponse({ status: true }))
    harness.restoreFetch = mock.restore

    await authClient.requestPasswordRecovery({ email: 'ada@example.com' })

    expect(mock.calls).toHaveLength(1)
    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/recovery/password-reset')
    expect(JSON.parse(String(call.init?.body))).toEqual({ email: 'ada@example.com' })
    expect(requestHeaders(call).get('Origin')).toBe('http://localhost')
  })

  it('recoverWithOtp posts email + otp + newPassword (product field names) and refreshes', async () => {
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/recovery/otp-reset') {
        return jsonResponse({ status: true })
      }
      if (pathname === '/api/v1/session') {
        return jsonResponse(authenticatedSessionBody('csrf-after-recovery'))
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    await authClient.recoverWithOtp({ email: 'ada@example.com', otp: '445566', newPassword: 'fresh-password-789' })

    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/recovery/otp-reset')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      email: 'ada@example.com',
      otp: '445566',
      newPassword: 'fresh-password-789',
    })
    expect(getCsrfToken()).toBe('csrf-after-recovery')
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
