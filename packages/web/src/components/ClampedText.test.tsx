// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClampedText } from './ClampedText'
import { cleanup, mountTree } from '../test/render'

/**
 * ClampedText contract: the expand toggle only renders when the clamped
 * element actually truncates (scrollHeight > clientHeight); while expanded
 * the wrapper carries data-expanded and measuring is skipped so the toggle
 * cannot collapse itself.
 */
describe('ClampedText', () => {
  let scrollHeight: PropertyDescriptor | undefined
  let clientHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  })

  afterEach(() => {
    cleanup()
    restore('scrollHeight', scrollHeight)
    restore('clientHeight', clientHeight)
    document.body.innerHTML = ''
  })

  function restore(key: 'scrollHeight' | 'clientHeight', original: PropertyDescriptor | undefined) {
    if (original) Object.defineProperty(HTMLElement.prototype, key, original)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  }

  function mockHeights(scroll: number, client: number) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scroll })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => client })
  }

  function render(node: React.ReactNode) {
    mountTree(node)
  }

  it('renders the full text without a toggle when nothing truncates', () => {
    mockHeights(0, 0)
    render(<ClampedText text="Short summary" className="lede" wrapperClassName="wrap" toggleClassName="toggle" />)
    expect(document.querySelector('[data-testid="clamped-text"] p')?.textContent).toBe('Short summary')
    expect(document.querySelector('button[aria-expanded]')).toBeNull()
    expect(document.querySelector('[data-testid="clamped-text"]')?.getAttribute('data-expanded')).toBeNull()
  })

  it('reveals a toggle when truncated and expands/collapses on click', () => {
    mockHeights(120, 40)
    render(<ClampedText text="A very long summary" className="lede" wrapperClassName="wrap" toggleClassName="toggle" />)
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.textContent).toBe('Show more')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    act(() => toggle.click())
    const wrap = document.querySelector('[data-testid="clamped-text"]')!
    expect(wrap.getAttribute('data-expanded')).toBe('true')
    expect(toggle.textContent).toBe('Show less')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Full text stays in the DOM in both states.
    expect(document.querySelector('[data-testid="clamped-text"] p')?.textContent).toBe('A very long summary')

    act(() => toggle.click())
    expect(wrap.getAttribute('data-expanded')).toBeNull()
    expect(toggle.textContent).toBe('Show more')
  })

  it('supports custom toggle labels', () => {
    mockHeights(120, 40)
    render(<ClampedText text="Long" className="lede" toggleClassName="toggle" moreLabel="Show full title" />)
    expect(document.querySelector('button[aria-expanded]')?.textContent).toBe('Show full title')
  })
})
