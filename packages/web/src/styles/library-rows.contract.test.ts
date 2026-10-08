// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computedFor, prop, unmountCascade } from './css-contract.test-helper'

/**
 * R6-02 / R6-06 bookmark-row truncation contract.
 *
 * Comfort rows clamp the title to two lines; compact rows ellipsize it on
 * one. The compact override sits after the base rule and must reset the
 * -webkit-box clamp (display: block) so the two rules never fight — before
 * the fix, a 220-char title measured 153px row height vs the 46px norm.
 * The compact host column caps and ellipsizes so long domains cannot
 * squeeze the mid column.
 */

const stylesDir = resolve(import.meta.dirname)

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

type CssRule = { selector: string; body: string }

/** Every simple rule (no nested blocks), including rules inside @media. */
function collectSimpleRules(source: string): CssRule[] {
  const text = stripComments(source)
  const rules: CssRule[] = []
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const header = match[1]!.trim()
    if (header.startsWith('@')) continue
    for (const selector of header.split(',')) {
      rules.push({ selector: selector.replace(/\s+/g, ' ').trim(), body: match[2] ?? '' })
    }
  }
  return rules
}

describe('library bookmark row truncation (R6-02, R6-06)', () => {
  const rules = collectSimpleRules(readStyle('library.css'))
  const bodiesFor = (selector: string) =>
    rules.filter((rule) => rule.selector === selector).map((rule) => rule.body)

  // Computed against the entry cascade (global → cards-ui → library → polish …)
  // so a later layer that re-clamps or un-clamps the title fails here too.
  const CASCADE = ['tokens.css', 'global.css', 'page-chrome.css', 'cards.css', 'library.css', 'cards-ui.css', 'polish.css', 'interactions.css']
  afterEach(() => unmountCascade())

  it('R6-02: compact titles ellipsize on a single line', () => {
    const style = computedFor('.library-bookmark.library-bookmark--compact .library-bookmark-body h3', CASCADE)
    expect(prop(style, 'display')).toBe('block')
    expect(prop(style, 'white-space')).toBe('nowrap')
    expect(prop(style, 'overflow')).toBe('hidden')
    expect(prop(style, 'text-overflow')).toBe('ellipsis')
  })

  it('R6-06: comfort titles clamp to two lines', () => {
    const style = computedFor('.library-bookmark .library-bookmark-body h3', CASCADE)
    // happy-dom normalises the vendor `display: -webkit-box` to `block`, so the
    // clamp itself is the observable; the source check below keeps the box.
    // happy-dom 20 exposes the standards property but no longer reflects the
    // vendor-prefixed alias in computed style.
    expect(prop(style, '-webkit-line-clamp') || prop(style, 'line-clamp')).toBe('2')
    expect(prop(style, 'overflow')).toBe('hidden')
    expect(prop(style, 'white-space')).not.toBe('nowrap')
    expect(bodiesFor('.library-bookmark-body h3')[0]).toMatch(/display:\s*-webkit-box/)
  })

  it('compact host column caps width and ellipsizes', () => {
    const bodies = bodiesFor('.library-bookmark--compact .library-bookmark-host')
    const truncating = bodies.filter(
      (body) =>
        /max-width:/.test(body)
        && /overflow:\s*hidden/.test(body)
        && /text-overflow:\s*ellipsis/.test(body)
        && /white-space:\s*nowrap/.test(body),
    )
    expect(truncating.length).toBeGreaterThan(0)
  })

  it('R6-07: compact rows keep one register — mid never wraps, rows share a floor height', () => {
    const mid = bodiesFor('.library-bookmark-mid')
    expect(mid.some((body) => /flex-wrap:\s*nowrap/.test(body))).toBe(true)
    expect(mid.some((body) => /flex-wrap:\s*wrap(?!\S)/.test(body))).toBe(false)
    const compact = bodiesFor('.library-bookmark--compact')
    expect(compact.some((body) => /min-height:/.test(body))).toBe(true)
  })

  it('R6-08: comfort rows carry a height floor so description-less entries stay in register', () => {
    const comfort = bodiesFor('.library-bookmark--comfort')
    expect(comfort.some((body) => /min-height:\s*[1-9]/.test(body))).toBe(true)
  })

  it('unsaved save marks stay outlined and visible without hover', () => {
    const svg = bodiesFor('.library-bookmark-save svg')
    expect(svg.some((body) => /stroke:\s*currentColor/.test(body))).toBe(true)
    expect(svg.some((body) => /stroke-width:\s*1\.5/.test(body))).toBe(true)
    const fill = bodiesFor('.library-bookmark-save .bookmark-fill')
    expect(fill.some((body) => /fill:\s*transparent/.test(body))).toBe(true)
    const savedFill = bodiesFor('.library-bookmark-save.is-saved .bookmark-fill')
    expect(savedFill.some((body) => /fill:\s*currentColor/.test(body))).toBe(true)
    const save = bodiesFor('.library-bookmark-actions > .library-bookmark-save')
    expect(save.some((body) => /opacity:\s*1/.test(body))).toBe(true)
    const savedOnly = bodiesFor('.library-bookmark-actions > .library-bookmark-save.is-saved')
    expect(savedOnly).toHaveLength(0)
  })

  it('bookmark list frame does not clip row menus or shear squeezed rows', () => {
    const lists = [
      ...bodiesFor('.library-bookmark-list'),
      ...bodiesFor('.library-bookmark-list--comfort'),
      ...bodiesFor('.library-bookmark-list--compact'),
    ]
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.some((body) => /overflow:\s*hidden/.test(body))).toBe(false)
    const items = bodiesFor('.library-bookmark-list > [role=\'listitem\']')
    expect(items.some((body) => /flex-shrink:\s*0/.test(body))).toBe(true)
  })
})

describe('library rail title hierarchy', () => {
  const rules = collectSimpleRules(readStyle('library.css'))
  const bodiesFor = (selector: string) =>
    rules.filter((rule) => rule.selector === selector).map((rule) => rule.body)

  it('Collections sits above section labels: larger, ink, not another uppercase eyebrow', () => {
    const title = bodiesFor('.library-nav-head .section-label').join(' ')
    // The rail title shares the serif nameplate register with the
    // Today/Explore editorial page heads.
    expect(title).toMatch(/font-family:\s*var\(--font-serif\)/)
    expect(title).toMatch(/font-size:\s*var\(--text-xl\)/)
    expect(title).toMatch(/color:\s*var\(--ink\)/)
    expect(title).toMatch(/text-transform:\s*none/)
    expect(title).not.toMatch(/font-size:\s*var\(--text-xs\)/)
    const section = bodiesFor('.library-nav-section-toggle').join(' ')
    expect(section).toMatch(/font-size:\s*var\(--text-xs\)/)
    expect(section).toMatch(/text-transform:\s*uppercase/)
  })
})

describe('public collection tile uniformity (V-COL)', () => {
  const rules = collectSimpleRules(readStyle('collection.css'))
  const resultRules = collectSimpleRules(readStyle('cards-ui.css'))
  const bodiesFor = (selector: string) =>
    rules.filter((rule) => rule.selector === selector).map((rule) => rule.body)
  const resultBodiesFor = (selector: string) =>
    resultRules.filter((rule) => rule.selector === selector).map((rule) => rule.body)

  it('board cards share a silhouette: floor height and a bottom-pinned meta strip', () => {
    const card = resultBodiesFor('.result-board .result-card')
    expect(card.some((body) => /min-height:\s*[1-9]/.test(body))).toBe(true)
    const meta = resultBodiesFor('.result-card-meta')
    expect(meta.some((body) => /margin-top:\s*auto/.test(body))).toBe(true)
  })

  it('folder names stay bounded: cards clamp to two lines, rows ellipsize on one', () => {
    const cardName = bodiesFor('.collection-folder-card .collection-folder-name')
    expect(cardName.some((body) => /-webkit-line-clamp:\s*2/.test(body))).toBe(true)
    const rowName = bodiesFor('.collection-folder-row .collection-folder-name')
    expect(rowName.some(
      (body) =>
        /white-space:\s*nowrap/.test(body)
        && /overflow:\s*hidden/.test(body)
        && /text-overflow:\s*ellipsis/.test(body),
    )).toBe(true)
  })
})
