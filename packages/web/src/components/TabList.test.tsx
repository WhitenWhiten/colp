// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabList } from './TabList'
import { cleanup, mountTree } from '../test/render'

describe('TabList', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function Probe() {
    const [selected, setSelected] = useState<'password' | 'otp'>('password')
    return (
      <>
        <TabList
          label="Sign-in method"
          className="view-switch auth-tabs"
          tabClassName="auth-tab"
          value={selected}
          options={[
            { id: 'password', label: 'Password' },
            { id: 'otp', label: 'Email code' },
          ]}
          tabIdFor={(id) => `login-tab-${id}`}
          panelIdFor={(id) => `login-panel-${id}`}
          onChange={setSelected}
        />
        <div id="login-panel-password" role="tabpanel" aria-labelledby="login-tab-password" hidden={selected !== 'password'}>
          Password panel
        </div>
        <div id="login-panel-otp" role="tabpanel" aria-labelledby="login-tab-otp" hidden={selected !== 'otp'}>
          Code panel
        </div>
      </>
    )
  }

  function tabs() {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  }

  it('wires aria-controls and keeps a single tab in the tab order', () => {
    mountTree(<Probe />)
    const [password, otp] = tabs()
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Sign-in method')
    expect(password?.id).toBe('login-tab-password')
    expect(password?.getAttribute('aria-controls')).toBe('login-panel-password')
    expect(password?.getAttribute('aria-selected')).toBe('true')
    expect(password?.tabIndex).toBe(0)
    expect(otp?.getAttribute('aria-controls')).toBe('login-panel-otp')
    expect(otp?.getAttribute('aria-selected')).toBe('false')
    expect(otp?.tabIndex).toBe(-1)
  })

  it('moves selection with arrow, Home, and End keys', () => {
    mountTree(<Probe />)
    const [password, otp] = tabs()
    password!.focus()
    act(() => {
      password!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    expect(document.getElementById('login-panel-otp')?.hidden).toBe(false)

    act(() => {
      otp!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')

    act(() => {
      tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    })
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true')

    act(() => {
      tabs()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    })
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true')
  })
})
