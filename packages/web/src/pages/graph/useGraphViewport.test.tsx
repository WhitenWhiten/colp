// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraphViewport } from './useGraphViewport'
import { cleanup, mountTree } from '../../test/render'

/**
 * Viewport gesture contract: bare wheel is page scroll (zoom needs a
 * modifier — ctrl/meta is also how trackpads report pinch), and a pointer
 * only becomes a pan past a threshold so taps never shift the canvas.
 */

const probe = { zoom: 1, pan: { x: 0, y: 0 } }

function Probe() {
  const viewport = useGraphViewport(true)
  probe.zoom = viewport.zoom
  probe.pan = viewport.pan
  return (
    <div data-testid="viewport-canvas" ref={viewport.canvasRef}>
      <svg><g className="graph-node" data-testid="viewport-node" /></svg>
    </div>
  )
}

function canvas(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="viewport-canvas"]')
  if (!el) throw new Error('canvas not rendered')
  return el
}

function wheel(init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  /* happy-dom's WheelEvent ignores modifier keys from the init dict. */
  if (init.ctrlKey) Object.defineProperty(event, 'ctrlKey', { value: true })
  if (init.metaKey) Object.defineProperty(event, 'metaKey', { value: true })
  act(() => { canvas().dispatchEvent(event) })
  return event
}

function pointer(type: string, init: PointerEventInit & { target?: Element }): void {
  const target = init.target ?? canvas()
  act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      ...init,
    }))
  })
}

describe('useGraphViewport', () => {
  beforeEach(() => {
    probe.zoom = 1
    probe.pan = { x: 0, y: 0 }
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mountTree(<Probe />)
    const el = canvas()
    /* happy-dom has no pointer capture or layout — stub both. A 720×520
       rect makes the canvas scale exactly 1 so pan deltas are raw pixels. */
    el.setPointerCapture = vi.fn()
    el.releasePointerCapture = vi.fn()
    el.hasPointerCapture = () => false
    el.getBoundingClientRect = () => ({
      width: 720, height: 520, top: 0, left: 0, right: 720, bottom: 520, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lets a bare wheel fall through to page scroll', () => {
    const event = wheel({ deltaY: 120 })
    expect(event.defaultPrevented).toBe(false)
    expect(probe.zoom).toBe(1)
  })

  it('zooms only on a modifier wheel (ctrl/meta covers trackpad pinch)', () => {
    const event = wheel({ deltaY: 120, ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(probe.zoom).toBe(0.92)
    wheel({ deltaY: -120, metaKey: true })
    expect(probe.zoom).toBe(1)
  })

  it('ignores a sub-threshold wiggle, then pans once past it', () => {
    pointer('pointerdown', { clientX: 100, clientY: 100, pointerType: 'mouse' })
    pointer('pointermove', { clientX: 103, clientY: 102, pointerType: 'mouse' })
    expect(probe.pan).toEqual({ x: 0, y: 0 })
    pointer('pointermove', { clientX: 115, clientY: 100, pointerType: 'mouse' })
    expect(probe.pan).toEqual({ x: 15, y: 0 })
  })

  it('releases a vertical-dominant touch to the browser scroll', () => {
    pointer('pointerdown', { clientX: 100, clientY: 100, pointerType: 'touch' })
    pointer('pointermove', { clientX: 102, clientY: 112, pointerType: 'touch' })
    expect(probe.pan).toEqual({ x: 0, y: 0 })
    /* The gesture is dead — a later move must not start panning. */
    pointer('pointermove', { clientX: 130, clientY: 100, pointerType: 'touch' })
    expect(probe.pan).toEqual({ x: 0, y: 0 })
  })

  it('pans on a horizontal-dominant touch past the threshold', () => {
    pointer('pointerdown', { clientX: 100, clientY: 100, pointerType: 'touch' })
    pointer('pointermove', { clientX: 115, clientY: 102, pointerType: 'touch' })
    expect(probe.pan).toEqual({ x: 15, y: 2 })
  })

  it('never starts a pan from a node press', () => {
    const node = document.querySelector('[data-testid="viewport-node"]')!
    pointer('pointerdown', { clientX: 100, clientY: 100, pointerType: 'mouse', target: node })
    pointer('pointermove', { clientX: 140, clientY: 140, pointerType: 'mouse' })
    expect(probe.pan).toEqual({ x: 0, y: 0 })
  })
})
