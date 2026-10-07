// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VirtualList } from './VirtualList'
import { renderWithRouter } from '../test/render'

const items = Array.from({ length: 100 }, (_, index) => `row-${index}`)

describe('VirtualList', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the fallback viewport and moves the overscan window on scroll', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    renderWithRouter(
      <VirtualList items={items} itemHeight={100} overscan={1}
        renderItem={(item, index) => <span>{index}:{item}</span>} />,
    )

    const list = document.querySelector<HTMLElement>('[role="list"]')!
    const spacer = list.firstElementChild as HTMLElement
    expect(spacer.style.getPropertyValue('--vl-total')).toBe('10000px')
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(7)
    expect(document.body.textContent).toContain('0:row-0')
    expect(document.body.textContent).not.toContain('7:row-7')

    act(() => {
      list.scrollTop = 500
      list.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(8)
    expect(document.body.textContent).toContain('4:row-4')
    expect(document.body.textContent).toContain('11:row-11')
    expect(document.body.textContent).not.toContain('3:row-3')
  })

  it('uses ResizeObserver height and disconnects it on unmount', () => {
    const disconnect = vi.fn()
    const observe = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(250)
    vi.stubGlobal('ResizeObserver', class {
      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const view = renderWithRouter(
      <VirtualList items={items} itemHeight={100} overscan={0} className="fixture-list"
        renderItem={(item) => item} />,
    )

    expect(document.querySelector('[role="list"]')?.classList.contains('fixture-list')).toBe(true)
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(3)
    // StrictMode double-invokes mount effects, so the observer is created and
    // torn down twice. The guarantee is the pairing — nothing is left observed
    // after unmount — not a single invocation.
    // StrictMode double-invokes mount effects: the observer is created, torn
    // down, created again, and disconnected on unmount. The guarantee is that
    // every observe is paired with a disconnect — nothing is left watching a
    // detached node — not a single invocation.
    expect(observe.mock.calls.length).toBeGreaterThan(0)
    view.unmount()
    expect(disconnect.mock.calls.length).toBe(observe.mock.calls.length)
  })
})
