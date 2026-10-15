// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthStatusRegion } from './AuthStatusRegion'
import { cleanup, mountTree } from '../../test/render'

const mocks = vi.hoisted(() => ({ sessionState: 'ready' as string, serverBusySeconds: null as number | null }))
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ sessionState: mocks.sessionState, serverBusySeconds: mocks.serverBusySeconds }) }))

describe('AuthStatusRegion accessible feedback', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.sessionState = 'ready'
    mocks.serverBusySeconds = null
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<MemoryRouter><AuthStatusRegion /></MemoryRouter>)
  }

  it('announces the bootstrap loading state through a polite live region', () => {
    mocks.sessionState = 'loading'
    render()
    const status = document.querySelector('[role="status"]')
    expect(status?.textContent).toContain('Loading your session')
  })

  it('announces the offline state without dropping the signed-in identity', () => {
    mocks.sessionState = 'offline'
    render()
    expect(document.querySelector('[role="status"]')?.textContent).toContain("You're offline")
  })

  it('says the server is busy, not that the browser is offline, when it rate-limits the check', () => {
    mocks.sessionState = 'offline'
    mocks.serverBusySeconds = 90
    render()
    expect(document.querySelector('[role="status"]')?.textContent).toBe('COLP Server is busy. Checking your session again in about 2 minutes.')
  })

  it('announces an expired session as an alert with an auth-restart action', () => {
    mocks.sessionState = 'expired'
    render()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Your session has expired')
    const link = document.querySelector<HTMLAnchorElement>('a[href="/auth/recovery?auth=restart"]')
    expect(link?.textContent).toContain('Restart your session')
  })

  it.each(['ready', 'signed-out'])('renders nothing in the %s state', (state) => {
    mocks.sessionState = state
    render()
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
