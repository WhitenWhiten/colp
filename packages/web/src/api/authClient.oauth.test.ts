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
