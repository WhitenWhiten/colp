// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useFocusWhen } from './useFocusWhen'
import { cleanup, mountTree } from '../test/render'

function Harness() {
  const [otp, setOtp] = useState(false)
  useFocusWhen(otp, 'otp-field')
  return (
    <div>
      <input id="start" />
      {otp && <input id="otp-field" />}
      <button type="button" onClick={() => setOtp(true)}>show</button>
    </div>
  )
}

describe('useFocusWhen', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => cleanup())

  it('focuses the field when it appears, not on the first mount', () => {
    mountTree(<Harness />)
    expect(document.activeElement?.id).not.toBe('otp-field')
    act(() => {
      document.querySelector('button')!.click()
    })
    expect(document.activeElement?.id).toBe('otp-field')
  })
})
