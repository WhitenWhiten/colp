// @vitest-environment happy-dom
import { act } from 'react'
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

  it('copy-only: says the extension only syncs collections you own', () => {
    mountTree(<MemoryRouter><Extension /></MemoryRouter>)
    expect(document.body.textContent).toContain('Personal sync uses collections you own')
    expect(document.body.textContent).toContain('read-only subscriptions never upload edits to their source')
    expect(document.body.textContent).toContain('Optional: save the page you have open into a collection you own')
    expect(document.body.textContent).toContain('Optional: allow bookmark access so saves can land in a browser folder')
    expect(document.body.textContent).not.toContain('capture the active tab URL')
    expect(document.body.textContent).not.toContain('New links get semantic suggestions')
    const setup = document.querySelector('[aria-label="Setup steps"]')
    expect(setup?.textContent).toContain('Save pages')
    expect(setup?.textContent).toContain('The toolbar popup saves the tab you have open into a collection you own.')
    expect(document.querySelector('a[href="/classify"]')?.textContent).toContain('Classify inbox')
    expect(document.body.textContent).not.toMatch(/Add to Chrome|Chrome Web Store/i)
    expect(document.querySelector('a[href="/onboarding"]')).not.toBeNull()
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
