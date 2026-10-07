// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RouteLoading } from './RouteLoading'
import { cleanup, mountTree } from '../test/render'

/**
 * The skeleton must be drawn on the same paper — and in the same shape — as
 * the page it stands in for.
 *
 * One invariant covers that: a leaf placeholder shimmers, a container does not.
 * The shimmer used to be keyed on `.route-loading > div`, which swept the
 * layout wrappers as well — the skeleton grew a surface the real page has no
 * card for, so the background flicked when Suspense resolved. The same
 * over-broad selector outranked the wrappers' own class rules and pinned the
 * card grid to `display: block`, while the card's own bones (chip, title,
 * text, avatar, name) matched nothing at all and rendered invisible.
 */

/** One route per distinct skeleton shape in layoutForPath. */
const VARIANTS = [
  ['/library', 'desk'],
  ['/library/new', 'form'],
  ['/export', 'rows'],
  ['/explore', 'cards'],
  ['/feed', 'stream'],
  ['/today', 'today'],
  ['/search', 'search'],
  ['/notifications', 'inbox'],
  ['/credits', 'ledger'],
  ['/graph/x', 'canvas'],
  // R15-32: the bookmark page has its own bones; 'reader' stays on digest issues.
  ['/r/x', 'resource'],
  ['/reports/weekly/issues/e1', 'reader'],
  ['/path/x', 'reading'],
  ['/u/someone', 'profile'],
  ['/login', 'auth'],
  ['/about', 'rows'],
] as const

function styleSheet(): string {
  // skeleton.css is one `@layer base { … }`; happy-dom resolves the cascade
  // inside a plain stylesheet, so unwrap the layer and keep every rule in order.
  const css = readFileSync(resolve(import.meta.dirname, '../styles/skeleton.css'), 'utf8')
  return css.replace('@layer base {', '').replace(/\}\s*$/, '')
}

function shimmers(element: Element): boolean {
  return getComputedStyle(element).backgroundImage.includes('linear-gradient')
}

/** Placeholder shapes only: the live region label is real text, not a bone. */
function isBone(element: Element): boolean {
  return element.children.length === 0 && element.textContent === ''
}

describe('RouteLoading skeleton surface', () => {

  beforeEach(() => {
    document.head.innerHTML = `<style>${styleSheet()}</style>`
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  function render(path: string) {
    mountTree(<MemoryRouter initialEntries={[path]}><RouteLoading /></MemoryRouter>)
    return document.querySelector('[role="status"]')!
  }

  it.each(VARIANTS)('paints %s (%s) bones on the page paper, never a wrapper', (path, shape) => {
    const skeleton = render(path)
    expect(skeleton.getAttribute('data-skeleton')).toBe(shape)
    const elements = [...skeleton.querySelectorAll('*')]
    expect(elements.length).toBeGreaterThan(3)

    const litWrappers = elements.filter((el) => !isBone(el) && shimmers(el))
    const darkBones = elements.filter((el) => isBone(el) && !shimmers(el))

    expect(litWrappers.map((el) => el.className)).toEqual([])
    expect(darkBones.map((el) => el.className)).toEqual([])
  })

  it('draws /library as the desk (rail + rows), not a card grid', () => {
    const skeleton = render('/library/col-1')
    expect(skeleton.querySelector('[data-testid="skeleton-desk-nav"]')).not.toBeNull()
    expect(skeleton.querySelectorAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(2)
    expect(skeleton.querySelector('[data-testid="route-loading-grid"]')).toBeNull()
  })

  it('draws on the page chrome: the shell padding track and the page head', () => {
    const skeleton = render('/library/health')
    const shell = skeleton.querySelector('[data-testid="skeleton-shell"]')!
    expect(shell.getAttribute('class')).toBe('page-shell page-shell--grid')
    expect(shell.firstElementChild?.getAttribute('class')).toBe('page-shell-inner')
    const head = skeleton.querySelector('[data-testid="skeleton-head"]')!
    expect(head.getAttribute('class')?.split(' ')).toEqual(
      expect.arrayContaining(['page-head', 'page-head--split', 'page-head--workbench']),
    )
  })

  it('hands /c/:slug to the Collection page skeleton itself', () => {
    render('/c/some-collection')
    const board = document.querySelector('[data-testid="collection-skeleton-board"]')!
    expect(board.children).toHaveLength(6)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Public collection')
  })

  it('keeps the card grid a grid so cards do not stack full-width', () => {
    const skeleton = render('/explore')
    const grid = skeleton.querySelector('[data-testid="route-loading-grid"]')!
    expect(getComputedStyle(grid).display).toBe('grid')
    expect(skeleton.querySelectorAll('[data-testid="route-loading-card"]')).toHaveLength(6)
  })

  it('drops the shimmer animation under reduced motion for exactly the bones', () => {
    const css = styleSheet().replace(/\/\*[\s\S]*?\*\//g, '')
    const shimmerRule = css.match(/([^{}]+)\{[^{}]*animation: route-shimmer[^{}]*\}/)
    const reducedRule = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]+)\{[^}]*animation: none;/)
    const selectors = (raw: string | undefined) =>
      (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).sort()

    expect(selectors(shimmerRule?.[1])).toEqual(['.skeleton-block'])
    expect(selectors(reducedRule?.[1])).toEqual(selectors(shimmerRule?.[1]))
  })

  it('sweeps every bone in lockstep and loops by exactly one tile', () => {
    const css = styleSheet()
    const bone = css.match(/\.skeleton-block \{([^}]*)\}/)?.[1] ?? ''
    // Viewport-pinned tile: bones of any width share one glint.
    expect(bone).toMatch(/background-attachment:\s*fixed/)
    expect(bone).toMatch(/background-size:\s*100vw 100%/)
    // The keyframe travels exactly one tile width, so the loop never jumps.
    expect(css).toMatch(/@keyframes route-shimmer \{\s*from \{ background-position: -100vw 0; \}\s*to \{ background-position: 0 0; \}/)
  })
})
