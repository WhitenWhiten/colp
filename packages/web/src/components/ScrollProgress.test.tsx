// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScrollProgress } from './ScrollProgress'
import { cleanup, mountTree } from '../test/render'

function progressVar() {
  return document.querySelector<HTMLElement>('[data-testid="scroll-progress"]')!.style.getPropertyValue('--progress')
}

function Driver() {
  const navigate = useNavigate()
  return (
    <>
      <ScrollProgress />
      <button type="button" onClick={() => navigate('/')}>
        Home
      </button>
    </>
  )
}

describe('ScrollProgress', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1000 })
  })

  afterEach(() => {
    cleanup()
  })

  it('drops leftover progress as soon as the pathname changes', () => {
    document.documentElement.scrollTop = 400

    mountTree(
        <MemoryRouter initialEntries={['/explore']}>
          <Driver />
        </MemoryRouter>,
      )
    expect(progressVar()).toBe('0.4')

    document.documentElement.scrollTop = 0
    act(() => {
      document.querySelector('button')!.click()
    })
    expect(progressVar()).toBe('0')
  })
})
