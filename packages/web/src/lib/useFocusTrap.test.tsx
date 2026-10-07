// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusTrap } from './useFocusTrap'
import { cleanup, mountTree } from '../test/render'

function Trap({ active, hideLast = false, initialFocus }: { active: boolean; hideLast?: boolean; initialFocus?: string }) {
  const ref = useFocusTrap(active, initialFocus)
  return (
    <div ref={ref} data-testid="trap">
      <button type="button">First</button>
      <button type="button" hidden={hideLast} data-initial>Last</button>
    </div>
  )
}

describe('useFocusTrap', () => {
  let trigger: HTMLButtonElement

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<button id="trigger">Open</button><div id="root"></div>'
    trigger = document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function buttons() {
    return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="trap"] button')]
  }

  it('pulls Tab back into the container when focus has escaped', () => {
    mountTree(<Trap active />)
    act(() => vi.runOnlyPendingTimers())
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(buttons()[0])
  })

  it('skips hidden controls when cycling', () => {
    mountTree(<Trap active hideLast />)
    act(() => vi.runOnlyPendingTimers())
    const [first, hidden] = buttons()
    expect(document.activeElement).toBe(first)
    first!.focus()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(first)
    expect(document.activeElement).not.toBe(hidden)
  })

  it('restores the previously focused element when deactivated', () => {
    mountTree(<Trap active />)
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).toBe(buttons()[0])
    mountTree(<Trap active={false} />)
    expect(document.activeElement).toBe(trigger)
  })

  it('moves focus to the initialFocus target instead of the first focusable', () => {
    mountTree(<Trap active initialFocus="[data-initial]" />)
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).toBe(buttons()[1])
  })

  it('falls back to the first focusable when the initialFocus selector matches nothing', () => {
    mountTree(<Trap active initialFocus="[data-missing]" />)
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).toBe(buttons()[0])
  })
})
