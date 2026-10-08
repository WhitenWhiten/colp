// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollectionTransportNotice, SubscribeInBrowserButton, TransportBanner } from './TransportBanner'
import { cleanup, mountTree } from '../test/render'

function manifestResponse(transport: string): Response {
  return new Response(JSON.stringify({ features: { transport } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('transport banner', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('shows the insecure-http warning and hides Subscribe in browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => manifestResponse('insecure-http')))
    mountTree(<><CollectionTransportNotice /><SubscribeInBrowserButton /></>)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Credentials and bookmarks travel unencrypted')
    expect(document.querySelector('[data-testid="transport-banner"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Subscribe in browser')
  })

  it('renders nothing for an https manifest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => manifestResponse('https')))
    mountTree(<><CollectionTransportNotice /><SubscribeInBrowserButton /></>)
    await act(async () => {
      await Promise.resolve()
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
