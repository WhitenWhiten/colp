// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeServerStatus, readServerAbout, SelfHostedAbout } from './SelfHostedAbout'
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
      { status: 'ok', version: { server: '0.1.0', colp: '0.1.1', protocols: ['0.1', '0.2'] } },
      { mounts: [{ features: { edition: { name: 'colp-server', version: '0.1.0' } } }] },
    )
    expect(snapshot).toEqual({ server: '0.1.0', colp: '0.1.1', protocols: '0.1 0.2', status: 'ok' })
    mountTree(<MemoryRouter><SelfHostedAbout snapshot={snapshot} origin="https://colp.example" /></MemoryRouter>)
    expect(document.querySelector('[data-testid="about-server"]')?.textContent).toBe('0.1.0')
    expect(document.querySelector('[data-testid="about-colp"]')?.textContent).toBe('0.1.1')
    expect(document.querySelector('[data-testid="about-protocols"]')?.textContent).toBe('0.1 0.2')
    expect(document.body.textContent).toContain('@know-n/colp')
    expect(document.body.textContent).toContain('powered by Know-N')
    expect(document.querySelector('a[href="/CHANGELOG.md"]')).not.toBeNull()
    expect(document.querySelector('a[href="/INSTALL.md"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="about-origin"]')?.textContent).toBe('https://colp.example')
    expect(document.querySelector('[data-testid="about-status"]')?.textContent).toBe('Healthy')
    expect(document.title).toBe('About — COLP Server')
    const next = document.querySelector('[aria-label="Set up"]')
    expect([...next!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/extension', '/agents', '/import', '/sync'])
  })

  it('reads the transport from the Manifest and reports it with the health status (US-25)', () => {
    const snapshot = readServerAbout(
      { status: 'ok', version: { server: '0.1.0', colp: '0.1.2', protocols: ['0.1'] } },
      { features: { transport: 'insecure-http' } },
    )
    expect(snapshot?.transport).toBe('insecure-http')
    expect(describeServerStatus(snapshot)).toBe('Healthy · plain HTTP')
    expect(describeServerStatus({ server: '0.1.0', colp: '0.1.2', protocols: '', status: 'degraded', transport: 'https' })).toBe('Reported "degraded" · HTTPS')
    expect(describeServerStatus(null)).toBe('Could not read /health')
  })

  it('does not throw when health has no version', () => {
    expect(readServerAbout(null)).toBeNull()
    mountTree(<MemoryRouter><SelfHostedAbout snapshot={null} origin="https://colp.example" /></MemoryRouter>)
    expect(document.querySelector('[data-testid="about-server"]')?.textContent).toBe('unavailable')
    expect(document.querySelector('[data-testid="about-protocols"]')?.textContent).toBe('unavailable')
    expect(document.querySelector('[data-testid="about-status"]')?.textContent).toBe('Could not read /health')
    expect(document.body.textContent).toContain('powered by Know-N')
  })
})
