// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { EXIT_DURATION_FAST_MS, EXIT_DURATION_MS, canAnimateExit, useExitAnimation } from './useExitAnimation'

/**
 * The closing state existed but its TIMER branch was unreachable under vitest:
 * `canAnimateExit()` returned false whenever MODE === 'test', so the JS duration
 * and its CSS token could only be compared as text, and the timer-driven unmount
 * was never exercised. `animate` is injectable now, which makes these tests cover
 * the same path production runs.
 */
let lastState: { mounted: boolean; closing: boolean } | null = null

function Probe({ open, durationMs, animate }: {
  open: boolean; durationMs: number; animate: boolean
}): React.ReactElement {
  const state = useExitAnimation(open, durationMs, animate)
  lastState = state
  return <div data-testid="probe" data-mounted={state.mounted} data-closing={state.closing} />
}

function state(): { mounted: boolean; closing: boolean } {
  const node = document.querySelector('[data-testid="probe"]')
  return { mounted: node?.getAttribute('data-mounted') === 'true',
    closing: node?.getAttribute('data-closing') === 'true' }
}

const view = { open: true, durationMs: EXIT_DURATION_MS, animate: true }

function mount(overrides: Partial<typeof view> = {}): void {
  Object.assign(view, { open: true, durationMs: EXIT_DURATION_MS, animate: true }, overrides)
  lastState = null
  mountTree(<Probe open={view.open} durationMs={view.durationMs} animate={view.animate} />)
}

function setOpen(open: boolean): void {
  view.open = open
  act(() => {
    // Re-render the same tree with the new prop.
    mountTree(<Probe open={open} durationMs={view.durationMs} animate={view.animate} />)
  })
}

describe('useExitAnimation', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); cleanup() })

  it('keeps the element mounted for the duration, then unmounts it', () => {
    mount()
    expect(state()).toEqual({ mounted: true, closing: false })

    setOpen(false)
    // Closing and still mounted: the CSS animation has a frame to play in.
    expect(state()).toEqual({ mounted: true, closing: true })

    act(() => { vi.advanceTimersByTime(EXIT_DURATION_MS - 1) })
    expect(state().mounted).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(state()).toEqual({ mounted: false, closing: false })
  })

  it('honours the fast tier independently of the state tier', () => {
    mount({ durationMs: EXIT_DURATION_FAST_MS })
    setOpen(false)
    act(() => { vi.advanceTimersByTime(EXIT_DURATION_FAST_MS) })
    expect(state().mounted).toBe(false)
  })

  it('unmounts immediately when animation is declined', () => {
    mount({ animate: false })
    setOpen(false)
    // No closing frame at all, and no timer to wait for.
    expect(state()).toEqual({ mounted: false, closing: false })
  })

  it('cancels the timer when the element reopens mid-exit', () => {
    mount()
    setOpen(false)
    expect(state().closing).toBe(true)
    setOpen(true)
    expect(state()).toEqual({ mounted: true, closing: false })
    // The abandoned timer must not close a reopened element.
    act(() => { vi.advanceTimersByTime(EXIT_DURATION_MS * 2) })
    expect(state().mounted).toBe(true)
  })

  it('leaves the default behaviour unchanged when no override is given', () => {
    // In the test environment the default is still "do not animate", which the
    // rest of the suite relies on.
    expect(canAnimateExit()).toBe(false)
    expect(canAnimateExit(true)).toBe(true)
  })
})
