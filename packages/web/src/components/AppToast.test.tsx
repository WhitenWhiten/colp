// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, ToastRouteReset, useToast } from './AppToast'
import { cleanup, findButtonByName, mountTree } from '../test/render'

/**
 * C02 Toast contract: unified icon slot per variant (no ✓/✕ string
 * concatenation), status/alert live regions, auto-dismiss for every variant.
 *
 * Single-slot semantics (revised after the 2026-08 UX walkthrough, where a
 * duration-0 login error followed the user across routes and swallowed every
 * later success message):
 *   - errors auto-dismiss on an 8s reading floor (12s cap, same dwell
 *     mechanism as info/success — the reading-time design intent is kept);
 *   - a fresh error is protected for 2s: arrivals queue behind it (latest
 *     wins) and surface when it clears;
 *   - past the 2s window the error counts as read and the newest toast
 *     replaces it, dropping anything stale in the queue;
 *   - a route change clears the slot and the queue (ToastRouteReset).
 */
function Harness({ onRetry }: { onRetry?: () => void }) {
  const { toast, success, error } = useToast()
  return (
    <div>
      <button type="button" onClick={() => toast('Info message')}>info</button>
      <button type="button" onClick={() => success('Saved')}>success</button>
      <button type="button" onClick={() => error('Failed')}>error</button>
      <button
        type="button"
        onClick={() => error('Failed', { action: { label: 'Retry', onClick: () => onRetry?.() } })}
      >
        error-action
      </button>
    </div>
  )
}

describe('ToastProvider', () => {

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function render(onRetry?: () => void) {
    mountTree(
        <ToastProvider>
          <Harness onRetry={onRetry} />
        </ToastProvider>,
      )
  }

  function click(label: string) {
    act(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!
      button.click()
    })
  }

  function toastEl() {
    return document.querySelector<HTMLElement>('div.toast')!
  }

  function noToast() {
    return document.querySelector('div.toast') === null
  }

  function closeToast() {
    act(() => {
      findButtonByName('Dismiss notification').click()
    })
  }

  it('keeps polite and assertive live regions mounted even when idle', () => {
    render()
    const status = document.querySelector('[role="status"][aria-live="polite"]')
    const alert = document.querySelector('[role="alert"][aria-live="assertive"]')
    expect(status).not.toBeNull()
    expect(alert).not.toBeNull()
    expect(status).not.toBe(alert)
    expect(noToast()).toBe(true)
  })

  it('renders a status live region with the message', () => {
    render()
    click('info')
    expect(toastEl().getAttribute('role')).toBe('status')
    expect(toastEl().getAttribute('aria-live')).toBe('polite')
    expect(toastEl().textContent).toContain('Info message')
  })

  it('dismisses on a downward swipe', () => {
    render()
    click('info')
    expect(toastEl().textContent).toContain('Info message')
    act(() => {
      toastEl().dispatchEvent(new PointerEvent('pointerdown', { clientY: 10, bubbles: true }))
      toastEl().dispatchEvent(new PointerEvent('pointerup', { clientY: 80, bubbles: true }))
    })
    expect(noToast()).toBe(true)
  })

  it.each([
    ['info', 'info'],
    ['success', 'check'],
    ['error', 'alert'],
  ] as const)('uses the %s icon slot for %s toasts (no character concatenation)', (_label, icon) => {
    render()
    click(_label)
    const svg = toastEl().querySelector<SVGSVGElement>('[data-icon]')
    expect(svg?.getAttribute('data-icon')).toBe(icon)
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(toastEl().textContent).not.toContain('✓')
    expect(toastEl().textContent).not.toContain('✕')
  })

  it('applies the semantic variant class per variant', () => {
    render()
    click('success')
    expect(toastEl().classList.contains('toast--success')).toBe(true)
    expect(toastEl().classList.contains('toast--error')).toBe(false)
    act(() => vi.advanceTimersByTime(2000))
    click('error')
    expect(toastEl().classList.contains('toast--error')).toBe(true)
    expect(toastEl().classList.contains('toast--success')).toBe(false)
  })

  it('auto-dismisses info and success on their floors', () => {
    render()
    click('success')
    expect(toastEl().textContent).toContain('Saved')
    act(() => vi.advanceTimersByTime(5999))
    expect(toastEl().textContent).toContain('Saved')
    act(() => vi.advanceTimersByTime(1))
    expect(noToast()).toBe(true)
  })

  /* Errors were duration 0 ("keep until dismissed") — that parked stale
     errors on screen indefinitely. They now share the dwell mechanism with
     the longest floor; the close button still dismisses immediately. */
  it('keeps an error up for its 8s reading floor, then auto-dismisses', () => {
    render()
    click('error')
    expect(toastEl().getAttribute('role')).toBe('alert')
    expect(toastEl().getAttribute('aria-live')).toBe('assertive')
    act(() => vi.advanceTimersByTime(7999))
    expect(toastEl().textContent).toContain('Failed')
    act(() => vi.advanceTimersByTime(1))
    expect(noToast()).toBe(true)

    click('error')
    closeToast()
    expect(noToast()).toBe(true)
  })

  it('caps a long error message at the 12s ceiling', () => {
    const long = `Something went wrong while syncing your library. ${'Please try the operation again in a moment. '.repeat(5)}`
    function LongErrorHarness() {
      const { error } = useToast()
      return <button type="button" onClick={() => error(long)}>long-error</button>
    }
    mountTree(<ToastProvider><LongErrorHarness /></ToastProvider>)
    click('long-error')
    act(() => vi.advanceTimersByTime(11_999))
    expect(toastEl().textContent).toContain('Something went wrong')
    act(() => vi.advanceTimersByTime(1))
    expect(noToast()).toBe(true)
  })

  it('pauses the auto-dismiss timer while hovered or focused', () => {
    render()
    click('success')
    act(() => {
      findButtonByName('Dismiss notification').focus()
      vi.advanceTimersByTime(20_000)
    })
    expect(toastEl().textContent).toContain('Saved')
    act(() => {
      findButtonByName('Dismiss notification').blur()
      vi.advanceTimersByTime(6000)
    })
    expect(noToast()).toBe(true)
  })

  it('gives a long message extra reading time, capped so it still dismisses', () => {
    const long = `We sent a verification code to a-very-long-mailbox-name@example-domain.test. ${'Enter it to finish signing up. '.repeat(6)}`
    function LongHarness() {
      const { success } = useToast()
      return <button type="button" onClick={() => success(long)}>long</button>
    }
    mountTree(<ToastProvider><LongHarness /></ToastProvider>)
    click('long')
    // Well past the 6s success floor the message is still readable...
    act(() => vi.advanceTimersByTime(11_999))
    expect(toastEl().textContent).toContain('a-very-long-mailbox-name@example-domain.test')
    // ...and the 12s cap still clears it.
    act(() => vi.advanceTimersByTime(1))
    expect(noToast()).toBe(true)
  })

  it('runs an error action then dismisses', () => {
    const onRetry = vi.fn()
    render(onRetry)
    click('error-action')
    const action = [...toastEl().querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    expect(action).toBeTruthy()
    act(() => action!.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(noToast()).toBe(true)
  })

  /* Reading protection: the original sticky-error design kept transient
     messages from wiping an error the user had not read yet. That intent is
     preserved as a bounded 2s window instead of "until manually closed". */
  it('queues arrivals behind a fresh error (latest wins) and surfaces the queue on close', () => {
    render()
    click('error')
    click('info')
    click('success')
    expect(toastEl().textContent).toContain('Failed')
    expect(toastEl().getAttribute('role')).toBe('alert')

    closeToast()
    expect(toastEl().textContent).toContain('Saved')
    expect(toastEl().getAttribute('role')).toBe('status')
    act(() => vi.advanceTimersByTime(6000))
    expect(noToast()).toBe(true)
  })

  it('lets a new toast replace an error that has been readable for 2s, dropping the stale queue', () => {
    render()
    click('error')
    click('success')
    expect(toastEl().textContent).toContain('Failed')

    act(() => vi.advanceTimersByTime(2000))
    click('info')
    expect(toastEl().textContent).toContain('Info message')
    expect(toastEl().getAttribute('role')).toBe('status')

    // The queued 'Saved' from inside the protection window is stale now —
    // it must not resurface after the replacing toast dismisses.
    act(() => vi.advanceTimersByTime(5000))
    expect(noToast()).toBe(true)
  })

  it('lets a newer error replace an error once its reading protection has passed', () => {
    render()
    click('error-action')
    expect([...toastEl().querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true)
    act(() => vi.advanceTimersByTime(2000))
    click('error')
    expect(toastEl().textContent).toContain('Failed')
    expect(toastEl().getAttribute('role')).toBe('alert')
    expect([...toastEl().querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(false)
  })

  /* R9-31/R6-17 residual: an action toast (Undo after delete) is the only
     path back — non-error arrivals must queue behind it for its whole dwell
     instead of displacing it. Errors still outrank it. */
  it('queues arrivals behind a visible action toast until it clears', () => {
    function UndoHarness() {
      const { toast, success } = useToast()
      return (
        <div>
          <button
            type="button"
            onClick={() => success('Bookmark deleted', { action: { label: 'Undo', onClick: () => {} } })}
          >
            undo
          </button>
          <button type="button" onClick={() => toast('Copied')}>copied</button>
        </div>
      )
    }
    mountTree(
      <ToastProvider>
        <UndoHarness />
      </ToastProvider>,
    )
    click('undo')
    click('copied')
    // 'Copied' must not wipe the Undo affordance.
    expect(toastEl().textContent).toContain('Bookmark deleted')
    expect([...toastEl().querySelectorAll('button')].some((b) => b.textContent === 'Undo')).toBe(true)

    closeToast()
    // The queued toast surfaces once the action toast clears.
    expect(toastEl().textContent).toContain('Copied')
  })

  it('queues a newer error behind a fresh error until the first one clears', () => {
    render()
    click('error-action')
    act(() => vi.advanceTimersByTime(1000))
    click('error')
    // Still inside the first error's protection window: Retry stays up.
    expect([...toastEl().querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true)
    // The first error carries an action, so its floor is 10s (R7-10);
    // once it elapses the queued error surfaces.
    act(() => vi.advanceTimersByTime(9000))
    expect(toastEl().textContent).toContain('Failed')
    expect([...toastEl().querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(false)
  })

  it('clears the visible toast and the queue when the route changes', () => {
    function RouteHarness() {
      const { error, success } = useToast()
      const navigate = useNavigate()
      return (
        <div>
          <button type="button" onClick={() => error('Incorrect email or password.')}>route-error</button>
          <button type="button" onClick={() => success('Saved')}>route-success</button>
          <button type="button" onClick={() => navigate('/library')}>route-nav</button>
        </div>
      )
    }
    mountTree(
      <MemoryRouter initialEntries={['/login']}>
        <ToastProvider>
          <ToastRouteReset />
          <RouteHarness />
        </ToastProvider>
      </MemoryRouter>,
    )
    click('route-error')
    click('route-success')
    expect(toastEl().textContent).toContain('Incorrect email or password.')
    click('route-nav')
    expect(noToast()).toBe(true)
    act(() => vi.advanceTimersByTime(12_000))
    expect(noToast()).toBe(true)
  })

  it('keeps an action toast (Undo) alive across a route change and extends its dwell (R7-10)', () => {
    const onUndo = vi.fn()
    function UndoHarness() {
      const { success } = useToast()
      const navigate = useNavigate()
      return (
        <div>
          <button
            type="button"
            onClick={() => success('Bookmark deleted', { action: { label: 'Undo', onClick: onUndo } })}
          >
            undo-toast
          </button>
          <button type="button" onClick={() => navigate('/library')}>undo-nav</button>
        </div>
      )
    }
    mountTree(
      <MemoryRouter initialEntries={['/library/f1']}>
        <ToastProvider>
          <ToastRouteReset />
          <UndoHarness />
        </ToastProvider>
      </MemoryRouter>,
    )
    click('undo-toast')
    click('undo-nav')
    // Route reset must not destroy the safety net.
    expect(toastEl().textContent).toContain('Bookmark deleted')
    // The action floor outlasts the plain success dwell (6s → 10s).
    act(() => vi.advanceTimersByTime(9_999))
    const undo = [...toastEl().querySelectorAll('button')].find((b) => b.textContent === 'Undo')
    expect(undo).toBeTruthy()
    act(() => undo!.click())
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(noToast()).toBe(true)
  })

  it('renders a link action ({ label, to }) that navigates and dismisses', () => {
    function MoveHarness() {
      const { success } = useToast()
      return (
        <button
          type="button"
          onClick={() => success('Bookmark moved', { action: { label: 'View', to: '/library/f1' } })}
        >
          move
        </button>
      )
    }
    mountTree(
      <MemoryRouter initialEntries={['/library']}>
        <ToastProvider>
          <MoveHarness />
        </ToastProvider>
      </MemoryRouter>,
    )
    click('move')
    const link = toastEl().querySelector('a')
    expect(link?.textContent).toBe('View')
    expect(link?.getAttribute('href')).toBe('/library/f1')
    act(() => link!.click())
    expect(noToast()).toBe(true)
  })

  it('shows content immediately and still auto-dismisses under reduced motion', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    render()
    click('info')
    expect(toastEl().textContent).toContain('Info message')
    act(() => vi.advanceTimersByTime(5000))
    expect(noToast()).toBe(true)
  })
})
