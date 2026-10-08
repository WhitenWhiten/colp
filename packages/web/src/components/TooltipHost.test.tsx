// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { placeTooltip, TooltipHost } from './TooltipHost'
import { cleanup, mountTree } from '../test/render'

/**
 * TooltipHost contract: while a titled element is hovered its title moves
 * into the shared bubble (so the OS tooltip never shows) and comes back on
 * leave; the text stays reachable — as aria-label on an icon-only element,
 * as the bubble's description otherwise. A click keeps it quiet until the
 * pointer leaves.
 */
function Harness() {
  return (
    <div>
      <TooltipHost />
      <button type="button" title="Open the reader view" data-testid="text">
        <span data-testid="inner">Read</span>
      </button>
      <button type="button" title="Delete" data-testid="icon"><svg /></button>
      <p data-testid="outside">Elsewhere</p>
    </div>
  )
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`)!
const tooltip = () => document.querySelector('[role="tooltip"]')!

function pointer(type: string, target: Element, relatedTarget: Element | null = null) {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', relatedTarget }))
  })
}

afterEach(() => cleanup())

describe('placeTooltip', () => {
  const anchor = { top: 200, bottom: 230, left: 100, width: 60 }

  it('centres the bubble above the anchor', () => {
    expect(placeTooltip(anchor, { width: 80, height: 24 }, 1000)).toEqual({ left: 90, top: 170, below: false })
  })

  it('drops below when the top edge is too close', () => {
    expect(placeTooltip({ ...anchor, top: 10, bottom: 40 }, { width: 80, height: 24 }, 1000)).toEqual({ left: 90, top: 46, below: true })
  })

  it('stays inside the viewport sides', () => {
    expect(placeTooltip({ ...anchor, left: 0, width: 20 }, { width: 120, height: 24 }, 1000).left).toBe(8)
    expect(placeTooltip({ ...anchor, left: 980, width: 20 }, { width: 120, height: 24 }, 1000).left).toBe(872)
  })
})

describe('TooltipHost', () => {
  it('holds the title while hovered and puts it back on leave', () => {
    mountTree(<Harness />)
    const button = byTestId('text')
    pointer('pointerover', byTestId('inner'))
    expect(button.hasAttribute('title')).toBe(false)
    expect(tooltip().textContent).toBe('Open the reader view')
    expect(button.getAttribute('aria-describedby')).toBe(tooltip().id)

    // Moving within the element keeps it held.
    pointer('pointerover', button)
    expect(button.hasAttribute('title')).toBe(false)

    pointer('pointerout', button, byTestId('outside'))
    expect(button.getAttribute('title')).toBe('Open the reader view')
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  })

  it('names an icon-only element with the title while it is held', () => {
    mountTree(<Harness />)
    const button = byTestId('icon')
    pointer('pointerover', button)
    expect(button.getAttribute('aria-label')).toBe('Delete')
    expect(button.hasAttribute('aria-describedby')).toBe(false)

    pointer('pointerout', button, byTestId('outside'))
    expect(button.hasAttribute('aria-label')).toBe(false)
    expect(button.getAttribute('title')).toBe('Delete')
  })

  it('stays quiet after a click until the pointer leaves', () => {
    mountTree(<Harness />)
    const button = byTestId('text')
    pointer('pointerover', button)
    pointer('pointerdown', button)
    expect(button.getAttribute('title')).toBe('Open the reader view')

    pointer('pointerover', byTestId('inner'))
    expect(button.getAttribute('title')).toBe('Open the reader view')

    pointer('pointerover', byTestId('outside'))
    pointer('pointerover', button)
    expect(button.hasAttribute('title')).toBe(false)
  })

  it('ignores touch pointers', () => {
    mountTree(<Harness />)
    const button = byTestId('text')
    act(() => {
      button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }))
    })
    expect(button.getAttribute('title')).toBe('Open the reader view')
  })

  /* R15-45: WCAG 1.4.13 — hoverable, persistent, dismissable without side effects. */
  describe('content on hover or focus (1.4.13)', () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
    })

    function showFor(target: Element) {
      pointer('pointerover', target)
      act(() => {
        vi.advanceTimersByTime(500)
      })
    }

    it('keeps the bubble when the pointer moves onto it', () => {
      vi.useFakeTimers()
      mountTree(<Harness />)
      const button = byTestId('text')
      showFor(button)
      pointer('pointerout', button, tooltip())
      pointer('pointerover', tooltip())
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(button.hasAttribute('title')).toBe(false)
      expect(tooltip().textContent).toBe('Open the reader view')

      // Leaving the bubble for elsewhere closes it after the grace period.
      pointer('pointerout', tooltip(), byTestId('outside'))
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(button.getAttribute('title')).toBe('Open the reader view')
    })

    it('keeps a keyboard-focus bubble when the pointer passes over something else', () => {
      vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':focus-visible' ? true : Element.prototype.closest.call(this, selector) === this
      })
      mountTree(<Harness />)
      const button = byTestId('text') as HTMLButtonElement
      act(() => button.focus())
      expect(tooltip().textContent).toBe('Open the reader view')
      pointer('pointerover', byTestId('icon'))
      pointer('pointerout', button, byTestId('outside'))
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(button.hasAttribute('title')).toBe(false)
      expect(byTestId('icon').getAttribute('title')).toBe('Delete')
    })

    it('Escape closes only the bubble, never the dialog underneath', () => {
      vi.useFakeTimers()
      const modalEscape = vi.fn()
      document.addEventListener('keydown', modalEscape)
      try {
        mountTree(<Harness />)
        const button = byTestId('text')
        showFor(button)
        act(() => {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(button.getAttribute('title')).toBe('Open the reader view')
        expect(modalEscape).not.toHaveBeenCalled()

        // With no bubble showing, Escape reaches the dialog as usual.
        act(() => {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(modalEscape).toHaveBeenCalledTimes(1)
      } finally {
        document.removeEventListener('keydown', modalEscape)
      }
    })

    it('follows a title that changes while held', () => {
      vi.useFakeTimers()
      function ToggleRead() {
        const [read, setRead] = useState(false)
        return (
          <div>
            <TooltipHost />
            <button type="button" data-testid="toggle" title={read ? 'Mark as unread' : 'Mark as read'} onClick={() => setRead((v) => !v)}>
              <svg />
            </button>
          </div>
        )
      }
      mountTree(<ToggleRead />)
      const button = byTestId('toggle') as HTMLButtonElement
      showFor(button)
      expect(tooltip().textContent).toBe('Mark as read')
      act(() => {
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        button.click()
      })
      // MutationObserver callbacks run as microtasks.
      act(() => {
        vi.advanceTimersByTime(0)
      })
      return Promise.resolve().then(() => {
        expect(tooltip().textContent).toBe('Mark as unread')
        expect(button.getAttribute('aria-label')).toBe('Mark as unread')
        expect(button.hasAttribute('title')).toBe(false)
      })
    })
  })
})
