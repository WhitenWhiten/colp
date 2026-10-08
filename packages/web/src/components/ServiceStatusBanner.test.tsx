// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceStatusBanner } from './ServiceStatusBanner'
import { cleanup, mountTree } from '../test/render'

const auth = vi.hoisted(() => ({ sessionState: 'ready' }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }))

describe('ServiceStatusBanner (R15-23)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => cleanup())

  it('announces an unreachable service while the session read keeps failing', () => {
    auth.sessionState = 'offline'
    mountTree(<ServiceStatusBanner />)
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Can't reach Know-N. Retrying…")
  })

  it('renders nothing otherwise', () => {
    auth.sessionState = 'signed-out'
    mountTree(<ServiceStatusBanner />)
    expect(document.querySelector('[role="status"]')).toBeNull()
  })
})
