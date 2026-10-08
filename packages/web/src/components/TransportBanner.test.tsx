// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteTransportBanner, SubscribeInBrowserButton, TransportBanner } from './TransportBanner'
import { cleanup, mountTree } from '../test/render'

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

describe('transport banner', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.stubEnv('VITE_EDITION', 'self-hosted')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows the insecure-http warning and hides Subscribe in browser', async () => {
    const loadManifest = () => Promise.resolve(manifestBody('insecure-http'))
    mountTree(<><SiteTransportBanner loadManifest={loadManifest} /><SubscribeInBrowserButton /></>)
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Credentials and bookmarks travel unencrypted')
    expect(document.querySelector('[data-testid="transport-banner"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Subscribe in browser')
  })

  it('renders nothing for an https manifest', async () => {
    const loadManifest = () => Promise.resolve(manifestBody('https'))
    mountTree(<><SiteTransportBanner loadManifest={loadManifest} /><SubscribeInBrowserButton /></>)
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Subscribe in browser')
  })

  it('renders nothing outside the self-hosted edition', async () => {
    vi.stubEnv('VITE_EDITION', '')
    let calls = 0
    const loadManifest = () => { calls += 1; return Promise.resolve(manifestBody('insecure-http')) }
    mountTree(<SiteTransportBanner loadManifest={loadManifest} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
    expect(calls).toBe(0)
  })

  it('renders nothing when the transport prop is https or absent', () => {
    mountTree(<TransportBanner transport="https" />)
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
    cleanup()
    mountTree(<TransportBanner transport={undefined} />)
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
  })
})
