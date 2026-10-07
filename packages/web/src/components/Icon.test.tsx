// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ICON_NAMES, Icon, LibraryNavMark, ReadMarkGlyph, SaveMarkGlyph } from './Icon'
import { cleanup, mountTree } from '../test/render'

describe('Icon', () => {

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

  it('renders every glyph as a decorative 24px stroke svg', () => {
    render(
      <div>
        {ICON_NAMES.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </div>,
    )
    const svgs = [...document.querySelectorAll<SVGSVGElement>('svg[data-icon]')]
    expect(svgs).toHaveLength(ICON_NAMES.length)
    for (const svg of svgs) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('focusable')).toBe('false')
      expect(svg.getAttribute('stroke')).toBe('currentColor')
      expect(svg.getAttribute('fill')).toBe('none')
      expect(ICON_NAMES).toContain(svg.getAttribute('data-icon'))
      expect(svg.childElementCount).toBeGreaterThan(0)
    }
  })

  it('forwards className onto the svg', () => {
    render(<Icon name="search" className="desk-search-icon" />)
    expect(document.querySelector('svg[data-icon="search"]')?.classList.contains('desk-search-icon')).toBe(true)
  })

  it('keeps CSS hooks on the read and save mark glyphs', () => {
    render(
      <>
        <ReadMarkGlyph />
        <SaveMarkGlyph />
      </>,
    )
    const readMark = document.querySelector('[data-testid="read-mark"]')!
    expect(readMark.querySelector('circle')).not.toBeNull()
    expect(readMark.querySelector('path')).not.toBeNull()
    expect(document.querySelector('[data-testid="save-mark"] path')).not.toBeNull()
  })

  it('renders filled glyphs with data-fill so stroke chrome cannot hollow them', () => {
    render(
      <>
        <Icon name="play" />
        <Icon name="github" />
        <Icon name="sparkle" />
        <Icon name="star" />
        <Icon name="heart" />
        <Icon name="star-open" />
      </>,
    )
    expect(document.querySelector('[data-icon="play"] [data-fill]')).not.toBeNull()
    expect(document.querySelector('[data-icon="github"] [data-fill]')).not.toBeNull()
    expect(document.querySelector('[data-icon="sparkle"] [data-fill]')).toBeNull()
    expect(document.querySelector('[data-icon="star"] [data-fill]')).not.toBeNull()
    expect(document.querySelector('[data-icon="heart"] [data-fill]')).not.toBeNull()
    expect(document.querySelector('[data-icon="star-open"] [data-fill]')).toBeNull()
  })

  it('renders the library nav mark on the shared 24px canvas', () => {
    render(<LibraryNavMark />)
    const svg = document.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })
})
