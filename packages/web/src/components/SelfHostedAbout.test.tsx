// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readServerAbout, SelfHostedAbout } from './SelfHostedAbout'
import { cleanup, mountTree } from '../test/render'

describe('self-hosted about', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows server, package, and protocol versions from health and the manifest mount', () => {
    const snapshot = readServerAbout(
      { status: 'ok', version: { server: '0.1.0', colp: '0.1.0', protocols: ['0.1', '0.2'] } },
      { mounts: [{ features: { edition: { name: 'colp-server', version: '0.1.0' } } }] },
    )
    expect(snapshot).toEqual({ server: '0.1.0', colp: '0.1.0', protocols: '0.1 0.2' })
    mountTree(<SelfHostedAbout snapshot={snapshot} />)
    expect(document.body.textContent).toContain('colp-server 0.1.0')
    expect(document.body.textContent).toContain('@know-n/colp 0.1.0')
    expect(document.body.textContent).toContain('protocols 0.1 0.2')
    expect(document.body.textContent).toContain('powered by Know-N')
    expect(document.querySelector('a[href="/CHANGELOG.md"]')).not.toBeNull()
    expect(document.querySelector('a[href="/INSTALL.md"]')).not.toBeNull()
  })

  it('does not throw when health has no version', () => {
    expect(readServerAbout(null)).toBeNull()
    mountTree(<SelfHostedAbout snapshot={null} />)
    expect(document.body.textContent).toContain('colp-server unavailable')
    expect(document.body.textContent).toContain('powered by Know-N')
  })
})
