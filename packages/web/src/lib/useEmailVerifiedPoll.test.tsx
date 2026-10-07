// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { useEmailVerifiedPoll, VERIFIED_POLL_GIVE_UP_MS } from './useEmailVerifiedPoll'

/* R15-15: over ten minutes the check-your-email poll makes 0 calls after
   verification, 0 while hidden and about 25 at most while visible. */

let state: ReturnType<typeof useEmailVerifiedPoll> | null = null

function Probe({ read }: { read: () => Promise<boolean> }) {
  state = useEmailVerifiedPoll(true, read)
  return null
}

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('useEmailVerifiedPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    state = null
  })

  it('backs off while visible and gives up after ten minutes', async () => {
    const read = vi.fn(async () => false)
    mountTree(<Probe read={read} />)
    await advance(VERIFIED_POLL_GIVE_UP_MS + 60_000)
    // StrictMode mounts twice; allow its extra first read.
    expect(read.mock.calls.length).toBeGreaterThan(10)
    expect(read.mock.calls.length).toBeLessThanOrEqual(27)
    expect(state?.gaveUp).toBe(true)
    const calls = read.mock.calls.length
    await advance(10 * 60_000)
    expect(read.mock.calls.length).toBe(calls)

    act(() => state?.checkAgain())
    await advance(0)
    expect(read.mock.calls.length).toBe(calls + 1)
  })

  it('makes no calls while hidden and checks once on return', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    const read = vi.fn(async () => false)
    mountTree(<Probe read={read} />)
    await advance(VERIFIED_POLL_GIVE_UP_MS)
    expect(read).not.toHaveBeenCalled()
    setVisibility('visible')
    await advance(0)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('stops as soon as the email is verified', async () => {
    const read = vi.fn(async () => true)
    mountTree(<Probe read={read} />)
    await advance(0)
    expect(state?.verified).toBe(true)
    const calls = read.mock.calls.length
    await advance(VERIFIED_POLL_GIVE_UP_MS)
    expect(read.mock.calls.length).toBe(calls)
  })

  it('never overlaps requests', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const read = vi.fn(() => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<boolean>((resolve) => setTimeout(() => { inFlight -= 1; resolve(false) }, 20_000))
    })
    mountTree(<Probe read={read} />)
    await advance(120_000)
    expect(maxInFlight).toBeLessThanOrEqual(2) // StrictMode's discarded first mount
  })
})
