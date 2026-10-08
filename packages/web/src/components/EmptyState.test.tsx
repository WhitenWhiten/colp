// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptyState, LoadingState } from './EmptyState'
import { cleanup, mountTree } from '../test/render'

/**
 * C02 EmptyState contract: icon / illustration / loading structures with
 * stable aria, heading level and role semantics.
 */
describe('EmptyState', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  function render(node: React.ReactNode) {
    mountTree(node)
  }

  it('renders the icon state with a decorative svg and a default h3 title', () => {
    render(<EmptyState icon="search" title="Nothing found" description="Try another query." />)
    const state = document.querySelector('[role="status"]')!
    expect(state.getAttribute('role')).toBe('status')
    const iconWrap = document.querySelector('[data-testid="empty-state-icon"]')!
    expect(iconWrap.getAttribute('aria-hidden')).toBe('true')
    const svg = iconWrap.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(document.querySelector('h3')?.textContent).toBe('Nothing found')
    expect(state.textContent).toContain('Try another query.')
  })

  it('announces assertively with role="alert" and supports h1 titles', () => {
    render(<EmptyState role="alert" titleAs="h1" icon="compass" title="Profile unavailable" />)
    expect(document.querySelector('[role="alert"]')?.getAttribute('role')).toBe('alert')
    expect(document.querySelector('h1')?.textContent).toBe('Profile unavailable')
  })

  it('renders the illustration state with three decorative shapes', () => {
    render(<EmptyState illustration="books" title="Your library is empty" />)
    const illustration = document.querySelector('[data-testid="empty-state-illustration"]')!
    expect(illustration.getAttribute('aria-hidden')).toBe('true')
    expect(illustration.querySelectorAll('[data-testid="empty-state-illustration-shape"]')).toHaveLength(3)
    expect(document.querySelector('[data-testid="empty-state-icon"]')).toBeNull()
  })

  it('passes through className for contextual layout', () => {
    render(<EmptyState className="empty-state--board rise" title="Nothing here" />)
    const state = document.querySelector('[role="status"]')!
    expect(state.classList.contains('empty-state--board')).toBe(true)
    expect(state.classList.contains('rise')).toBe(true)
  })

  it('renders the loading state with a status role and decorative dot', () => {
    render(<LoadingState label="Loading notifications…" aria-live="polite" />)
    const loading = document.querySelector('[role="status"]')!
    expect(loading.getAttribute('role')).toBe('status')
    expect(loading.getAttribute('aria-live')).toBe('polite')
    expect(loading.textContent).toContain('Loading notifications…')
    const dot = loading.querySelector('[data-testid="loading-state-dot"]')!
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })
})
