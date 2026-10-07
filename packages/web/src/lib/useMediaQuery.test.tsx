// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from './useMediaQuery'
import { cleanup, mountTree } from '../test/render'

type Listener = () => void

function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>()
  const mql = {
    matches: initial,
    media: '',
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    dispatchEvent: () => false,
  }
  const fn = vi.fn().mockImplementation((query: string) => {
    mql.media = query
    return mql
  })
  return {
    fn,
    setMatches(next: boolean) {
      mql.matches = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('useMediaQuery', () => {
  let probe = ''

  function Probe({ query }: { query: string }) {
    probe = String(useMediaQuery(query))
    return null
  }

  beforeEach(() => {
    probe = ''
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    // Restore whatever the runner's matchMedia was before each stub.
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  it('reads the query synchronously on mount', () => {
    const media = fakeMatchMedia(true)
    window.matchMedia = media.fn as unknown as typeof window.matchMedia
    mountTree(<Probe query="(max-width: 639px)" />)
    expect(media.fn).toHaveBeenCalledWith('(max-width: 639px)')
    expect(probe).toBe('true')
  })

  it('is false where matchMedia is unavailable (SSR, bare test envs)', () => {
    mountTree(<Probe query="(max-width: 639px)" />)
    expect(probe).toBe('false')
  })

  it('tracks change events so a resized viewport remounts the gated branch', () => {
    const media = fakeMatchMedia(false)
    window.matchMedia = media.fn as unknown as typeof window.matchMedia
    mountTree(<Probe query="(max-width: 639px)" />)
    expect(probe).toBe('false')
    act(() => media.setMatches(true))
    expect(probe).toBe('true')
    act(() => media.setMatches(false))
    expect(probe).toBe('false')
  })
})
