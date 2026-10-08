/**
 * authClient OAuth start, consent, and account-link contracts.
 * Shared harness: authClient.test-helper.ts
 */
import { describe, expect, it } from 'vitest'
import { authClient } from './authClient'
import { installAuthClientTestLifecycle } from './authClient.test-helper'
import {
  installFetchMock,
  jsonResponse,
  requestHeaders,
  requestMethod,
  requestPathAndSearch,
  seedAuthenticatedSession,
} from './test-helpers'

describe('authClient oauth', () => {
  const harness = installAuthClientTestLifecycle()

  it('getOAuthPublicClient reads CIMD public fields without CSRF/Origin headers', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ client_id: 'https://cimd.example/client.json', client_name: 'Cursor' }),
    )
    harness.restoreFetch = mock.restore

    const client = await authClient.getOAuthPublicClient({
      clientId: 'https://cimd.example/client.json',
    })

    expect(client.client_name).toBe('Cursor')
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    const url = requestPathAndSearch(call)
    expect(url.pathname).toBe('/api/v1/auth/oauth2/public-client')
    expect(url.searchParams.get('client_id')).toBe('https://cimd.example/client.json')
    expect(call.init?.credentials).toBe('include')
    expect(requestHeaders(call).get('X-CSRF-Token')).toBeNull()
    expect(requestHeaders(call).get('Origin')).toBeNull()
  })

  it('getOAuthConsentTransaction GETs the signed oauth_query without CSRF/Origin headers', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({
        client_id: 'https://cimd.example/client.json',
        client_name: 'Cursor',
        redirect_uri: 'https://cimd.example/callback',
      }),
    )
    harness.restoreFetch = mock.restore
    const oauthQuery = 'client_id=https%3A%2F%2Fcimd.example%2Fclient.json&redirect_uri=https%3A%2F%2Fcimd.example%2Fcallback&sig=abc'

    const transaction = await authClient.getOAuthConsentTransaction({ oauthQuery })

    expect(transaction).toEqual({
      client_id: 'https://cimd.example/client.json',
      client_name: 'Cursor',
      redirect_uri: 'https://cimd.example/callback',
    })
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    const url = requestPathAndSearch(call)
    expect(url.pathname).toBe('/api/v1/auth/oauth2/consent-transaction')
    expect(url.searchParams.get('oauth_query')).toBe(oauthQuery)
    expect(call.init?.credentials).toBe('include')
    expect(requestHeaders(call).get('X-CSRF-Token')).toBeNull()
    expect(requestHeaders(call).get('Origin')).toBeNull()
  })

  it('submitOAuthConsent posts accept to /oauth2/consent and returns the authorize redirect', async () => {
    seedAuthenticatedSession('csrf-consent')
    const mock = installFetchMock(() =>
      jsonResponse({
        redirect: true,
        url: 'https://cimd.example/callback?code=auth-code&state=xyz',
      }),
    )
    harness.restoreFetch = mock.restore

    const result = await authClient.submitOAuthConsent({
      accept: true,
      scope: 'mcp:read:public mcp:read:own',
      oauth_query: 'client_id=https%3A%2F%2Fcimd.example%2Fclient.json&scope=mcp%3Aread%3Apublic',
    })

    expect(result).toEqual({
      redirect: true,
      url: 'https://cimd.example/callback?code=auth-code&state=xyz',
    })
    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/oauth2/consent')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      accept: true,
      scope: 'mcp:read:public mcp:read:own',
      oauth_query: 'client_id=https%3A%2F%2Fcimd.example%2Fclient.json&scope=mcp%3Aread%3Apublic',
    })
    expect(requestHeaders(call).get('X-CSRF-Token')).toBe('csrf-consent')
    expect(requestHeaders(call).get('Origin')).toBe('http://localhost')
  })

  it('startOAuth posts providerId + callbackURL and returns the authorization URL', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz', redirect: true }),
    )
    harness.restoreFetch = mock.restore

    const result = await authClient.startOAuth({
      providerId: 'google',
      callbackURL: '/library',
      errorCallbackURL: '/login?auth=failed',
      newUserCallbackURL: '/onboarding',
      disableRedirect: true,
    })

    expect(result).toEqual({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz',
      redirect: true,
    })
    const call = mock.calls[0]!
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/sign-in/social')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      provider: 'google',
      callbackURL: '/library',
      errorCallbackURL: '/login?auth=failed',
      newUserCallbackURL: '/onboarding',
      disableRedirect: true,
    })
    expect(requestHeaders(call).get('Origin')).toBe('http://localhost')
  })

  it('rejects cross-origin callback URLs on OAuth start/link without a network call', async () => {
    const mock = installFetchMock(() => {
      throw new Error('cross-origin callbackURL must fail before fetch')
    })
    harness.restoreFetch = mock.restore

    await expect(
      authClient.startOAuth({ providerId: 'google', callbackURL: 'https://evil.example/phish' }),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 })
    await expect(
      authClient.startOAuth({ providerId: 'google', callbackURL: '/safe', errorCallbackURL: 'https://evil.example/phish' }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      authClient.linkOAuth({
        providerId: 'google',
        callbackURL: '//evil.example/phish',
        reauth: { kind: 'password', password: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      authClient.startOAuth({ providerId: 'google', callbackURL: '/safe', newUserCallbackURL: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(mock.calls).toHaveLength(0)
  })

  it('rejects same-origin callback URLs that normalize to a `//` path (R15-20)', async () => {
    const mock = installFetchMock(() => {
      throw new Error('protocol-relative callbackURL must fail before fetch')
    })
    harness.restoreFetch = mock.restore

    for (const callbackURL of ['http://localhost//evil.example', 'http://localhost/\\evil.example', '/.//evil.example']) {
      await expect(authClient.startOAuth({ providerId: 'google', callbackURL })).rejects.toMatchObject({ code: 'invalid_request' })
    }
    expect(mock.calls).toHaveLength(0)
  })

  it('accepts a same-origin absolute callback URL on OAuth start', async () => {
    const mock = installFetchMock(() => jsonResponse({ url: 'https://accounts.google.com/…', redirect: true }))
    harness.restoreFetch = mock.restore

    await authClient.startOAuth({ providerId: 'google', callbackURL: 'http://localhost/library' })

    const call = mock.calls[0]!
    expect(JSON.parse(String(call.init?.body))).toEqual({
      provider: 'google',
      callbackURL: 'http://localhost/library',
    })
  })

  it('linkOAuth and unlinkOAuth post provider ids with the in-memory CSRF token', async () => {
    seedAuthenticatedSession('csrf-link')
    const mock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/auth/oauth2/link') {
        return jsonResponse({ url: 'https://github.com/login/oauth/authorize?state=abc', redirect: true })
      }
      if (pathname === '/api/v1/auth/unlink-account') {
        return jsonResponse({ status: true })
      }
      throw new Error(`unexpected request ${pathname}`)
    })
    harness.restoreFetch = mock.restore

    const link = await authClient.linkOAuth({
      providerId: 'github',
      callbackURL: '/settings/security',
      reauth: { kind: 'password', password: 'pw-1' },
    })
    expect(link.redirect).toBe(true)

    const linkCall = mock.calls[0]!
    expect(requestPathAndSearch(linkCall).pathname).toBe('/api/v1/auth/oauth2/link')
    expect(JSON.parse(String(linkCall.init?.body))).toEqual({
      providerId: 'github',
      callbackURL: '/settings/security',
      reauth: { kind: 'password', password: 'pw-1' },
    })
    const linkHeaders = requestHeaders(linkCall)
    expect(linkHeaders.get('X-CSRF-Token')).toBe('csrf-link')
    expect(linkHeaders.get('Origin')).toBe('http://localhost')

    await authClient.unlinkOAuth({
      providerId: 'github',
      accountId: 'gh-1',
      reauth: { kind: 'password', password: 'pw-1' },
    })
    const unlinkCall = mock.calls[1]!
    expect(requestPathAndSearch(unlinkCall).pathname).toBe('/api/v1/auth/unlink-account')
    expect(JSON.parse(String(unlinkCall.init?.body))).toEqual({
      providerId: 'github',
      accountId: 'gh-1',
      reauth: { kind: 'password', password: 'pw-1' },
    })
    expect(requestHeaders(unlinkCall).get('X-CSRF-Token')).toBe('csrf-link')
  })

  it('listLinkedAccounts GETs the product list without CSRF', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ accounts: [{ providerId: 'google', accountId: 'g-1' }], hasPassword: false }),
    )
    harness.restoreFetch = mock.restore

    const result = await authClient.listLinkedAccounts()
    expect(result.accounts).toEqual([{ providerId: 'google', accountId: 'g-1' }])
    expect(result.hasPassword).toBe(false)
    const call = mock.calls[0]!
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/auth/linked-accounts')
    expect(requestHeaders(call).get('X-CSRF-Token')).toBeNull()
  })
})
