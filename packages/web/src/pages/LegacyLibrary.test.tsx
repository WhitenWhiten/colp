// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LegacyLibrary } from './LegacyLibrary'
import { cleanup, mountTree } from '../test/render'

describe('LegacyLibrary', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    window.localStorage.clear()
  })

  it('renders the demo stack inside the shared page shell (C1)', () => {
    mountTree(<MemoryRouter initialEntries={['/demo/library']}><LegacyLibrary /></MemoryRouter>)
    const shell = document.querySelector('#root')?.firstElementChild
    /* PageShell variant="bare": padding shell, no inner track — the
       .library-layout grid owns the width track itself. */
    expect(shell?.className).toBe('page-shell')
    expect(shell?.innerHTML).not.toContain('page-shell-inner')
    expect(shell?.firstElementChild?.className).toBe('library-layout')

    const folders = [...document.querySelectorAll('aside button')].map((b) => b.textContent)
    expect(folders.some((label) => label?.startsWith('All bookmarks'))).toBe(true)
    expect(folders.some((label) => label?.startsWith('Design systems'))).toBe(true)
    expect(document.body.textContent).toContain('Every Layout — Strong layout primitives')
  })

  it('honours ?empty=1 with the capture-path empty state', () => {
    mountTree(<MemoryRouter initialEntries={['/demo/library?empty=1']}><LegacyLibrary /></MemoryRouter>)
    expect(document.body.textContent).toContain('Your library is empty')
    expect(document.body.textContent).not.toContain('Every Layout')
  })
})
