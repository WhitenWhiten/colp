import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * R8-11 spacing-scale contract.
 *
 * margin / padding / gap declarations must draw from the --space-* / --hair-*
 * rungs in tokens.css via var() (or calc(-1 * var(...)) for negative overlaps).
 * A bare literal `<n>rem` in one of those declarations is allowed only when:
 *
 *   (a) the line carries an `off-scale: <reason>` exemption comment — for
 *       values that are not scale spacing at all (optical nudges, sub-pixel
 *       hairlines, pads that clear absolutely-positioned chrome), or
 *   (b) the (file, value) pair is pinned in PAGE_RHYTHM_STOCK below — the
 *       remaining page/section-rhythm stock (2.5–6rem) that predates a coarse
 *       scale decision. Pins are exact counts: a new usage turns the test red,
 *       and a converged usage must shrink the pin so the stock only shrinks.
 *
 * Deliberately out of scope (narrow rules beat clever ones):
 *   - inset/top/left/right/bottom — positioning, often precise coordinates
 *     (e.g. the empty-state-illustration art in page-chrome.css).
 *   - values nested in calc()/clamp()/min()/max()/env() — token arithmetic and
 *     fluid rhythm bounds are computed, not scale steps.
 *   - em literals — font-relative optical adjustments by design.
 *   - tokens.css itself (the definitions) and px values (border/hairline
 *     discipline is owned by other contracts).
 */

const stylesDir = resolve(import.meta.dirname)

const SPACING_PROPS = [
  'margin-inline-start', 'margin-inline-end', 'margin-block-start', 'margin-block-end',
  'margin-inline', 'margin-block', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin',
  'padding-inline-start', 'padding-inline-end', 'padding-block-start', 'padding-block-end',
  'padding-inline', 'padding-block', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding',
  'row-gap', 'column-gap', 'gap',
] as const

const DECL_RE = new RegExp(`(?<![\\w-])(${SPACING_PROPS.join('|')})\\s*:\\s*([^;{}]+?)(;|$|(?=}))`, 'gm')

/** Page-rhythm stock: file → literal value → exact remaining occurrence count. */
const PAGE_RHYTHM_STOCK: Record<string, Record<string, number>> = {
  'cards.css': { '2.5rem': 1 },
  'collab.css': { '2.5rem': 1, '3rem': 1 },
  // collection.css converged onto the scale (Contents/main-column layout): no stock left.
  'dashboard.css': { '3rem': 1 },
  'demos.css': { '3.5rem': 1 },
  // explore.css converged onto PageShell padding (C1): no stock left.
  'extension.css': { '3rem': 1 },
  'global.css': { '2.5rem': 1, '3.5rem': 1 },
  // graph.css converged onto PageShell + scale tokens (R10-31): no stock left.
  // library.css converged onto PageShell padding (C1): no stock left.
  // Former loops.css stock, redistributed to the per-route files (same total).
  'collection-history.css': { '2.5rem': 1 },
  'data-export.css': { '2.5rem': 1 },
  // reader.css and path-reader.css converged onto the scale: no stock left.
  'page-chrome.css': { '2.5rem': 1, '3rem': 1 },
  'share.css': { '2.5rem': 2, '3rem': 1 },
}

/** Blank comment contents in place so offsets and line numbers survive. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** Blank everything inside parentheses so nested calc/clamp/env values are invisible. */
function maskParens(value: string): string {
  let out = ''
  let depth = 0
  for (const ch of value) {
    if (ch === '(') {
      depth += 1
      out += ' '
    } else if (ch === ')') {
      depth -= 1
      out += ' '
    } else {
      out += depth > 0 ? ' ' : ch
    }
  }
  return out
}

type LiteralHit = { file: string; line: number; value: string; exempt: boolean }

function collectBareLiterals(file: string): LiteralHit[] {
  const text = readFileSync(resolve(stylesDir, file), 'utf8')
  const blanked = blankComments(text)
  const lineStart: number[] = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') lineStart.push(i + 1)
  }
  const hits: LiteralHit[] = []
  for (const match of blanked.matchAll(DECL_RE)) {
    const line = lineStart.findIndex((start, i) => start <= match.index && match.index < (lineStart[i + 1] ?? Infinity))
    const rawLine = text.slice(lineStart[line], lineStart[line + 1] ?? text.length)
    const exempt = /\/\*\s*off-scale:/.test(rawLine)
    const masked = maskParens(match[2]!)
    for (const literal of masked.matchAll(/-?[\d.]+rem\b/g)) {
      hits.push({ file, line: line + 1, value: literal[0], exempt })
    }
  }
  return hits
}

describe('spacing scale contract (R8-11)', () => {
  const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css') && f !== 'tokens.css')
  const hits = cssFiles.flatMap(collectBareLiterals)

  it('margin/padding/gap bare rem literals are exempted or pinned page-rhythm stock', () => {
    const offenders: string[] = []
    const unpinned = hits.filter((h) => !h.exempt)
    const used = new Map<string, number>()
    for (const hit of unpinned) {
      const key = `${hit.file} ${hit.value}`
      const seen = (used.get(key) ?? 0) + 1
      used.set(key, seen)
      const pinned = PAGE_RHYTHM_STOCK[hit.file]?.[hit.value] ?? 0
      if (seen > pinned) {
        offenders.push(`${hit.file}:${hit.line}: bare ${hit.value} — use the --space-*/--hair-* rung, ` +
          'or add an `off-scale: <reason>` comment if it is not scale spacing')
      }
    }
    expect(offenders, 'new off-scale spacing literals must not slip in').toEqual([])
  })

  it('page-rhythm stock pins stay exact — shrink a pin when its site converges', () => {
    const stale: string[] = []
    for (const [file, values] of Object.entries(PAGE_RHYTHM_STOCK)) {
      for (const [value, pinned] of Object.entries(values)) {
        const actual = hits.filter((h) => h.file === file && h.value === value && !h.exempt).length
        if (actual < pinned) {
          stale.push(`${file} ${value}: pinned ${pinned} but only ${actual} remain — shrink the pin`)
        }
      }
    }
    expect(stale, 'converged stock must shrink its pin').toEqual([])
  })

  it('phone page padding uses --page-pad-y-mobile, owned by .page-shell alone', () => {
    const tokens = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')
    expect(tokens).toMatch(/--page-pad-y-mobile:\s*var\(--hair-150\)/)
    const pageChrome = readFileSync(resolve(stylesDir, 'page-chrome.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const explore = readFileSync(resolve(stylesDir, 'explore.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const library = readFileSync(resolve(stylesDir, 'library.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const sync = readFileSync(resolve(stylesDir, 'sync.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(pageChrome).toMatch(/\.page-shell\s*\{[^}]*padding:\s*var\(--page-pad-y-mobile\)/)
    // C1: Explore/Library/DemoHub render PageShell, so the per-route phone
    // padding duplicates (.explore-page / .library-page / .demo-directory-page)
    // must stay deleted — .page-shell is the only owner.
    expect(explore).not.toMatch(/\.explore-page\s*\{[^}]*padding:/)
    expect(library).not.toMatch(/\.library-page\s*\{/)
    expect(sync).not.toMatch(/\.sync-page\s*\{\s*padding-top:/)
  })
})
