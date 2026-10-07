// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { anchorPopover } from './anchorPopover'

function rect(partial: Partial<DOMRect>): DOMRect {
  const x = partial.x ?? partial.left ?? 0
  const y = partial.y ?? partial.top ?? 0
  const width = partial.width ?? 40
  const height = partial.height ?? 24
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {
      return this
    },
  }
}

describe('anchorPopover', () => {
  const original = { innerWidth: window.innerWidth, innerHeight: window.innerHeight }

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.innerWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.innerHeight })
  })

  function viewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  }

  it('opens below the trigger when there is room', () => {
    viewport(1280, 800)
    const pos = anchorPopover(rect({ left: 100, top: 80, width: 48, height: 28 }), { width: 260 })
    expect(pos.openUp).toBe(false)
    expect(pos.top).toBe(80 + 28 + 6)
    expect(pos.left).toBe(100)
    expect(pos.width).toBe(260)
    expect(pos.maxHeight).toBeLessThanOrEqual(800 - (80 + 28) - 10 - 6)
  })

  it('opens above when the trigger sits near the bottom', () => {
    viewport(1280, 800)
    const pos = anchorPopover(rect({ left: 200, top: 720, width: 32, height: 24 }), { width: 260 })
    expect(pos.openUp).toBe(true)
    expect(pos.top).toBe('auto')
    expect(pos.bottom).toBeGreaterThan(0)
    expect(pos.maxHeight).toBeLessThanOrEqual(720 - 10 - 6)
  })

  it('never reports a maxHeight larger than the remaining viewport', () => {
    viewport(390, 400)
    const pos = anchorPopover(rect({ left: 16, top: 300, width: 64, height: 28 }), {
      width: 320,
      maxHeight: 380,
    })
    expect(pos.maxHeight).toBeLessThanOrEqual(400)
    expect(pos.maxHeight).toBeGreaterThan(0)
  })

  it('clamps horizontally and can align to the trigger end', () => {
    viewport(400, 700)
    const pos = anchorPopover(rect({ left: 360, top: 40, width: 32, height: 24 }), {
      width: 260,
      align: 'end',
    })
    expect(pos.left + pos.width).toBeLessThanOrEqual(400 - 10)
    expect(pos.left).toBeGreaterThanOrEqual(10)
  })
})
