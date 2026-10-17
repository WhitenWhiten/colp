// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Extension } from './Extension'
import { cleanup, mountTree } from '../test/render'

describe('Extension install page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('walks through connecting the extension to this server and syncing the library', () => {
    mountTree(<MemoryRouter><Extension origin="https://colp.example" /></MemoryRouter>)
    expect(document.body.textContent).toContain('keeps a browser’s bookmarks in sync with your library on this server')
    const setup = document.querySelector('[aria-label="Setup steps"]')
    expect([...setup!.querySelectorAll('h3, strong')].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(['Install', 'Connect this server', 'Sign in', 'Start syncing']),
    )
    expect(setup?.textContent).toContain('Options → Account → Server')
    // Step 02 shows the address to type into the extension, with a Copy button.
    const address = setup?.querySelector('[data-testid="copy-field"]')
    expect(address?.querySelector('[data-testid="copy-field-value"]')?.textContent).toBe('https://colp.example')
    expect(address?.querySelector('button')?.getAttribute('aria-label')).toBe('Copy Server address')
    const permissions = document.querySelector('[aria-label="Permissions"]')
    expect(permissions?.textContent).toContain('Never uploads folders you keep on the browser')
    expect(permissions?.textContent).toContain('Syncs only with your library on this server')
    expect(document.querySelector('a[href="/sync"]')?.textContent).toBe('Open sync center')
    expect(document.querySelector('a[href="/import"]')?.textContent).toBe('Import bookmarks')
    expect(document.querySelector('a[href="/classify"], a[href="/onboarding"]')).toBeNull()
  })

  it('offers the way back to the collection page that sent the reader here', () => {
    mountTree(<MemoryRouter initialEntries={['/extension?return=' + encodeURIComponent('/c/reading?view=list')]}><Extension /></MemoryRouter>)
    expect(document.querySelector('a[href="/c/reading?view=list"]')?.textContent).toBe('Return to source and continue setup')
  })

  it('ignores a return path outside the subscription source pages', () => {
    mountTree(<MemoryRouter initialEntries={['/extension?return=' + encodeURIComponent('//evil.example/c/x')]}><Extension /></MemoryRouter>)
    expect(document.body.textContent).not.toContain('Return to source and continue setup')
  })
})
