// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CollectionTransportNotice, SubscribeInBrowserButton, TransportBanner } from './TransportBanner'
import { cleanup, mountTree } from '../test/render'

function manifestBody(transport: string): unknown {
  return { features: { transport } }
}

describe('transport banner', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows the insecure-http warning and hides Subscribe in browser', async () => {
    const loadManifest = () => Promise.resolve(manifestBody('insecure-http'))
    mountTree(<><CollectionTransportNotice loadManifest={loadManifest} /><SubscribeInBrowserButton /></>)
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Credentials and bookmarks travel unencrypted')
    expect(document.querySelector('[data-testid="transport-banner"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Subscribe in browser')
  })

  it('renders nothing for an https manifest', async () => {
    const loadManifest = () => Promise.resolve(manifestBody('https'))
    mountTree(<><CollectionTransportNotice loadManifest={loadManifest} /><SubscribeInBrowserButton /></>)
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Subscribe in browser')
  })

  it('renders nothing when the transport prop is https or absent', () => {
    mountTree(<TransportBanner transport="https" />)
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
    cleanup()
    mountTree(<TransportBanner transport={undefined} />)
    expect(document.querySelector('[data-testid="transport-banner"]')).toBeNull()
  })
})
