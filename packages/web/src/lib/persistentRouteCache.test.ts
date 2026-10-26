// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { clearRouteCache, readRouteCache, writeRouteCache } from './routeCache'

const key = 'known.library.read-cache.v1:account-library'
const library = { library: { id: 'library-a', rootNodeId: 'root-a', library: true }, state: 'ready', message: 'Your library' }

function authenticate(id = 'a') {
  applySessionView({ authenticated: true, csrfToken: 'private-csrf', idleExpiresAt: '2099-01-01', absoluteExpiresAt: '2099-01-02' })
  applyMeView({ account: { id, email: null }, profile: { id, handle: id, displayName: id, avatarUrl: null } })
}

function persist() { window.dispatchEvent(new Event('pagehide')) }

beforeEach(() => { clearSession(); clearRouteCache(); localStorage.clear(); authenticate() })
afterEach(() => { vi.restoreAllMocks(); clearSession(); clearRouteCache(); localStorage.clear() })

test('Library read models survive a fresh memory cache without persisting session material', () => {
  writeRouteCache('account-library', library)
  persist()
  clearRouteCache()
  expect(readRouteCache('account-library')).toEqual(library)
  expect(localStorage.getItem(key)).not.toContain('private-csrf')
  writeRouteCache('other-route', { csrfToken: 'memory-only' })
  persist()
  clearRouteCache()
  expect(readRouteCache('other-route')).toBeUndefined()
})

test('a persisted Library is unavailable until /me verifies the same account', () => {
  writeRouteCache('account-library', library)
  persist()
  const stored = localStorage.getItem(key)!
  clearSession()
  clearRouteCache()
  localStorage.setItem(key, stored)
  expect(readRouteCache('account-library')).toBeUndefined()
  applySessionView({ authenticated: true, csrfToken: 'new-csrf', idleExpiresAt: '2099-01-01', absoluteExpiresAt: '2099-01-02' })
  expect(readRouteCache('account-library')).toBeUndefined()
  applyMeView({ account: { id: 'a', email: null }, profile: { id: 'a', handle: 'a', displayName: 'A', avatarUrl: null } })
  expect(readRouteCache('account-library')).toEqual(library)
})

test('logout and account replacement remove persisted and pending Library snapshots', () => {
  writeRouteCache('account-library', library)
  persist()
  writeRouteCache('library-desk', { snaps: {}, expanded: [] })
  authenticate('b')
  persist()
  expect(readRouteCache('account-library')).toBeUndefined()
  expect(localStorage.getItem(key)).toBeNull()
  expect(localStorage.getItem('known.library.read-cache.v1:library-desk')).toBeNull()
  writeRouteCache('account-library', library)
  persist()
  clearSession()
  expect(localStorage.getItem(key)).toBeNull()
})

test('a replacement session cannot restore the previous profile before its own /me response', () => {
  writeRouteCache('account-library', library)
  persist()
  applySessionView({ authenticated: true, csrfToken: 'replacement-csrf', idleExpiresAt: '2099-01-01', absoluteExpiresAt: '2099-01-02' })
  expect(readRouteCache('account-library')).toBeUndefined()
  applyMeView({ account: { id: 'b', email: null }, profile: { id: 'b', handle: 'b', displayName: 'B', avatarUrl: null } })
  expect(readRouteCache('account-library')).toBeUndefined()
  expect(localStorage.getItem(key)).toBeNull()
})

test('corrupt and incomplete snapshots fall back to a network load', () => {
  const invalid = [
    'invalid json',
    JSON.stringify({ accountId: 'a', savedAt: Date.now(), value: { library: {} } }),
    JSON.stringify({ accountId: 'b', savedAt: Date.now(), value: library }),
  ]
  for (const value of invalid) {
    localStorage.setItem(key, value)
    expect(readRouteCache('account-library')).toBeUndefined()
  }
  localStorage.setItem('known.library.read-cache.v1:library-desk', JSON.stringify({
    accountId: 'a', savedAt: Date.now(), value: { snaps: { broken: {} }, expanded: [] },
  }))
  expect(readRouteCache('library-desk')).toBeUndefined()
})

test('blocked or exhausted storage leaves the in-memory cache usable', () => {
  const storage = window.localStorage
  const write = vi.fn(() => { throw new Error('quota') })
  const access = vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
    getItem: storage.getItem.bind(storage), setItem: write, removeItem: storage.removeItem.bind(storage),
    clear: storage.clear.bind(storage), key: storage.key.bind(storage), length: storage.length,
  })
  writeRouteCache('account-library', library)
  expect(persist).not.toThrow()
  expect(write).toHaveBeenCalled()
  expect(readRouteCache('account-library')).toEqual(library)
  clearRouteCache()
  access.mockImplementation(() => { throw new Error('blocked') })
  expect(readRouteCache('account-library')).toBeUndefined()
})

test('a snapshot stays available after 30 days; its server revision controls freshness', () => {
  localStorage.setItem(key, JSON.stringify({ accountId: 'a', savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, value: library }))
  expect(readRouteCache('account-library')).toEqual(library)
})
