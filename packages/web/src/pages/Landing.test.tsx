// @vitest-environment happy-dom
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Landing } from './Landing'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: false, bootstrapping: false, sessionState: 'signed-out', serverBusySeconds: null as number | null, refreshSession: vi.fn(async () => {}) },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

describe('Landing', () => {
  function render() {
    mountTree(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route index element={<Landing />} />
          <Route path="library" element={<p>Library page</p>} />
          <Route path="login" element={<p>Login page</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  beforeEach(() => {
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.sessionState = 'signed-out'
    mocks.auth.serverBusySeconds = null
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
  })

  it('waits for the session before choosing a destination', () => {
    mocks.auth.bootstrapping = true
    render()
    expect(document.body.textContent).toBe('')
  })

  it('opens the library for a signed-in owner', () => {
    mocks.auth.isLoggedIn = true
    render()
    expect(document.body.textContent).toBe('Library page')
  })

  it('sends a guest to sign in', () => {
    render()
    expect(document.body.textContent).toBe('Login page')
  })

  it('stays on the outage state, not the sign-in form, while the session check fails (R15-23)', () => {
    mocks.auth.sessionState = 'offline'
    mocks.auth.serverBusySeconds = 42
    render()
    expect(document.body.textContent).not.toContain('Login page')
    expect(document.querySelector('h1')?.textContent).toBe('COLP Server is busy right now')
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
  })
})
