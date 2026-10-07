import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_DASHBOARD_MIN } from '../lib/fullscreen'
import { DESK_WIDGET_STYLESHEETS } from './dashboard-stack-cascade.test-helper'

/**
 * Dashboard below-board-fit stack reset must beat `.tile` canvas geometry.
 * The cut is DESKTOP_DASHBOARD_MIN (1476px) — the 1400px board plus both
 * --gutter caps — not a chrome breakpoint.
 *
 * `.tile` lives in cards.css @layer components. The order is
 * `components < pages` — pages sits above components (authority: the
 * `@layer` statement in tokens.css) — so a pages-layer copy of
 * `.dashboard-stack .tile`
 * would WIN regardless of specificity and would also overrule the widget
 * chapters' own components-layer specialization. The winning reset is
 * therefore in dashboard-desk.css (same layer, imported after cards.css),
 * beating `.tile` by specificity + source order.
 * Computed-style assertions at 390/768/899 belong to Action 2.
 */

const stylesDir = resolve(import.meta.dirname)
const entryPath = resolve(import.meta.dirname, '../main.tsx')
/** The desk stylesheets are route-owned: they load with the Dashboard chunk,
 *  after every entry stylesheet of the same layer. */
const dashboardPagePath = resolve(import.meta.dirname, '../pages/Dashboard.tsx')

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function firstLayerName(source: string): string | null {
  let text = stripComments(source).trimStart()
  text = text.replace(/^@layer\s+[\w-]+(?:\s*,\s*[\w-]+)*;\s*/, '')
  const match = text.match(/^@layer\s+([\w-]+)\s*\{/)
  return match ? match[1]! : null
}

function collectSimpleRules(source: string): Array<{ selector: string; body: string }> {
  const text = stripComments(source)
  const rules: Array<{ selector: string; body: string }> = []
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const header = match[1]!.trim()
    if (header.startsWith('@')) continue
    for (const selector of header.split(',')) {
      rules.push({ selector: selector.replace(/\s+/g, ' ').trim(), body: match[2] ?? '' })
    }
  }
  return rules
}

describe('dashboard stack tile reset (components layer)', () => {
  const widgets = readStyle('dashboard-desk.css')
  const cards = readStyle('cards.css')
  const pages = readStyle('dashboard.css')
  const entry = readFileSync(entryPath, 'utf8')
  const imports = [...entry.matchAll(/^import\s+['"](\.\/styles\/[^'"]+\.css)['"]/gmu)].map((m) => m[1])
  const dashboardPage = readFileSync(dashboardPagePath, 'utf8')
  const routeImports = [...dashboardPage.matchAll(/^import\s+['"]\.\.\/styles\/([^'"]+\.css)['"]/gmu)].map((m) => m[1])

  const stackTile = collectSimpleRules(widgets).find((r) => r.selector === '.dashboard-stack .tile')
  const canvasTile = collectSimpleRules(cards).find(
    (r) => r.selector === '.tile' && /position:\s*absolute/.test(r.body),
  )

  it('owns the stack reset in @layer components after cards.css `.tile`', () => {
    expect(firstLayerName(widgets)).toBe('components')
    expect(firstLayerName(cards)).toBe('components')
    expect(stackTile, 'dashboard-desk.css must declare .dashboard-stack .tile').toBeTruthy()
    expect(canvasTile, 'cards.css must still declare .tile { position: absolute }').toBeTruthy()
    expect(stackTile!.body).toMatch(/position:\s*relative/)
    expect(stackTile!.body).toMatch(/inset:\s*auto/)
    expect(stackTile!.body).toMatch(/transform:\s*none/)
    expect(stackTile!.body).toMatch(/width:\s*100%/)
    expect(stackTile!.body).toMatch(/height:\s*auto/)
    expect(stackTile!.body).toMatch(/min-height:/)
    expect(stackTile!.body).toMatch(/z-index:\s*auto/)
    // cards.css is an entry stylesheet; the desk files load later with the
    // Dashboard chunk, so they always sort after it inside @layer components.
    expect(imports.indexOf('./styles/cards.css')).toBeGreaterThanOrEqual(0)
    expect(imports).not.toContain('./styles/dashboard-desk.css')
    expect(routeImports.indexOf('dashboard-desk.css')).toBeGreaterThanOrEqual(0)
    for (const widget of DESK_WIDGET_STYLESHEETS) {
      expect(imports).not.toContain(`./styles/${widget}`)
      expect(routeImports.indexOf(widget), `${widget} must load after dashboard-desk.css`).toBeGreaterThan(
        routeImports.indexOf('dashboard-desk.css'),
      )
    }
  })

  it('does not leave the stack geometry reset only in the pages layer', () => {
    const pagesStackTile = collectSimpleRules(pages).find((r) => r.selector === '.dashboard-stack .tile')
    expect(pagesStackTile, 'dashboard.css must not be the owner of .dashboard-stack .tile geometry').toBeUndefined()
    expect(pages).toMatch(/\.dashboard-stack\s*\{/)
    expect(pages).toMatch(new RegExp(`@media\\s*\\(\\s*min-width:\\s*${DESKTOP_DASHBOARD_MIN}px\\s*\\)`))
  })
})
