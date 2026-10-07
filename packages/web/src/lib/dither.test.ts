// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { subscribeTokenChange, TOKEN_CHANGE_EVENT } from './dither'

describe('subscribeTokenChange', () => {
  it('fires on the known:tokens-change event and unsubscribes', () => {
    const onChange = vi.fn()
    const stop = subscribeTokenChange(onChange)
    window.dispatchEvent(new Event(TOKEN_CHANGE_EVENT))
    expect(onChange).toHaveBeenCalledTimes(1)
    stop()
    window.dispatchEvent(new Event(TOKEN_CHANGE_EVENT))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
