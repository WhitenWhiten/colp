// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError, isProductApiError, productClient } from '../api'
import type { MeView } from '../api'
import type { SessionView } from '../api/types'
import { applyMeView, applySessionView, clearSession, getCsrfToken, getSessionSnapshot } from '../api/sessionStore'
import {
  installFetchMock,
  jsonResponse,
  productErrorBody,
  requestHeaders,
  requestPathAndSearch,
} from '../api/test-helpers'
import { AuthProvider, useAuth } from './AuthContext'
import { cleanup, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  deleteSession: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  authClient: {
    changePassword: vi.fn(),
    revokeSession: vi.fn(),
  },
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, bootstrapSession: mocks.bootstrap, deleteSession: mocks.deleteSession, subscribeSession: mocks.subscribe } }
})
vi.mock('../api/authClient', () => ({ authClient: mocks.authClient }))

const session: SessionView = { authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-07-25T00:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' }
const me: MeView = { account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'Account A', avatarUrl: null } }

/**
 * Swappable per-test action executed through AuthContext.runAuthMutation.
 * The button click stores the promise so tests can await rejections.
 */
let harnessAction: () => Promise<unknown> = async () => undefined
let runResult: Promise<unknown> | null = null
let logoutResult: Promise<unknown> | null = null

function Harness() {
  const auth = useAuth()
  return (
    <div data-testid="auth" data-logged-in={auth.isLoggedIn} data-session-state={auth.sessionState}>
      {auth.user?.name ?? 'signed out'}
      <button onClick={() => void auth.refreshSession()}>Refresh</button>
      <button onClick={() => { logoutResult = auth.logout() }}>Logout</button>
      <button onClick={() => { const p = auth.runAuthMutation(harnessAction); runResult = p; p.catch(() => {}) }}>RunMutation</button>
    </div>
  )
}
describe('AuthProvider session ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks(); document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // The default bootstrap mirrors the real productClient.bootstrapSession
    // contract: it applies the session + me views to the in-memory store.
    mocks.bootstrap.mockImplementation(async () => {
      applySessionView(session)
      applyMeView(me)
      return { session, me }
    })
    mocks.deleteSession.mockResolvedValue(undefined)
    mocks.authClient.changePassword.mockResolvedValue({ status: true })
    mocks.authClient.revokeSession.mockResolvedValue({ status: true })
    harnessAction = async () => undefined
    runResult = null
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    clearSession()
  })

  function render() {
    mountTree(<AuthProvider><Harness /></AuthProvider>)
  }
  function loggedInState() {
    return document.querySelector('[data-testid="auth"]')?.getAttribute('data-logged-in')
  }
  function sessionState() {
    return document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state')
  }
  function authText() {
    return document.querySelector('[data-testid="auth"]')?.textContent ?? ''
  }
  function buttons() {
    return document.querySelectorAll<HTMLButtonElement>('button')
  }

  // C-02: a missing product session is signed out. Unverified occupancy is a
  // separate sessionState (pinned below). Library signed-out copy is pinned in
  // Library.test.tsx ('asks signed-out visitors to log in...').
  it('treats product /api/v1/session { authenticated: false } as signed out', async () => {
    mocks.bootstrap.mockImplementation(async () => {
      applySessionView({ authenticated: false })
      applyMeView(null)
      return { session: { authenticated: false }, me: null }
    })
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')

    expect(loggedInState()).toBe('false')
    expect(authText()).toContain('signed out')
    expect(sessionState()).toBe('signed-out')
    expect(getCsrfToken()).toBeNull()
    expect(getSessionSnapshot().authenticated).toBe(false)
    expect(getSessionSnapshot().me).toBeNull()
  })

  it('treats /session occupancy as verification-required, not signed out', async () => {
    mocks.bootstrap.mockImplementation(async () => {
      applySessionView({ authenticated: false, verificationRequired: true })
      applyMeView(null)
      return { session: { authenticated: false, verificationRequired: true }, me: null }
    })
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')

    expect(loggedInState()).toBe('false')
    expect(authText()).toContain('signed out')
    expect(sessionState()).toBe('verification-required')
    expect(getCsrfToken()).toBeNull()
    expect(getSessionSnapshot().authenticated).toBe(false)
    expect(getSessionSnapshot().verificationRequired).toBe(true)
    expect(getSessionSnapshot().me).toBeNull()
  })

  it('reports a failed logout and re-reads the session instead of claiming sign-out (R15-21)', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(authText()).toContain('Account A')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.deleteSession.mockRejectedValueOnce(
      new ProductApiError({ status: 503, code: 'internal_error', message: 'Product API error (503)' }),
    )
    const bootstrapsBefore = mocks.bootstrap.mock.calls.length

    act(() => buttons()[1]!.click())
    await act(async () => { await expect(logoutResult).resolves.toBe('failed') })
    await waitForDom(() => authText().includes('Account A'))
    expect(mocks.bootstrap.mock.calls.length).toBe(bootstrapsBefore + 1)
    expect(loggedInState()).toBe('true')
  })

  it('resolves signed-out when the server confirms the logout', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    mocks.deleteSession.mockResolvedValueOnce(undefined)
    act(() => buttons()[1]!.click())
    await act(async () => { await expect(logoutResult).resolves.toBe('signed-out') })
    expect(loggedInState()).toBe('false')
  })

  it('keeps the UI signed out when an earlier refresh resolves after logout', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(authText()).toContain('Account A')
    let resolveRefresh!: (value: { session: SessionView; me: MeView }) => void
    let refreshSignal: AbortSignal | undefined
    mocks.bootstrap.mockImplementationOnce((options) => {
      refreshSignal = options.signal
      return new Promise((resolve) => { resolveRefresh = resolve })
    })
    act(() => buttons()[0]!.click())
    act(() => buttons()[1]!.click())
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(refreshSignal?.aborted).toBe(true)
    expect(loggedInState()).toBe('false')
    await act(async () => { resolveRefresh({ session, me }); await Promise.resolve(); await Promise.resolve() })
    expect(authText()).toContain('signed out')
  })

  // Task D1 unified error mapping: a csrf_failed bootstrap is terminal — the
  // session cannot be established, so the UI must behave as signed out.
  // False-positive guard: no localStorage session is ever faked here; the
  // state only changes through the /api/v1/session + /me contract result.
  it('treats a csrf_failed refresh as signed out (no stale user)', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(authText()).toContain('Account A')

    mocks.bootstrap.mockRejectedValueOnce(
      new ProductApiError({ status: 403, code: 'csrf_failed', message: 'The request failed CSRF or Origin validation.' }),
    )
    act(() => buttons()[0]!.click())
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')

    expect(loggedInState()).toBe('false')
    expect(authText()).toContain('signed out')
  })

  // Task D3 bootstrap race (false-negative guard): an earlier bootstrap that
  // resolves after a newer refresh must be dropped — its stale identity must
  // never clobber the current session state.
  it('drops a stale earlier bootstrap that resolves after a newer refresh', async () => {
    /* Every mount bootstrap stays pending: StrictMode mounts the provider
       twice, so there are two in-flight mount reads to replay late below —
       the one StrictMode's own cleanup aborted and the one the refresh
       supersedes. A reply from either generation must be dropped. */
    const pendingBootstraps: Array<(value: { session: SessionView; me: MeView }) => void> = []
    mocks.bootstrap.mockImplementation(() => new Promise((resolve) => { pendingBootstraps.push(resolve) }))
    render()
    await settled()
    // Initial bootstrap still pending → the loading state is announced.
    expect(sessionState()).toBe('loading')

    // Baseline the mount reads; the only queued value below belongs to the
    // newer refresh.
    const mountBootstrapCalls = mocks.bootstrap.mock.calls.length
    mocks.bootstrap.mockResolvedValueOnce({ session, me })
    act(() => buttons()[0]!.click())
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(authText()).toContain('Account A')
    // The refresh issued exactly one further session+me read.
    expect(mocks.bootstrap).toHaveBeenCalledTimes(mountBootstrapCalls + 1)

    // The stale bootstrap reads resolve late with an older identity.
    await act(async () => {
      for (const resolveBootstrap of pendingBootstraps) {
        resolveBootstrap({
          session: { authenticated: true, csrfToken: 'csrf-stale', idleExpiresAt: '2026-07-25T00:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' },
          me: { account: { id: 'account-a', email: 'stale@test' }, profile: { id: 'profile-a', handle: 'stale', displayName: 'Stale Account', avatarUrl: null } },
        })
      }
      await Promise.resolve(); await Promise.resolve()
    })
    expect(authText()).toContain('Account A')
    expect(authText()).not.toContain('Stale Account')
    expect(sessionState()).toBe('ready')
  })

  it('marks the session expired when a refresh is rejected as authentication_required', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(authText()).toContain('Account A')
    expect(sessionState()).toBe('ready')

    mocks.bootstrap.mockRejectedValueOnce(
      new ProductApiError({ status: 401, code: 'authentication_required', message: 'Not authenticated' }),
    )
    act(() => buttons()[0]!.click())
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')

    expect(loggedInState()).toBe('false')
    expect(authText()).toContain('signed out')
    expect(sessionState()).toBe('expired')
  })

  it('keeps the user and announces offline on a transient bootstrap failure, then recovers', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(authText()).toContain('Account A')

    mocks.bootstrap.mockRejectedValueOnce(
      new ProductApiError({ status: 0, code: 'transport_error', message: 'network down', recovery: 'same_request', sameRequestRetrySafe: true }),
    )
    act(() => buttons()[0]!.click())
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(loggedInState()).toBe('true')
    expect(authText()).toContain('Account A')
    expect(sessionState()).toBe('offline')

    act(() => buttons()[0]!.click())
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(sessionState()).toBe('ready')
  })

  it('retries an offline session on its own and on reconnect (R15-23)', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    vi.useFakeTimers()
    try {
      mocks.bootstrap.mockRejectedValueOnce(
        new ProductApiError({ status: 503, code: 'internal_error', message: 'down', recovery: 'same_request', sameRequestRetrySafe: true }),
      )
      await act(async () => { buttons()[0]!.click() })
      expect(sessionState()).toBe('offline')
      const before = mocks.bootstrap.mock.calls.length

      await act(async () => { await vi.advanceTimersByTimeAsync(4_900) })
      expect(mocks.bootstrap.mock.calls.length).toBe(before)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(mocks.bootstrap.mock.calls.length).toBe(before + 1)
      expect(sessionState()).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  // False-negative guard (D3 §10): after any successful auth mutation the
  // AuthContext must re-read /api/v1/session + /api/v1/me (bootstrapSession
  // is the session + me contract read).
  it('re-reads /api/v1/session and /api/v1/me after a successful auth mutation', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    /* StrictMode double-invokes the provider mount bootstrap (the first read
       is aborted by the effect cleanup), so the baseline is what mounted,
       not 1. The guarantee asserted below is about the REQUEST: one
       successful mutation issues exactly one further session+me read. */
    const bootstrapCallsAfterMount = mocks.bootstrap.mock.calls.length

    harnessAction = () => mocks.authClient.changePassword({ currentPassword: 'old', newPassword: 'new-pass', revokeOtherSessions: true })
    act(() => buttons()[2]!.click())
    await act(async () => { await runResult })

    expect(mocks.authClient.changePassword).toHaveBeenCalledTimes(1)
    expect(mocks.bootstrap).toHaveBeenCalledTimes(bootstrapCallsAfterMount + 1)
    expect(authText()).toContain('Account A')
  })

  it('retries an auth mutation exactly once after a csrf_failed response and refreshes', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    const bootstrapCallsAfterMount = mocks.bootstrap.mock.calls.length
    mocks.authClient.changePassword
      .mockRejectedValueOnce(new ProductApiError({ status: 403, code: 'csrf_failed', message: 'stale csrf' }))
      .mockResolvedValueOnce({ status: true })

    harnessAction = () => mocks.authClient.changePassword({ currentPassword: 'old', newPassword: 'new-pass', revokeOtherSessions: true })
    act(() => buttons()[2]!.click())
    await act(async () => { await runResult })

    // Exactly one retry (the mutation ran twice in total) and exactly two
    // refreshes: the single csrf-branch refresh plus the post-success read.
    expect(mocks.authClient.changePassword).toHaveBeenCalledTimes(2)
    expect(mocks.bootstrap).toHaveBeenCalledTimes(bootstrapCallsAfterMount + 2)
    expect(authText()).toContain('Account A')
  })

  it('does not retry auth settings after refresh discovers another account', async () => {
    render()
    await waitForDom(() => sessionState() !== 'loading')
    mocks.authClient.changePassword.mockRejectedValueOnce(
      new ProductApiError({ status: 403, code: 'csrf_failed', message: 'stale csrf' }),
    )
    const otherMe: MeView = { ...me, account: { ...me.account, id: 'account-b' } }
    mocks.bootstrap.mockImplementationOnce(async () => {
      applySessionView(session)
      applyMeView(otherMe)
      return { session, me: otherMe }
    })
    harnessAction = () => mocks.authClient.changePassword({ currentPassword: 'old', newPassword: 'new-pass' })
    act(() => buttons()[2]!.click())
    let error: unknown
    await act(async () => { try { await runResult } catch (err) { error = err } })
    expect(error).toMatchObject({ code: 'mutation_conflict', sameRequestRetrySafe: false })
    expect(mocks.authClient.changePassword).toHaveBeenCalledTimes(1)
  })

  it('never loops or duplicates a mutation when the retry also fails with csrf_failed', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    const bootstrapCallsAfterMount = mocks.bootstrap.mock.calls.length
    mocks.authClient.changePassword.mockRejectedValue(
      new ProductApiError({ status: 403, code: 'csrf_failed', message: 'stale csrf' }),
    )

    harnessAction = () => mocks.authClient.changePassword({ currentPassword: 'old', newPassword: 'new-pass', revokeOtherSessions: true })
    act(() => buttons()[2]!.click())
    let error: unknown
    await act(async () => { try { await runResult } catch (err) { error = err } })

    expect(isProductApiError(error)).toBe(true)
    expect((error as ProductApiError).code).toBe('csrf_failed')
    // Exactly one retry and exactly one csrf-branch refresh — the retried
    // failure is surfaced instead of looping or firing a third mutation and
    // a second refresh.
    expect(mocks.authClient.changePassword).toHaveBeenCalledTimes(2)
    expect(mocks.bootstrap).toHaveBeenCalledTimes(bootstrapCallsAfterMount + 1)
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    expect(mocks.authClient.changePassword).toHaveBeenCalledTimes(2)
    expect(mocks.bootstrap).toHaveBeenCalledTimes(bootstrapCallsAfterMount + 1)
  })

  it('surfaces a retried failure without another refresh when the retry is rejected', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    const bootstrapCallsAfterMount = mocks.bootstrap.mock.calls.length
    mocks.authClient.changePassword
      .mockRejectedValueOnce(new ProductApiError({ status: 403, code: 'csrf_failed', message: 'stale csrf' }))
      .mockRejectedValueOnce(new ProductApiError({ status: 401, code: 'authentication_required', message: 'session gone' }))

    harnessAction = () => mocks.authClient.changePassword({ currentPassword: 'old', newPassword: 'new-pass', revokeOtherSessions: true })
    act(() => buttons()[2]!.click())
    let error: unknown
    await act(async () => { try { await runResult } catch (err) { error = err } })

    expect((error as ProductApiError).isAuthRequired).toBe(true)
    expect(mocks.authClient.changePassword).toHaveBeenCalledTimes(2)
    // The single csrf-branch refresh; the post-retry refresh is never
    // attempted because the retry rejected.
    expect(mocks.bootstrap).toHaveBeenCalledTimes(bootstrapCallsAfterMount + 1)
  })

  // False-positive guard (D3 §10): session revoke is proven through an auth
  // client response — the server-side revoke triggers the cleanup, and a
  // subsequent protected request must fail closed without the stale CSRF.
  it('clears stale session state through the auth client response before the next protected request', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="auth"]')?.getAttribute('data-session-state') !== 'loading')
    // Authenticated bootstrap wrote the real in-memory session store.
    expect(getCsrfToken()).toBe('csrf')

    // The auth client revokes the session; the response is the only trigger.
    mocks.authClient.revokeSession.mockResolvedValueOnce({ status: true })
    mocks.bootstrap.mockImplementationOnce(async () => {
      applySessionView({ authenticated: false })
      applyMeView(null)
      return { session: { authenticated: false }, me: null }
    })
    harnessAction = () => mocks.authClient.revokeSession({ token: 'session-1' })

    const fetchMock = installFetchMock((input, init) => {
      const { pathname } = requestPathAndSearch({ input, init })
      if (pathname === '/api/v1/session') return jsonResponse({ authenticated: false })
      if (pathname === '/api/v1/me') {
        return jsonResponse(productErrorBody({ code: 'authentication_required' }), { status: 401 })
      }
      throw new Error(`unexpected request ${requestPathAndSearch({ input, init }).pathname}`)
    })
    try {
      await act(async () => {
        act(() => buttons()[2]!.click())
        await runResult
      })

      expect(getCsrfToken()).toBeNull()
      expect(getSessionSnapshot().authenticated).toBe(false)
      expect(loggedInState()).toBe('false')
      expect(sessionState()).toBe('expired')

      // A subsequent protected request fails closed: it must not reuse the stale CSRF.
      let error: unknown
      try {
        await act(async () => {
          await productClient.updateMe({ handle: 'a', displayName: 'Account A' }, { intentId: 'update-me:guard' })
        })
      } catch (err) {
        error = err
      }
      expect(isProductApiError(error)).toBe(true)
      expect((error as ProductApiError).isAuthRequired).toBe(true)
      for (const call of fetchMock.calls) {
        expect(requestHeaders(call).get('x-csrf-token')).not.toBe('csrf')
      }
    } finally {
      fetchMock.restore()
    }
  })
})
