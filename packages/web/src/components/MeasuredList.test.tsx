// @vitest-environment happy-dom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeasuredList } from './MeasuredList'
import { cleanup, mountTree } from '../test/render'

/**
 * `MeasuredList` positions rows from real measurements instead of
 * `index * itemHeight`. It exists because the comfort list is a flex column of
 * auto-height rows, so the fixed-height `VirtualList` cannot lay it out.
 *
 * happy-dom reports zero-sized boxes, so these tests stub the two things the
 * component reads — `getBoundingClientRect` on a row and the container's
 * `clientHeight` — rather than pretending a layout engine exists.
 */
const ROWS = 200

/**
 * A BROWSER-FAITHFUL stub.
 *
 * `.virtual-list-item` sets `height: var(--vl-item-h)` and
 * `.virtual-list-item--measured` sets `height: auto`. The component learns a row's
 * height by reading that same node's rect, so a stub that returns a constant
 * cannot tell the two apart — and an earlier version of this file did exactly
 * that, which is why it passed while every row was frozen at the estimate.
 *
 * This stub returns what the cascade would: the imposed custom property for a
 * plain item, and the real content height for a measured one.
 */
function stubLayout(contentHeight: number, viewport: number): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ): DOMRect {
    const measured = this.classList.contains('virtual-list-item--measured')
    const imposed = this.style.getPropertyValue('--vl-item-h')
    const height = measured ? contentHeight
      : Number((imposed || '0px').replace('px', '')) || 0
    return { height, width: 400, top: 0, left: 0, right: 400, bottom: height,
      x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get: () => viewport,
  })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('MeasuredList', () => {
  it('mounts a window rather than every row', () => {
    stubLayout(72, 600)
    mountTree(<MeasuredList items={Array.from({ length: ROWS }, (_, i) => i)}
      estimatedItemHeight={72} testId="measured"
      renderItem={(item) => <div data-row={item}>row {item}</div>} />)
    const mounted = document.querySelectorAll('[data-row]').length
    // 600px viewport / 72px rows is ~9 visible, plus overscan on both sides.
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(ROWS)
    expect(mounted).toBeLessThan(40)
  })

  it('reserves the full scroll height, not just the mounted rows', () => {
    stubLayout(72, 600)
    mountTree(<MeasuredList items={Array.from({ length: ROWS }, (_, i) => i)}
      estimatedItemHeight={72} testId="measured"
      renderItem={(item) => <div data-row={item}>row {item}</div>} />)
    const spacer = document.querySelector<HTMLElement>('[data-testid="virtual-list-spacer"]')
    // Without a spacer sized to ALL rows the list cannot scroll to its end.
    expect(spacer?.style.getPropertyValue('--vl-total')).toBe(`${ROWS * 72}px`)
  })

  it('lays mounted rows out from their measured height, not the estimate', async () => {
    // Rows measure 144 against an estimate of 72. The first window is placed from
    // the estimate, and once those rows report their height the reserved total and
    // every subsequent offset must follow the MEASUREMENT — with an estimate of 72
    // the total would stay at 14_400 and row 1 would start at 72.
    stubLayout(144, 600)
    mountTree(<MeasuredList items={Array.from({ length: ROWS }, (_, i) => i)}
      estimatedItemHeight={72} testId="measured"
      renderItem={(item) => <div data-row={item}>row {item}</div>} />)

    const total = () => Number((document.querySelector<HTMLElement>('[data-testid="virtual-list-spacer"]')
      ?.style.getPropertyValue('--vl-total') ?? '0px').replace('px', ''))
    // The measured estimate propagates to the rows that have not been mounted, so
    // the reserved height converges on every row being 144 tall.
    await vi.waitFor(() => { expect(total()).toBe(ROWS * 144) })

    const firstRow = document.querySelector<HTMLElement>('[role="listitem"]')
    expect(firstRow?.style.getPropertyValue('--vl-top')).toBe('0px')
    const rows = [...document.querySelectorAll<HTMLElement>('[role="listitem"]')]
    const second = rows[1]
    if (second) {
      // Row 1 sits after row 0's MEASURED height (144), not after the estimate.
      expect(second.style.getPropertyValue('--vl-top')).toBe('144px')
    }
  })

  it('remeasures wrapping rows when only width changes and when row content grows', () => {
    stubLayout(50, 600)
    let notify!: () => void
    const observed = new Set<Element>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback }
      observe(node: Element) { observed.add(node) }
      unobserve(node: Element) { observed.delete(node) }
      disconnect() { observed.clear() }
    })
    let width = 800
    let height = 50
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true, get: () => width,
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
      ({ height } as DOMRect))
    mountTree(<MeasuredList items={Array.from({ length: ROWS }, (_, i) => i)}
      estimatedItemHeight={50} renderItem={(item) => <div>{item}</div>} />)
    const secondOffset = () => document.querySelectorAll<HTMLElement>('[role="listitem"]')[1]!
      .style.getPropertyValue('--vl-top')
    expect(secondOffset()).toBe('50px')
    expect(observed.has(document.querySelector('[role="listitem"]')!)).toBe(true)
    act(() => { width = 220; height = 140; notify() })
    expect(secondOffset()).toBe('140px')
    act(() => { height = 180; notify() })
    expect(secondOffset()).toBe('180px')
    cleanup()
    expect(observed.size).toBe(0)
  })

  it('lets a measured row decide its own height in the stylesheet', () => {
    /* happy-dom has no cascade, so `stubLayout` above MODELS what the stylesheet
       does for the two wrapper classes: `.virtual-list-item` imposes
       `--vl-item-h` and `.virtual-list-item--measured` overrides it with `auto`.
       A model cannot fail, so the rule it models is asserted here — deleting it
       left every test in this file green while the component would measure the
       estimate it had just imposed and freeze every row at 72px. */
    const css = readFileSync(resolve(import.meta.dirname, '../styles/page-layouts.css'), 'utf8')
    const measured = /\.virtual-list-item--measured\s*\{([^}]*)\}/u.exec(css)
    expect(measured).not.toBeNull()
    expect(measured![1]).toMatch(/height:\s*auto/u)
    // `height: var(--vl-item-h)` here would re-impose the estimate.
    expect(measured![1]).not.toMatch(/height:\s*var\(/u)
  })

  it('keeps the documented role and test id on the scroll container', () => {
    stubLayout(72, 600)
    mountTree(<MeasuredList items={[1, 2, 3]} estimatedItemHeight={72} testId="measured"
      renderItem={(item) => <div>{item}</div>} />)
    const list = document.querySelector('[data-testid="measured"]')
    expect(list?.getAttribute('role')).toBe('list')
  })
})
