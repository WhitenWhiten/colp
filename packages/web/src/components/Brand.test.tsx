// @vitest-environment happy-dom
/* Brand lockup boundary.
 *
 * Behaviour — what the chrome actually paints: one <img> pointing at the
 * public assets (empty alt, decorative), the v2 vector wordmark and
 * the home link. Driven by rendering the real components.
 *
 * Architecture — two claims a render cannot reach: (a) the shared asset
 * itself must stay a transparent mark rather than a tiled icon, and the browser
 * paints /favicon.svg while happy-dom neither fetches nor rasterises it, so no
 * DOM assertion can see a tile; (b) the component module must not carry a
 * dormant second drawing of the mark — an inline <svg> in a branch no test
 * renders changes no frame, so its absence is asserted on the element rather
 * than on a formatted source substring.
 */
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brand, BrandMark } from './Brand'
import brandSource from './Brand.tsx?raw'
import faviconSource from '../../public/favicon.svg?raw'
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

  function render(node: React.ReactNode) {
    mountTree(node)
  }

  describe('Brand rendering behaviour', () => {
    it('renders the shared favicon file instead of an inlined copy', () => {
      render(<BrandMark className="brand-name-mark" />)
      const img = document.querySelector('img.brand-mark')
      expect(img).not.toBeNull()
      expect(img?.getAttribute('src')).toBe('/favicon.svg')
      expect(img?.getAttribute('alt')).toBe('')
      expect(img?.getAttribute('aria-hidden')).toBe('true')
      expect(img?.getAttribute('draggable')).toBe('false')
      expect(img?.classList.contains('brand-name-mark')).toBe(true)
      /* The mark the reader sees is the shared file and nothing else: no
         second, inline drawing is painted anywhere in the tree. */
      expect(document.querySelector('svg')).toBeNull()
    })

    it('renders the v2 wordmark and home link', () => {
      render(
        <MemoryRouter>
          <Brand />
        </MemoryRouter>,
      )
      // R15-39: the wordmark image carries the name; no aria-label on a span.
      expect(document.querySelector('img[alt="Know-N"]')?.getAttribute('src')).toBe('/brand-wordmark.svg')
      expect(document.querySelector('span[aria-label]')).toBeNull()
      expect(document.querySelector('a[aria-label="Know-N home"]')?.getAttribute('href')).toBe('/')
      expect(document.querySelector('a[aria-label="Know-N home"] img')?.getAttribute('src')).toBe('/brand-wordmark.svg')
    })

    it('points a custom to target at the requested route', () => {
      /* Chrome surfaces pass `to` (e.g. an embed back to its host page); the
         destination is a rendered attribute, not an implementation detail. */
      render(
        <MemoryRouter>
          <Brand to="/demos" />
        </MemoryRouter>,
      )
      expect(document.querySelector('a[aria-label="Know-N home"]')?.getAttribute('href')).toBe('/demos')
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps the shared favicon a transparent mark rather than a tiled icon', () => {
      /* The browser paints /favicon.svg; happy-dom never fetches or rasterises
         it, so a tile, a border or an opaque background would be invisible to
         every render assertion above. The asset's contract is its markup, so
         this is asserted structurally (element + attribute name) instead of by
         formatting-sensitive substrings. */
      expect(faviconSource).toContain('<svg')
      expect(faviconSource).toMatch(/viewBox=["']0 0 32 32["']/u)
      const rects = [...faviconSource.matchAll(/<rect\b[^>]*>/gu)].map(([tag]) => tag)
      for (const rect of rects) {
        expect(rect, rect).not.toMatch(/\bwidth=["'](?:32|100%)["']/u)
        expect(rect, rect).not.toMatch(/\bheight=["'](?:32|100%)["']/u)
      }
      expect(faviconSource).not.toMatch(/\bid=["']tile["']/u)
      expect(faviconSource).not.toMatch(/\bstroke=["']#06070a["']/u)
    })

    it('keeps a second drawing of the mark out of the component module', () => {
      /* Rendering already proves the live branch uses the shared file (Brand
         rendering behaviour). A dormant inline <svg> branch would paint
         nothing, so its absence has to be asserted on the module. The positive
         anchor first: an empty or unread source would pass every absence check. */
      expect(brandSource).toContain('/favicon.svg')
      expect(brandSource).not.toMatch(/<svg[\s/>]/u)
    })
  })
})
