/**
 * P1-13: session/CSRF store must keep csrfToken in memory only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMeView,
  applySessionView,
  clearSession,
  getCsrfToken,
  getSessionSnapshot,
  isAuthenticated,
  privateSessionIdentity,
  subscribeSession,
  verifiedSessionAccountId,
} from './sessionStore'
import {
  createMemorySessionStorage,
  installSessionStorage,
} from './test-helpers'

describe('sessionStore', () => {
  afterEach(() => {
    clearSession()
  })

  it('preserves feature switches across profile command responses only for the same account', () => {
    const view = {
      account: { id: 'owner', email: 'owner@test' },
      profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null },
    }
    applyMeView({ ...view, features: { agentActivity: true } })
    applyMeView(view, { preserveFeatures: true })
    expect(getSessionSnapshot().me?.features?.agentActivity).toBe(true)
    applyMeView({ ...view, features: { agentActivity: false } }, { preserveFeatures: true })
    expect(getSessionSnapshot().me?.features?.agentActivity).toBe(false)
    applyMeView({ ...view, account: { ...view.account, id: 'other' } }, { preserveFeatures: true })
    expect(getSessionSnapshot().me?.features).toBeUndefined()
    applyMeView({ ...view, features: { agentActivity: true } })
    applyMeView(view)
    expect(getSessionSnapshot().me?.features).toBeUndefined()
  })

  it('stores csrfToken only in memory (not sessionStorage / localStorage)', () => {
    const sessionStorage = createMemorySessionStorage()
    const localStorage = createMemorySessionStorage()
    const restoreSession = installSessionStorage(sessionStorage)
    const g = globalThis as typeof globalThis & { localStorage?: Storage }
    const prevLocal = g.localStorage
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      value: localStorage,
    })

    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-memory-only',
      idleExpiresAt: '2026-07-23T00:00:00.000Z',
      absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
    })

    expect(getCsrfToken()).toBe('csrf-memory-only')
    expect(isAuthenticated()).toBe(true)
    expect(sessionStorage.length).toBe(0)
    expect(localStorage.length).toBe(0)

    // No key should contain the csrf token string
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!
      expect(sessionStorage.getItem(key)).not.toContain('csrf-memory-only')
    }

    clearSession()
    expect(getCsrfToken()).toBeNull()
    expect(isAuthenticated()).toBe(false)

    restoreSession()
    if (prevLocal === undefined) {
      Object.defineProperty(g, 'localStorage', {
        configurable: true,
        value: undefined,
      })
    } else {
      g.localStorage = prevLocal
    }
  })

  it('clears me when session becomes unauthenticated', () => {
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-1',
      idleExpiresAt: '2026-07-23T00:00:00.000Z',
      absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
    })
    applyMeView({
      account: { id: 'acc-1', email: 'a@b.c' },
      profile: { id: 'p-1', handle: 'a', displayName: 'A', avatarUrl: null, about: '' },
    })
    expect(getSessionSnapshot().me?.account.id).toBe('acc-1')

    applySessionView({ authenticated: false })
    expect(getSessionSnapshot().me).toBeNull()
    expect(getCsrfToken()).toBeNull()
    expect(getSessionSnapshot().verificationRequired).toBe(false)
  })

  it('records unverified occupancy without treating it as authenticated', () => {
    applySessionView({ authenticated: false, verificationRequired: true })
    expect(isAuthenticated()).toBe(false)
    expect(getCsrfToken()).toBeNull()
    expect(getSessionSnapshot().verificationRequired).toBe(true)
    expect(getSessionSnapshot().me).toBeNull()

    clearSession()
    expect(getSessionSnapshot().verificationRequired).toBe(false)
  })

  it('notifies subscribers on session changes', () => {
    const seen: boolean[] = []
    const unsub = subscribeSession((s) => seen.push(s.authenticated))
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-1',
      idleExpiresAt: '2026-07-23T00:00:00.000Z',
      absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
    })
    clearSession()
    unsub()
    expect(seen).toEqual([true, false])
  })

  it('does not bump sessionEpoch when /me first hydrates the signed-in actor', () => {
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-1',
      idleExpiresAt: '2026-07-23T00:00:00.000Z',
      absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
    })
    const afterSession = getSessionSnapshot().sessionEpoch
    applyMeView({
      account: { id: 'acc-1', email: 'a@b.c' },
      profile: { id: 'p-1', handle: 'a', displayName: 'A', avatarUrl: null, about: '' },
    })
    expect(getSessionSnapshot().sessionEpoch).toBe(afterSession)
    expect(privateSessionIdentity()).toBe(`session:${afterSession}`)

    applyMeView({
      account: { id: 'acc-2', email: 'b@b.c' },
      profile: { id: 'p-2', handle: 'b', displayName: 'B', avatarUrl: null, about: '' },
    })
    expect(getSessionSnapshot().sessionEpoch).toBe(afterSession + 1)

    applyMeView(null)
    expect(getSessionSnapshot().sessionEpoch).toBe(afterSession + 2)
  })

  it('requires /me to verify the account again after the browser session changes', () => {
    const session = { authenticated: true as const, csrfToken: 'csrf-1', idleExpiresAt: '2099-01-01', absoluteExpiresAt: '2099-01-02' }
    const actor = { account: { id: 'a', email: null }, profile: { id: 'a', handle: 'a', displayName: 'A', avatarUrl: null } }
    applySessionView(session)
    expect(verifiedSessionAccountId()).toBeUndefined()
    applyMeView(actor)
    expect(verifiedSessionAccountId()).toBe('a')
    applySessionView({ ...session, csrfToken: 'csrf-2' })
    expect(verifiedSessionAccountId()).toBeUndefined()
    applyMeView(actor)
    expect(verifiedSessionAccountId()).toBe('a')
    clearSession()
    expect(verifiedSessionAccountId()).toBeUndefined()
  })
})
