// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Consent, consentScopeLabel } from './Consent'
import { safeReturnTo } from './safeReturnTo'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'

const CIMD_CLIENT_ID = 'https://cimd.example/client.json'
const CLIENT_NAME = 'Cursor'
const SCOPE = 'mcp:read:public mcp:read:own'
const VERIFIED_REDIRECT = 'https://cimd.example/callback'
const VERIFIED_HOST = 'cimd.example'
const EVIL_REDIRECT = 'https://evil.example/callback'
const PRIVATE_USE_REDIRECT = 'com.example.app:/oauth/callback'
const APPROVE_REDIRECT = 'https://cimd.example/callback?code=auth-code&state=xyz'
const DENY_REDIRECT = 'https://cimd.example/callback?error=access_denied&error_description=User%20denied%20access&state=xyz'

function consentPath(extra?: Record<string, string>): string {
  const params = new URLSearchParams({
    client_id: CIMD_CLIENT_ID,
    scope: SCOPE,
    ...extra,
  })
  return `/consent?${params.toString()}`
}

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as { name: string } | null,
    isLoggedIn: false,
    bootstrapping: false,
    csrfToken: null as string | null,
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  toast: {
    toast: vi.fn<(msg: string, variant?: string) => void>(),
    success: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  },
  authClient: {
    getOAuthConsentTransaction: vi.fn(),
    submitOAuthConsent: vi.fn(),
  },
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../components/AppToast', () => ({ useToast: () => mocks.toast }))
vi.mock('../api/authClient', () => ({ authClient: mocks.authClient }))

function LoginProbe() {
  const [params] = useSearchParams()
  return <div data-testid="page-login" data-return-to={params.get('returnTo') ?? ''} />
}

describe('Consent page', () => {
  let restoreLocation: () => void

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = { name: 'Ada' }
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.toast.error.mockReset()
    mocks.authClient.getOAuthConsentTransaction.mockReset().mockResolvedValue({
      client_id: CIMD_CLIENT_ID,
      client_name: CLIENT_NAME,
      redirect_uri: VERIFIED_REDIRECT,
    })
    mocks.authClient.submitOAuthConsent.mockReset()
    const g = globalThis as typeof globalThis & { location?: { origin: string; assign?: (url: string) => void } }
    const previous = g.location
    Object.defineProperty(g, 'location', {
      configurable: true,
      value: { origin: 'http://localhost', assign: vi.fn() },
    })
    restoreLocation = () => {
      if (previous === undefined) {
        Object.defineProperty(g, 'location', { configurable: true, value: undefined })
      } else {
        Object.defineProperty(g, 'location', { configurable: true, value: previous })
      }
    }
  })

  afterEach(() => {
    cleanup()
    restoreLocation()
  })

  function render(initialPath = consentPath()) {
    mountTree(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/consent" element={<Consent />} />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('renders the CIMD client_name, requested scopes, and verified redirect hostname and URI', async () => {
    render()
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    expect(document.body.textContent).toContain(CLIENT_NAME)
    expect(document.body.textContent).toContain('mcp:read:public')
    expect(document.body.textContent).toContain('mcp:read:own')
    expect(document.body.textContent).toContain('Read published public libraries')
    expect(document.body.textContent).toContain('Read libraries you own')
    expect(document.body.textContent).toContain(VERIFIED_HOST)
    expect(document.body.textContent).toContain(VERIFIED_REDIRECT)
    expect(document.body.textContent).toContain('authorization code will be sent')
    expect(mocks.authClient.getOAuthConsentTransaction).toHaveBeenCalledWith({
      oauthQuery: new URLSearchParams({ client_id: CIMD_CLIENT_ID, scope: SCOPE }).toString(),
    })
  })

  it('does not flash the raw client_id before issuer-verified client_name loads', async () => {
    let resolveClient!: (value: { client_id: string; client_name: string; redirect_uri: string }) => void
    mocks.authClient.getOAuthConsentTransaction.mockReturnValue(
      new Promise((resolve) => {
        resolveClient = resolve
      }),
    )
    render()
    expect(document.body.textContent).toContain('Looking up this application')
    expect(document.body.textContent).not.toContain(CIMD_CLIENT_ID)
    expect(document.body.textContent).not.toContain(`Allow ${CLIENT_NAME}`)
    await act(async () => {
      resolveClient({
        client_id: CIMD_CLIENT_ID,
        client_name: CLIENT_NAME,
        redirect_uri: VERIFIED_REDIRECT,
      })
    })
    await waitForDom(() => (document.body.textContent ?? '').includes(`Allow ${CLIENT_NAME}?`))
    expect(document.body.textContent).toContain(CLIENT_NAME)
    expect(document.body.textContent).toContain(VERIFIED_REDIRECT)
    expect(document.body.textContent).not.toContain('Looking up this application')
  })

  it('falls back to client_id when consent-transaction lookup fails and shows no redirect URI', async () => {
    mocks.authClient.getOAuthConsentTransaction.mockRejectedValue(new Error('offline'))
    render(consentPath({ redirect_uri: EVIL_REDIRECT }))
    await waitForDom(() => (document.body.textContent ?? '').includes(`Allow ${CIMD_CLIENT_ID}?`))
    expect(document.body.textContent).toContain(`${CIMD_CLIENT_ID} is requesting access`)
    expect(document.body.textContent).not.toContain('authorization code will be sent')
    expect(document.body.textContent).not.toContain(EVIL_REDIRECT)
    expect(document.body.textContent).not.toContain('evil.example')
  })

  it('does not seed the display name from a client_name query parameter', async () => {
    render(consentPath({ client_name: 'Evil App' }))
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    expect(document.body.textContent).toContain(`Allow ${CLIENT_NAME}?`)
    expect(document.body.textContent).not.toContain('Evil App')
  })

  it('shows the server-verified redirect and ignores an unsigned query redirect_uri', async () => {
    render(consentPath({ redirect_uri: EVIL_REDIRECT }))
    await waitForDom(() => (document.body.textContent ?? '').includes(VERIFIED_REDIRECT))
    expect(document.body.textContent).toContain(VERIFIED_HOST)
    expect(document.body.textContent).toContain(VERIFIED_REDIRECT)
    expect(document.body.textContent).not.toContain(EVIL_REDIRECT)
    expect(document.body.textContent).not.toContain('evil.example')
  })

  it('shows a verified RFC 8252 private-use redirect URI and ignores an unsigned query redirect_uri', async () => {
    mocks.authClient.getOAuthConsentTransaction.mockResolvedValue({
      client_id: CIMD_CLIENT_ID,
      client_name: CLIENT_NAME,
      redirect_uri: PRIVATE_USE_REDIRECT,
    })
    render(consentPath({ redirect_uri: EVIL_REDIRECT }))
    await waitForDom(() => (document.body.textContent ?? '').includes(PRIVATE_USE_REDIRECT))
    expect(document.body.textContent).toContain(PRIVATE_USE_REDIRECT)
    expect(document.body.textContent).toContain('authorization code will be sent')
    expect(document.body.textContent).not.toContain(EVIL_REDIRECT)
    expect(document.body.textContent).not.toContain('evil.example')
  })

  it('does not display an unsigned query redirect_uri when server verification fails', async () => {
    mocks.authClient.getOAuthConsentTransaction.mockRejectedValue(new Error('invalid_signature'))
    render(consentPath({ redirect_uri: EVIL_REDIRECT, client_name: 'Evil App' }))
    await waitForDom(() => (document.body.textContent ?? '').includes(`Allow ${CIMD_CLIENT_ID}?`))
    expect(document.body.textContent).not.toContain('Evil App')
    expect(document.body.textContent).not.toContain(EVIL_REDIRECT)
    expect(document.body.textContent).not.toContain('evil.example')
    expect(document.body.textContent).not.toContain('authorization code will be sent')
  })

  it('approves by posting accept to Better Auth and following the authorize redirect', async () => {
    mocks.authClient.submitOAuthConsent.mockResolvedValue({
      redirect: true,
      url: APPROVE_REDIRECT,
    })
    render()
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    await act(async () => {
      findButtonByName('Approve').click()
    })

    expect(mocks.authClient.submitOAuthConsent).toHaveBeenCalledWith({
      accept: true,
      scope: SCOPE,
      oauth_query: new URLSearchParams({
        client_id: CIMD_CLIENT_ID,
        scope: SCOPE,
      }).toString(),
    })
    const assign = (globalThis as { location?: { assign?: (url: string) => void } }).location?.assign
    expect(assign).toHaveBeenCalledWith(APPROVE_REDIRECT)
  })

  it('denies by posting accept false and following the access_denied redirect', async () => {
    mocks.authClient.submitOAuthConsent.mockResolvedValue({
      redirect: true,
      url: DENY_REDIRECT,
    })
    render()
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    await act(async () => {
      findButtonByName('Deny').click()
    })

    expect(mocks.authClient.submitOAuthConsent).toHaveBeenCalledWith({
      accept: false,
      scope: SCOPE,
      oauth_query: new URLSearchParams({
        client_id: CIMD_CLIENT_ID,
        scope: SCOPE,
      }).toString(),
    })
    const assign = (globalThis as { location?: { assign?: (url: string) => void } }).location?.assign
    expect(assign).toHaveBeenCalledWith(DENY_REDIRECT)
    expect(DENY_REDIRECT).toContain('error=access_denied')
  })

  it('shows human-readable labels for nodes:write and offline_access', async () => {
    render(consentPath({ scope: 'nodes:write offline_access' }))
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    expect(document.body.textContent).toContain('nodes:write')
    expect(document.body.textContent).toContain('offline_access')
    expect(document.body.textContent).toContain('Create and edit items in libraries you can write')
    expect(document.body.textContent).toContain('Stay signed in until you revoke access')
    expect(consentScopeLabel('nodes:write')).toBe('Create and edit items in libraries you can write')
    expect(consentScopeLabel('offline_access')).toBe('Stay signed in until you revoke access')
  })

  it('shows human-readable labels enumerating what product:read and product:write cover', async () => {
    render(consentPath({ scope: 'product:read product:write' }))
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    expect(document.body.textContent).toContain('product:read')
    expect(document.body.textContent).toContain('product:write')
    expect(document.body.textContent).toContain('Read your libraries, bookmarks, community activity, notifications, and favicons')
    expect(document.body.textContent).toContain('Create and edit your libraries, bookmarks, community posts and votes, and favicons')
    expect(consentScopeLabel('product:read')).toBe(
      'Read your libraries, bookmarks, community activity, notifications, and favicons',
    )
    expect(consentScopeLabel('product:write')).toBe(
      'Create and edit your libraries, bookmarks, community posts and votes, and favicons',
    )
  })

  it('still renders an unknown scope as code and does not crash', async () => {
    render(consentPath({ scope: 'not-a-real-scope' }))
    await waitForDom(() => (document.body.textContent ?? '').includes(CLIENT_NAME))
    expect(document.body.textContent).toContain('not-a-real-scope')
    const codes = [...document.querySelectorAll('ul.auth-consent-scopes code')].map((el) => el.textContent)
    expect(codes).toEqual(['not-a-real-scope'])
    expect(consentScopeLabel('not-a-real-scope')).toBeNull()
    expect(document.body.textContent).toContain(`Allow ${CLIENT_NAME}?`)
    expect(document.body.textContent).toContain('Approve')
    expect(document.body.textContent).toContain('Deny')
  })

  it('redirects an unauthenticated visitor to /login with a safe returnTo back to /consent plus the original query', () => {
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    render()

    const probe = document.querySelector('[data-testid="page-login"]')
    expect(probe).not.toBeNull()
    const returnTo = probe?.getAttribute('data-return-to')
    const expected = safeReturnTo(
      `/consent?${new URLSearchParams({ client_id: CIMD_CLIENT_ID, scope: SCOPE }).toString()}`,
    )
    expect(returnTo).toBe(expected)
    expect(returnTo?.startsWith('/consent')).toBe(true)
    expect(returnTo).toContain('client_id=')
    expect(returnTo).toContain('scope=')
  })

  it('never forwards a cross-origin returnTo to the login bounce', () => {
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    expect(safeReturnTo('https://evil.example/phish')).toBe('/library')
    render('/consent?returnTo=https%3A%2F%2Fevil.example%2Fphish')

    const probe = document.querySelector('[data-testid="page-login"]')
    expect(probe).not.toBeNull()
    const returnTo = probe?.getAttribute('data-return-to')
    expect(returnTo).toBe('/consent')
    expect(returnTo).not.toBe('https://evil.example/phish')
    expect(returnTo).not.toContain('evil.example')
  })
})
