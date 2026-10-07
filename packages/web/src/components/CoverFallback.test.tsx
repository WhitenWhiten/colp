// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { CoverFallback, CoverImage } from './CoverFallback'

describe('CoverFallback', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders a deterministic monogram from the title', () => {
    mountTree(<CoverFallback title="Dune" />)
    const mark = document.querySelector('[data-testid="cover-fallback"]')
    expect(mark?.textContent).toBe('D')
    expect(mark?.className).toMatch(/cover-fallback--[abc]/)
  })

  it('falls back when the image is missing or errors', () => {
    mountTree(<CoverImage title="Dune" />)
    expect(document.querySelector('[data-testid="cover-fallback"]')?.textContent).toBe('D')

    cleanup()
    mountTree(<CoverImage src="https://example.test/cover.jpg" title="Dune" className="book-cover" />)
    const img = document.querySelector('img.book-cover')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('decoding')).toBe('async')
    act(() => {
      img?.dispatchEvent(new Event('error'))
    })
    expect(document.querySelector('[data-testid="cover-fallback"]')?.classList.contains('book-cover')).toBe(true)
  })
})
