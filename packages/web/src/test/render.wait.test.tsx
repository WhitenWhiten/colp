// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForDom } from './render'

describe('waitForDom', () => {
  afterEach(() => { vi.useRealTimers() })

  it('waits for macrotask work instead of exhausting a microtask-only loop', async () => {
    let ready = false
    setTimeout(() => { ready = true }, 20)

    const started = performance.now()
    await waitForDom(() => ready, 250)

    expect(performance.now() - started).toBeGreaterThanOrEqual(10)
  })

  it('honors its wall-clock timeout when the predicate never settles', async () => {
    const started = performance.now()

    await expect(waitForDom(() => false, 25)).rejects.toThrow('timed out after 25ms')

    expect(performance.now() - started).toBeGreaterThanOrEqual(20)
  })

  it('remains bounded when an application suite uses fake timers', async () => {
    vi.useFakeTimers()

    await expect(waitForDom(() => false, 20)).rejects.toThrow('timed out after 20ms')
  })
})
