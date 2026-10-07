// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnchoredMenu } from './useAnchoredMenu'
import { cleanup, mountTree } from '../test/render'

/** Harness: a trigger button plus the menu div the hook manages. */
function Harness() {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menu = useAnchoredMenu({ exemptRefs: [triggerRef] })
  return (
    <div>
      <button
        type="button"
        ref={triggerRef}
        data-testid="trigger"
        onClick={(e) => menu.openAt(e.clientX, e.clientY, { width: 200, height: 100 })}
      >
        Open
      </button>
      {menu.pos && (
        <div ref={menu.menuRef} data-testid="menu" role="menu" data-x={menu.pos.x} data-y={menu.pos.y}>
          <button type="button" role="menuitemradio" data-testid="item-1">
            first
          </button>
          <button type="button" role="menuitemradio" data-testid="item-2">
            second
          </button>
          <button type="button" role="menuitem" data-testid="item-3">
            third
          </button>
        </div>
      )}
      <button type="button" data-testid="close" onClick={menu.close}>
        Close
      </button>
    </div>
  )
}

/** Harness for trigger-anchored dropdowns (openAnchored): the panel follows
   a live trigger rect instead of a pointer point. */
function AnchorHarness() {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menu = useAnchoredMenu({ exemptRefs: [triggerRef] })
  return (
    <div>
      <button
        type="button"
        ref={triggerRef}
        data-testid="anchor-trigger"
        onClick={() => menu.openAnchored(
          () => triggerRef.current?.getBoundingClientRect() ?? null,
          { width: 200, align: 'end' },
        )}
      >
        Open
      </button>
      {menu.anchorPos && (
        <div ref={menu.menuRef} data-testid="menu" role="menu" data-left={menu.anchorPos.left}>
          <button type="button" role="menuitem" data-testid="item-1">
            first
          </button>
          <button type="button" role="menuitem" data-testid="item-2">
            second
          </button>
        </div>
      )}
    </div>
  )
}

describe('useAnchoredMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ''
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  function openMenuAt(x: number, y: number) {
    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLButtonElement
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
    })
  }

  it('clamps the menu position inside the viewport', () => {
    mountTree(<Harness />)
    openMenuAt(window.innerWidth - 10, window.innerHeight - 10)
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    expect(menu).not.toBeNull()
    expect(Number(menu.dataset.x)).toBeLessThanOrEqual(window.innerWidth - 200 - 8)
    expect(Number(menu.dataset.y)).toBeLessThanOrEqual(window.innerHeight - 100 - 8)
    expect(Number(menu.dataset.x)).toBeGreaterThanOrEqual(8)
  })

  it('closes on outside pointerdown, but not on menu or exempt-trigger clicks', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()

    // The opening tick has not elapsed: an early pointerdown must not close yet.
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()

    act(() => vi.runOnlyPendingTimers())

    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    act(() => {
      menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()

    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLButtonElement
    act(() => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()

    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
  })

  it('closes on Escape and on resize', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    act(() => vi.runOnlyPendingTimers())
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()

    openMenuAt(100, 100)
    act(() => vi.runOnlyPendingTimers())
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
  })

  it('close() resets state and reopens cleanly', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    act(() => vi.runOnlyPendingTimers())
    act(() => {
      ;(document.querySelector('[data-testid="close"]') as HTMLButtonElement).click()
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
    openMenuAt(50, 50)
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    expect(menu.dataset.x).toBe('50')
  })

  it('focuses the first menu item on open and roams with arrow keys', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    const first = document.querySelector('[data-testid="item-1"]') as HTMLElement
    expect(document.activeElement).toBe(first)

    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(document.querySelector('[data-testid="item-2"]'))

    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(document.querySelector('[data-testid="item-3"]'))

    // wraps around
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(first)

    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(document.activeElement).toBe(document.querySelector('[data-testid="item-3"]'))

    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(document.activeElement).toBe(first)
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(document.activeElement).toBe(document.querySelector('[data-testid="item-3"]'))
  })

  it('closes on Tab and continues past the trigger, never onto <body> (R15-35)', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => {
      menu.dispatchEvent(tab)
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
    expect(tab.defaultPrevented).toBe(true)
    // The next control after the trigger, skipping the closing menu's items.
    expect(document.activeElement).toBe(document.querySelector('[data-testid="close"]'))
  })

  it('returns focus to the trigger on Shift+Tab (R15-35)', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    const menu = document.querySelector('[data-testid="menu"]') as HTMLElement
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="trigger"]'))
  })

  it('anchor mode tracks the trigger on scroll/resize instead of closing', () => {
    mountTree(<AnchorHarness />)
    const trigger = document.querySelector('[data-testid="anchor-trigger"]') as HTMLButtonElement
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()
    act(() => vi.runOnlyPendingTimers())

    // Point menus close on resize; an anchored dropdown repositions — the
    // trigger is still in view and the panel must keep tracking it.
    act(() => {
      window.dispatchEvent(new Event('scroll', { bubbles: true }))
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-testid="menu"]')).not.toBeNull()

    // Escape still closes and returns focus to the invoking trigger.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the trigger on Escape', () => {
    mountTree(<Harness />)
    openMenuAt(100, 100)
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).toBe(document.querySelector('[data-testid="item-1"]'))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[data-testid="menu"]')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="trigger"]'))
  })
})
