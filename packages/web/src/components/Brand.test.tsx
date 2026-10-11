// @vitest-environment happy-dom
/* Brand lockup boundary.
 *
 * Behaviour — what the chrome paints: the decorative COLP Server mark
 * (public/colp-mark.svg, empty alt), the visible name and the home link.
 *
 * Architecture — the component module must not carry a dormant second
 * drawing of the mark: an inline <svg> in a branch no test renders changes no
 * frame, so its absence is asserted on the module.
 */
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brand } from './Brand'
import brandSource from './Brand.tsx?raw'
import { cleanup, mountTree } from '../test/render'

describe('Brand', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders the shared mark, the product name and the home link', () => {
    mountTree(
      <MemoryRouter>
        <Brand />
      </MemoryRouter>,
    )
    const link = document.querySelector('a[aria-label="COLP Server home"]')
    expect(link?.getAttribute('href')).toBe('/')
    const img = link?.querySelector('img.brand-glyph')
    expect(img?.getAttribute('src')).toBe('/colp-mark.svg')
    expect(img?.getAttribute('alt')).toBe('')
    expect(img?.getAttribute('aria-hidden')).toBe('true')
    expect(link?.textContent).toBe('COLP Server')
    expect(document.querySelector('svg')).toBeNull()
  })

  it('points a custom to target at the requested route', () => {
    mountTree(
      <MemoryRouter>
        <Brand to="/library" />
      </MemoryRouter>,
    )
    expect(document.querySelector('a[aria-label="COLP Server home"]')?.getAttribute('href')).toBe('/library')
  })

  it('keeps a second drawing of the mark out of the component module', () => {
    expect(brandSource).toContain('/colp-mark.svg')
    expect(brandSource).not.toMatch(/<svg[\s/>]/u)
  })
})
