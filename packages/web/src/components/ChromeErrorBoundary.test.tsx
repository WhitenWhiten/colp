// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChromeErrorBoundary } from './ChromeErrorBoundary'
import { RootErrorBoundary } from './RootErrorBoundary'
import { cleanup, mountTree } from '../test/render'

function Boom(): never {
  throw new Error('boom')
}

describe('chrome and root error boundaries', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('drops failed chrome and keeps the page', () => {
    mountTree(
      <>
        <ChromeErrorBoundary name="TopNav">
          <Boom />
        </ChromeErrorBoundary>
        <p>page content</p>
      </>,
    )
    expect(document.body.textContent).toBe('page content')
  })

  it('shows a provider-free fallback with a reload button when the app fails', () => {
    mountTree(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("couldn't show this page")
    expect(document.querySelector('img')?.getAttribute('alt')).toBe('Know-N')
    expect(document.querySelector('button')?.textContent).toBe('Reload page')
  })
})
