// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'
import { cleanup, mountTree } from '../test/render'

/**
 * C02 Modal contract: Esc / backdrop click / focus trap / focus restore on
 * close / semantic size + tone modifiers. Focus trap uses rAF, so focus
 * assertions run after flushing pending timers.
 */
describe('Modal', () => {
  let onClose: ReturnType<typeof vi.fn>
  let trigger: HTMLButtonElement

  beforeEach(() => {
    vi.useFakeTimers()
    onClose = vi.fn()
    document.body.innerHTML = '<button id="trigger">Open market</button><div id="root"></div>'
    trigger = document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function render(props: Partial<Parameters<typeof Modal>[0]> = {}) {
    const { children = <button type="button">Add module</button>, ...rest } = props
    mountTree(
        <Modal open label="Add board module" title="Add to your board" onClose={onClose} {...rest}>
          {children}
        </Modal>,
      )
    return document.querySelector('[role="dialog"]')!
  }

  it('renders the owner-controlled header with title and close button', () => {
    const dialog = render()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Add board module')
    const heading = dialog.querySelector<HTMLElement>('h2')
    expect(heading?.textContent).toBe('Add to your board')
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading?.id)
    expect(dialog.querySelector('[aria-label="Close dialog"] svg')).not.toBeNull()
    expect(dialog.textContent).toContain('Add module')
  })

  it('falls back to aria-label when no title is rendered (labelledby would mask it)', () => {
    const dialog = render({ title: undefined })
    expect(dialog.getAttribute('aria-labelledby')).toBeNull()
    expect(dialog.getAttribute('aria-label')).toBe('Add board module')
  })

  it('falls back to aria-label when the title is an empty string', () => {
    const dialog = render({ title: '' })
    expect(dialog.getAttribute('aria-labelledby')).toBeNull()
    expect(dialog.getAttribute('aria-label')).toBe('Add board module')
  })

  it('closes on Escape', () => {
    render()
    expect(onClose).not.toHaveBeenCalled()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click but not on clicks inside the panel', () => {
    render()
    const overlay = document.querySelector('[role="dialog"]')!
    const panel = document.querySelector('[data-testid="modal-panel"]')!
    act(() => panel.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
    act(() => overlay.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the panel on open and traps Tab cycling', () => {
    render()
    act(() => vi.runOnlyPendingTimers())
    const close = document.querySelector('[aria-label="Close dialog"]') as HTMLButtonElement
    expect(document.activeElement).toBe(close)
    const add = document.querySelectorAll<HTMLButtonElement>('[data-testid="modal-body"] button')[0]!
    add.focus()
    act(() => add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(close)
    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
    expect(document.activeElement).toBe(add)
  })

  it('restores focus to the previously focused element when closed', () => {
    render()
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Close dialog"]'))
    mountTree(
        <Modal open={false} label="Add board module" title="Add to your board" onClose={onClose}>
          <button type="button">Add module</button>
        </Modal>,
      )
    expect(document.activeElement).toBe(trigger)
  })

  it('applies semantic size and tone modifiers to the panel', () => {
    render({ size: 'lg', tone: 'danger' })
    const panel = document.querySelector('[data-testid="modal-panel"]')!
    expect(panel.classList.contains('modal-panel--lg')).toBe(true)
    expect(panel.classList.contains('modal-panel--danger')).toBe(true)
    expect(panel.classList.contains('modal-panel--md')).toBe(false)
  })

  it('focuses the first non-destructive action for danger tone', () => {
    render({
      tone: 'danger',
      children: (
        <div className="empty-state-actions">
          <button type="button" className="btn btn-secondary">Cancel</button>
          <button type="button" className="btn btn-danger">Delete</button>
        </div>
      ),
    })
    act(() => vi.runOnlyPendingTimers())
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="modal-body"] button')]
      .find((b) => b.textContent === 'Cancel')!
    expect(document.activeElement).toBe(cancel)
  })

  it('focuses the explicit initialFocus target when provided', () => {
    render({
      initialFocus: '[data-initial-focus]',
      children: (
        <div>
          <button type="button">First</button>
          <button type="button" data-initial-focus>Target</button>
        </div>
      ),
    })
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement?.textContent).toBe('Target')
  })

  it('omits modifier classes for default size and tone', () => {
    render()
    const panel = document.querySelector('[data-testid="modal-panel"]')!
    expect(panel.classList.contains('modal-panel--sm')).toBe(false)
    expect(panel.classList.contains('modal-panel--lg')).toBe(false)
    expect(panel.classList.contains('modal-panel--danger')).toBe(false)
  })

  it('bare chrome uses the overlay as the dialog without header chrome', () => {
    render({
      chrome: 'bare',
      overlayClassName: 'search-overlay',
      children: <div className="search-palette"><button type="button">Go</button></div>,
    })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.classList.contains('search-overlay')).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.querySelector('header')).toBeNull()
    expect(dialog.classList.contains('modal-overlay')).toBe(false)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('bare chrome closes on backdrop click but not on clicks inside the panel', () => {
    render({
      chrome: 'bare',
      overlayClassName: 'search-overlay',
      children: <div className="search-palette"><button type="button">Go</button></div>,
    })
    const overlay = document.querySelector('[role="dialog"]')!
    const panel = document.querySelector('[role="dialog"] > div')!
    act(() => panel.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
    act(() => overlay.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('inline chrome omits the overlay and does not lock document scroll', () => {
    document.documentElement.style.overflow = 'scroll'
    render({ chrome: 'inline', panelClassName: 'save-folder-picker' })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.classList.contains('save-folder-picker')).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBeNull()
    expect(dialog.classList.contains('modal-overlay')).toBe(false)
    expect(document.documentElement.style.overflow).toBe('scroll')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks the default chrome panel with data-chrome="default"', () => {
    render()
    expect(document.querySelector('[data-testid="modal-panel"]')?.getAttribute('data-chrome')).toBe('default')
  })

  it('marks the sheet chrome panel with data-chrome="sheet"', () => {
    render({ chrome: 'sheet' })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('data-chrome')).toBe('sheet')
    expect(document.querySelector('[data-chrome="default"]')).toBeNull()
  })

  it('inline chrome does not put data-chrome="default" on a modal-panel', () => {
    render({ chrome: 'inline', panelClassName: 'save-folder-picker' })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('data-chrome')).toBe('inline')
    expect(document.querySelector('[data-testid="modal-panel"]')).toBeNull()
    expect(document.querySelector('[data-chrome="default"]')).toBeNull()
  })

  describe('mobile default-chrome sheet dismiss', () => {
    const DESKTOP_WIDTH = 1024
    const PHONE_WIDTH = 390

    beforeEach(() => {
      setViewportWidth(PHONE_WIDTH)
    })

    afterEach(() => {
      setViewportWidth(DESKTOP_WIDTH)
    })

    it('closes when the grabber/header is dragged down past the threshold', () => {
      render()
      const header = document.querySelector('[data-testid="modal-panel"] header')!
      swipe(header, 12, 120)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does not close when the grabber/header drag stays below the threshold', () => {
      render()
      const header = document.querySelector('[data-testid="modal-panel"] header')!
      swipe(header, 12, 40)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('does not close when the drag starts on the body or a body button', () => {
      render()
      const body = document.querySelector('[data-testid="modal-body"]')!
      const button = body.querySelector('button')!
      swipe(body, 12, 200)
      swipe(button, 12, 200)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('does not swipe-dismiss outside the mobile sheet geometry', () => {
      setViewportWidth(DESKTOP_WIDTH)
      render()
      const header = document.querySelector('[data-testid="modal-panel"] header')!
      swipe(header, 12, 200)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('does not swipe-dismiss sheet chrome', () => {
      render({ chrome: 'sheet', children: <button type="button">Save node</button> })
      const dialog = document.querySelector('[role="dialog"]')!
      swipe(dialog, 12, 200)
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})

function setViewportWidth(width: number) {
  const api = (window as unknown as { happyDOM?: { setInnerWidth: (n: number) => void } }).happyDOM
  api?.setInnerWidth(width)
}

function firePointer(el: EventTarget, type: 'pointerdown' | 'pointermove' | 'pointerup', clientY: number) {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY,
    }))
  })
}

function swipe(el: EventTarget, fromY: number, toY: number) {
  firePointer(el, 'pointerdown', fromY)
  firePointer(el, 'pointermove', toY)
  firePointer(el, 'pointerup', toY)
}
