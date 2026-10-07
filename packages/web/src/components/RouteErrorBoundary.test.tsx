// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteErrorBoundary } from './RouteErrorBoundary'
import { cleanup, mountTree } from '../test/render'

let shouldThrow = true
let thrown: Error = new Error('boom')

function Boom() {
  if (shouldThrow) throw thrown
  return <p>recovered</p>
}

describe('RouteErrorBoundary', () => {

  beforeEach(() => {
    shouldThrow = true
    thrown = new Error('boom')
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reports the error and retries the failed tree', () => {
    mountTree(
        <RouteErrorBoundary resetKey="/broken">
          <Boom />
        </RouteErrorBoundary>,
      )

    expect(document.body.textContent).toContain('Something went wrong loading this page.')
    expect(document.body.textContent).toContain('Unsaved edits on this page may be gone.')
    expect(vi.mocked(console.error).mock.calls.some((call) => call[0] === '[known:route-error]')).toBe(true)

    shouldThrow = false
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Try again')!.click()
    })
    expect(document.body.textContent).toContain('recovered')
  })

  it('clears the error when resetKey changes', () => {
    mountTree(
        <RouteErrorBoundary resetKey="/broken">
          <Boom />
        </RouteErrorBoundary>,
      )
    expect(document.body.textContent).toContain('Something went wrong loading this page.')

    shouldThrow = false
    mountTree(
        <RouteErrorBoundary resetKey="/other">
          <Boom />
        </RouteErrorBoundary>,
      )
    expect(document.body.textContent).toContain('recovered')
  })

  it('offers a reload, not a retry, when the route chunk failed to load', () => {
    thrown = new TypeError('Failed to fetch dynamically imported module: https://know-n.com/assets/Explore-abc.js')
    mountTree(
        <RouteErrorBoundary resetKey="/explore">
          <Boom />
        </RouteErrorBoundary>,
      )

    expect(document.body.textContent).toContain("Couldn't load this page.")
    expect(document.body.textContent).not.toContain('Unsaved edits')
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['Reload page'])
  })
})
