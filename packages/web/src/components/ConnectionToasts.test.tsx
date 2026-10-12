// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionToasts } from './ConnectionToasts'
import { cleanup, mountTree } from '../test/render'

const auth = vi.hoisted(() => ({ sessionState: 'ready' }))
const toast = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn() }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('./AppToast', () => ({ useToast: () => toast }))

describe('ConnectionToasts (R15-23)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    toast.warning.mockClear()
    toast.success.mockClear()
  })

  afterEach(() => cleanup())

  it('warns once while the session read keeps failing, and says when it recovers', () => {
    auth.sessionState = 'offline'
    const root = mountTree(<ConnectionToasts online />)
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Can't reach COLP Server. Retrying…")
    auth.sessionState = 'ready'
    root.rerender(<ConnectionToasts online />)
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('COLP Server is reachable again.')
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('warns when the browser goes offline and says when it is back', () => {
    auth.sessionState = 'ready'
    const root = mountTree(<ConnectionToasts online />)
    expect(toast.warning).not.toHaveBeenCalled()
    root.rerender(<ConnectionToasts online={false} />)
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith('You’re offline. Saving is paused until you reconnect.')
    root.rerender(<ConnectionToasts online />)
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('You’re back online.')
  })

  it('stays silent on a connected page load', () => {
    auth.sessionState = 'signed-out'
    mountTree(<ConnectionToasts online />)
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(document.querySelector('[role="status"]')).toBeNull()
  })
})
