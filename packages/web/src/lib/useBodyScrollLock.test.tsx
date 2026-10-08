// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useBodyScrollLock } from './useBodyScrollLock'
import { cleanup, mountTree } from '../test/render'

function Probe({ locked }: { locked: boolean }) {
  useBodyScrollLock(locked)
  return null
}

describe('useBodyScrollLock', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    document.documentElement.style.overflow = ''
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.documentElement.style.overflow = ''
  })

  /* The viewport scrolls the root element (global.css: html overflow-y:auto),
     so the lock must land on documentElement — body never propagates. */
  it('locks overflow while open and restores the previous value', () => {
    document.documentElement.style.overflow = 'auto'
    mountTree(<Probe locked />)
    expect(document.documentElement.style.overflow).toBe('hidden')
    mountTree(<Probe locked={false} />)
    expect(document.documentElement.style.overflow).toBe('auto')
  })

  it('keeps the lock until the last overlapping caller unlocks', () => {
    function Pair({ a, b }: { a: boolean; b: boolean }) {
      useBodyScrollLock(a)
      useBodyScrollLock(b)
      return null
    }
    mountTree(<Pair a b />)
    expect(document.documentElement.style.overflow).toBe('hidden')
    mountTree(<Pair a b={false} />)
    expect(document.documentElement.style.overflow).toBe('hidden')
    mountTree(<Pair a={false} b={false} />)
    expect(document.documentElement.style.overflow).toBe('')
  })
})
