// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFound } from './NotFound'
import { cleanup, mountTree } from '../test/render'
import { canonicalHref, installPageMetaBaseline, robotsContents } from '../test/pageMeta'

function renderAt(path: string) {
  installPageMetaBaseline()
  mountTree(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </MemoryRouter>,
  )
}

/* The parallax effect only arms under `(pointer: fine)` and no reduced
   motion; happy-dom reports neither, so tests that exercise it stub the
   two queries the component actually asks. */
function stubFinePointer() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: fine)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('NotFound', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('frames the stage with 404 / Page / Not / Found in the corners', () => {
    renderAt('/no/such/page')
    const corners = [...document.querySelectorAll('[data-testid="not-found-corner"]')].map((node) => node.textContent)
    expect(corners).toEqual(['404', 'Page', 'Not', 'Found'])
    expect(document.querySelector('[data-testid="not-found-page"]')).not.toBeNull()
  })

  it('sets three giant serif digits as decorative poster type', () => {
    renderAt('/no/such/page')
    const digits = document.querySelector('[data-testid="not-found-digits"]')!
    expect(digits.getAttribute('aria-hidden')).toBe('true')
    expect([...digits.querySelectorAll('[data-testid="not-found-digit"]')].map((node) => node.textContent)).toEqual(['4', '0', '4'])
  })

  it('keeps one sentence and two exits — Home and Explore', () => {
    renderAt('/no/such/page')
    expect(document.querySelector('h1')?.textContent).toBe('This page isn’t here.')
    expect(document.querySelector('[data-testid="not-found-path"]')?.textContent).toBe('/no/such/page')
    const exits = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="not-found-exit"]')]
      .map((anchor) => [anchor.textContent, anchor.getAttribute('href')])
    expect(exits).toEqual([
      ['Back home', '/'],
      ['Explore', '/explore'],
    ])
    // The two text links are the only anchors on the page.
    expect(document.querySelectorAll('a')).toHaveLength(2)
    expect(document.title).toBe('Page not found — Know-N')
    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('eases the digits toward the pointer through --nf-x/--nf-y', async () => {
    stubFinePointer()
    renderAt('/missing')
    const stage = document.querySelector<HTMLElement>('[data-testid="not-found-page"]')!
    const rect = { left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }
    stage.getBoundingClientRect = () => rect as DOMRect

    act(() => {
      stage.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 750, clientY: 200 }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })

    const x = Number.parseFloat(stage.style.getPropertyValue('--nf-x'))
    const y = Number.parseFloat(stage.style.getPropertyValue('--nf-y'))
    expect(Number.isFinite(x)).toBe(true)
    expect(Number.isFinite(y)).toBe(true)
    // Target is (0.5, -0.5); the lerp only closes part of the distance.
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThanOrEqual(0.5)
    expect(y).toBeLessThan(0)
    expect(y).toBeGreaterThanOrEqual(-0.5)
  })

  it('never arms the parallax under reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))
    renderAt('/missing')
    const stage = document.querySelector<HTMLElement>('[data-testid="not-found-page"]')!
    act(() => {
      stage.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 750, clientY: 200 }))
    })
    expect(stage.style.getPropertyValue('--nf-x')).toBe('')
  })
})
