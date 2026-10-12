// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteTransportWarning, SubscribeInBrowserButton } from './TransportWarning'
import { cleanup, mountTree } from '../test/render'

const toast = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./AppToast', () => ({ useToast: () => toast }))

function manifestBody(transport: string): unknown {
  return {
    mounts: [{
      features: {
        transport,
        cloud: false,
        edition: { name: 'colp-server', version: '0.1.0' },
      },
    }],
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('plain-HTTP warning', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    sessionStorage.clear()
    toast.warning.mockClear()
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('toasts the insecure-http warning once per session and hides Subscribe in browser', async () => {
    const loadManifest = () => Promise.resolve(manifestBody('insecure-http'))
    mountTree(<><SiteTransportWarning loadManifest={loadManifest} /><SubscribeInBrowserButton /></>, { route: '/library' })
    await settle()
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('passwords and bookmarks travel unencrypted'))
    expect(document.body.textContent).not.toContain('Subscribe in browser')
    cleanup()
    mountTree(<SiteTransportWarning loadManifest={loadManifest} />, { route: '/agents' })
    await settle()
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('warns again on the sign-in page, where the password is typed', async () => {
    sessionStorage.setItem('colp.plain-http-warned', '1')
    mountTree(<SiteTransportWarning loadManifest={() => Promise.resolve(manifestBody('insecure-http'))} />, { route: '/login' })
    await settle()
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('stays silent for an https manifest', async () => {
    mountTree(<SiteTransportWarning loadManifest={() => Promise.resolve(manifestBody('https'))} />, { route: '/login' })
    await settle()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Subscribe in browser')
  })
})
