// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DensitySwitch } from '../components/DensitySwitch'
import { setUiDensity, useUiDensity } from './useUiDensity'
import { cleanup, mountTree } from '../test/render'

function Probe() {
  const [density] = useUiDensity()
  return <span data-testid="density">{density}</span>
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

  it('updates every subscriber as soon as Comfort or Compact is pressed', () => {
    mountTree(
        <>
          <DensitySwitch />
          <Probe />
        </>,
      )
    expect(document.querySelector('[data-testid="density"]')?.textContent).toBe('comfortable')
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-checked="false"]')?.click()
    })
    expect(document.querySelector('[data-testid="density"]')?.textContent).toBe('compact')
    expect(document.querySelector('button[aria-checked="true"]')?.textContent).toBe('Compact')
    act(() => {
      document.querySelectorAll('button').item(0).click()
    })
    expect(document.querySelector('[data-testid="density"]')?.textContent).toBe('comfortable')
  })
})
