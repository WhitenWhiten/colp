// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setUiDensity, useUiDensity } from './useUiDensity'
import { cleanup, mountTree } from '../test/render'

function Probe({ id }: { id: string }) {
  const [density] = useUiDensity()
  return <span data-testid={id}>{density}</span>
}

describe('useUiDensity', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    setUiDensity('comfortable')
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    setUiDensity('comfortable')
  })

  it('updates every subscriber as soon as the density changes', () => {
    mountTree(
        <>
          <Probe id="first" />
          <Probe id="second" />
        </>,
      )
    const read = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent
    expect([read('first'), read('second')]).toEqual(['comfortable', 'comfortable'])
    act(() => setUiDensity('compact'))
    expect([read('first'), read('second')]).toEqual(['compact', 'compact'])
    act(() => setUiDensity('comfortable'))
    expect([read('first'), read('second')]).toEqual(['comfortable', 'comfortable'])
  })
})
