import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectLayeredRules,
  loadDashboardCascadeRules,
  winningStackTileProperty,
} from './dashboard-stack-cascade.test-helper'

/**
 * DS-01 / DS-02 / DS-10 / DS-11 breakpoint contract.
 *
 * Locks the documented content + chrome scales so a later @media group
 * cannot silently override Explore columns, invent an unlisted pixel
 * cut, revive a scaled Dashboard preview, or split Landing/Share hero cuts.
 */

const stylesDir = resolve(import.meta.dirname)

/** Documented tracks + registered exceptions + X-1 pairs.
 *  1475/1476 is the Dashboard board-fit cut: the 1400px canvas plus both
 *  --gutter caps (2 × 2.35rem = 75.2px) fits from 1476px — below it the
 *  fixed board would clip, so the module stack holds (DS-10). */
const ALLOWED_MEDIA_PX = new Set([
  540, 541, 639, 640, 719, 720, 899, 900, 1099, 1100, 1475, 1476,
])

/** Height-axis cuts are a separate axis from the width tracks (R9-29): the
 *  only registered one is landing.css's `max-height: 26rem` phone-landscape
 *  hero compaction. parseMedia below intentionally models width only, so the
 *  dedicated allowlist test keeps the height axis visible instead of
 *  silently unverified. */
const ALLOWED_HEIGHT_FEATURES = new Set(['max-height: 26rem'])

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

type MediaQuery = { min?: number; max?: number }

/* Width-only on purpose: height-axis cuts are gated separately by the
   ALLOWED_HEIGHT_FEATURES allowlist (R9-29); a height condition here would
   be dropped, not evaluated. */
function parseMedia(header: string): MediaQuery | null {
  if (!header.startsWith('@media')) return null
  const min = header.match(/min-width:\s*(\d+)px/)
  const max = header.match(/max-width:\s*(\d+)px/)
  return {
    min: min ? Number(min[1]) : undefined,
    max: max ? Number(max[1]) : undefined,
  }
}

function mediaMatches(query: MediaQuery | null, width: number): boolean {
  if (!query) return true
  if (query.min != null && width < query.min) return false
  if (query.max != null && width > query.max) return false
  return true
}

type CssRule = { media: MediaQuery | null; selector: string; body: string }

/** Top-level and @media rules, source order, comments stripped. */
function collectRules(source: string): CssRule[] {
  const text = stripComments(source)
  const rules: CssRule[] = []
  const stack: Array<{ kind: 'media' | 'other'; media: MediaQuery | null }> = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const header = buf.trim()
      buf = ''
      if (/^@(keyframes|-\w+-keyframes)\b/i.test(header)) {
        stack.push({ kind: 'other', media: currentMedia(stack) })
      } else if (header.startsWith('@media')) {
        stack.push({ kind: 'media', media: parseMedia(header) })
      } else if (header.startsWith('@')) {
        stack.push({ kind: 'other', media: currentMedia(stack) })
      } else {
        const close = matchingClose(text, i)
        const body = close === -1 ? '' : text.slice(i + 1, close)
        if (header && !header.startsWith('--')) {
          for (const selector of splitSelectors(header)) {
            rules.push({ media: currentMedia(stack), selector, body })
          }
        }
        stack.push({ kind: 'other', media: currentMedia(stack) })
      }
    } else if (ch === '}') {
      stack.pop()
      buf = ''
    } else if (ch === ';') {
      buf = ''
    } else {
      buf += ch
    }
    i += 1
  }
  return rules
}

function currentMedia(stack: Array<{ kind: string; media: MediaQuery | null }>): MediaQuery | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]!.kind === 'media') return stack[i]!.media
  }
  return null
}

function matchingClose(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function splitSelectors(header: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of header) {
    if (ch === '(' || ch === '[') depth += 1
    if (ch === ')' || ch === ']') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function columnCount(body: string): number | null {
  const repeat = body.match(/grid-template-columns\s*:\s*repeat\(\s*(\d+)/)
  if (repeat) return Number(repeat[1])
  const single = body.match(/grid-template-columns\s*:\s*1fr\s*;/)
  if (single) return 1
  return null
}

function winningColumns(rules: CssRule[], selector: string, width: number): number | null {
  let cols: number | null = null
  for (const rule of rules) {
    if (rule.selector !== selector) continue
    if (!mediaMatches(rule.media, width)) continue
    const count = columnCount(rule.body)
    if (count != null) cols = count
  }
  return cols
}

function mediaHeaders(source: string): string[] {
  return [...stripComments(source).matchAll(/@media[^{]+/g)].map((m) => m[0].replace(/\s+/g, ' ').trim())
}

const PAGE_DOMAIN_FILES = [
  'landing.css',
  'explore.css',
  'collection.css',
  'profile.css',
  'dashboard.css',
  'graph.css',
  'sync.css',
  'write-approvals.css',
  'classify.css',
  'pages-shared.css',
] as const

describe('breakpoint contract (DS-01, DS-02, DS-10, DS-11)', () => {
  const pages = PAGE_DOMAIN_FILES.map((file) => readStyle(file)).join('\n')
  const library = readStyle('library.css')
  const share = readStyle('share.css')
  const nav = readStyle('nav.css')
  const skeleton = readStyle('skeleton.css')
  const cards = readStyle('cards.css')
  const pagesRules = collectRules(pages)
  const libraryRules = collectRules(library)
  const shareRules = collectRules(share)
  const navRules = collectRules(nav)
  const skeletonRules = collectRules(skeleton)
  const cardsRules = collectRules(cards)
  const pageChromeRules = collectRules(readStyle('page-chrome.css'))

  it('DS-01: default .collection-grid columns follow 1 / 2 / 3 and never 4', () => {
    const sel = '.collection-grid'
    expect(winningColumns(pagesRules, sel, 390)).toBe(1)
    expect(winningColumns(pagesRules, sel, 639)).toBe(1)
    expect(winningColumns(pagesRules, sel, 640)).toBe(2)
    expect(winningColumns(pagesRules, sel, 768)).toBe(2)
    expect(winningColumns(pagesRules, sel, 899)).toBe(2)
    expect(winningColumns(pagesRules, sel, 900)).toBe(3)
    expect(winningColumns(pagesRules, sel, 1024)).toBe(3)
    expect(winningColumns(pagesRules, sel, 1100)).toBe(3)
    expect(winningColumns(pagesRules, sel, 1280)).toBe(3)
    expect(winningColumns(pagesRules, sel, 1920)).toBe(3)

    const defaultFour = pagesRules.filter(
      (r) => r.selector === sel && columnCount(r.body) === 4,
    )
    expect(defaultFour, 'default density must not declare 4 columns').toEqual([])
  })

  it('DS-01: .route-loading-grid follows the same 1 / 2 / 3 tracks as default .collection-grid', () => {
    const sel = '.route-loading-grid'
    expect(winningColumns(skeletonRules, sel, 390)).toBe(1)
    expect(winningColumns(skeletonRules, sel, 639)).toBe(1)
    expect(winningColumns(skeletonRules, sel, 640)).toBe(2)
    expect(winningColumns(skeletonRules, sel, 899)).toBe(2)
    expect(winningColumns(skeletonRules, sel, 900)).toBe(3)
    expect(winningColumns(skeletonRules, sel, 1024)).toBe(3)
    expect(winningColumns(skeletonRules, sel, 1100)).toBe(3)
    expect(winningColumns(skeletonRules, sel, 1400)).toBe(3)
    const four = skeletonRules.filter((r) => r.selector === sel && columnCount(r.body) === 4)
    expect(four, 'default card-grid skeleton must not declare 4 columns').toEqual([])
  })

  it('collection masthead titles use a three-line clamp at ≤639, not nowrap ellipsis', () => {
    const mobile = pagesRules.filter(
      (r) => r.selector === '.collection-masthead .display' && r.media?.max === 639,
    )
    expect(mobile.length).toBeGreaterThan(0)
    const body = mobile.map((r) => r.body).join('\n')
    expect(body).toMatch(/-webkit-line-clamp:\s*3/)
    expect(body).toMatch(/line-height:\s*var\(--leading-clamp\)/)
    expect(body).not.toMatch(/white-space:\s*nowrap/)
    expect(body).not.toMatch(/text-overflow:\s*ellipsis/)
  })

  it('overflowing custom canvas shell fades the end edge', () => {
    const fade = cardsRules.find(
      (r) => r.selector === '.canvas-shell--custom.canvas-shell--overflow-end',
    )
    expect(fade, 'overflow-end fade must live on .canvas-shell--custom').toBeTruthy()
    expect(fade!.body).toMatch(/mask-image:/)
    expect(fade!.body).toMatch(/linear-gradient/)
    expect(cards).toMatch(/\.canvas-scroll-hint/)
  })

  it('page-shell titles use --measure, not a 22ch form clamp', () => {
    const titleRules = pageChromeRules.filter(
      (r) =>
        r.selector === '.page-shell > .page-shell-inner:first-child .display' ||
        r.selector === '.page-shell > .page-shell-inner:first-child h1',
    )
    expect(titleRules.length).toBeGreaterThan(0)
    for (const rule of titleRules) {
      expect(rule.body).not.toMatch(/max-width:\s*22ch/)
      expect(rule.body).toMatch(/max-width:\s*var\(--measure\)/)
    }
    const pageChromeNoComments = stripComments(readStyle('page-chrome.css'))
    expect(pageChromeNoComments).not.toMatch(/\.page-shell[^}]*22ch/)
    // The shell is base chrome, not studio business styling: studio.css must
    // not grow a second .page-shell definition.
    const studioNoComments = stripComments(readStyle('studio.css'))
    expect(studioNoComments).not.toMatch(/^\s*\.page-shell(?:-inner|--grid|--narrow)?\s*[{,]/m)
    // The pre-PageShell wrappers are gone for good; nothing may style them.
    expect(studioNoComments).not.toMatch(/\.miss-(?:page|shell)/)
  })

  it('DS-02: @media pixel values stay on the documented allowlist', () => {
    const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css'))
    const offenders: string[] = []
    for (const file of cssFiles) {
      for (const header of mediaHeaders(readStyle(file))) {
        for (const match of header.matchAll(/(\d+)px/g)) {
          const px = Number(match[1])
          if (!ALLOWED_MEDIA_PX.has(px)) offenders.push(`${file}: ${header}`)
        }
      }
    }
    expect(offenders, 'absorb unlisted @media pixels onto the documented tracks').toEqual([])
  })

  it('DS-02: width cuts respect direction — max-width uses X-1, min-width uses X', () => {
    // Paired bands are mutually exclusive (tokens.css): max-width: Xpx at a
    // scale value would overlap its min-width: Xpx counterpart at exactly X.
    // Height queries stay free-form; only width direction is contracted.
    const MAX_WIDTH_PX = new Set([540, 639, 719, 899, 1099, 1475])
    const MIN_WIDTH_PX = new Set([541, 640, 720, 900, 1100, 1476])
    const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css'))
    const offenders: string[] = []
    for (const file of cssFiles) {
      for (const header of mediaHeaders(readStyle(file))) {
        for (const match of header.matchAll(/max-width:\s*(\d+)px/g)) {
          if (!MAX_WIDTH_PX.has(Number(match[1]))) offenders.push(`${file}: ${header}`)
        }
        for (const match of header.matchAll(/min-width:\s*(\d+)px/g)) {
          if (!MIN_WIDTH_PX.has(Number(match[1]))) offenders.push(`${file}: ${header}`)
        }
      }
    }
    expect(offenders, 'pair max-width X-1 against min-width X; never max at a scale value').toEqual([])
  })

  it('DS-02: width cuts use px only — rem/em queries would bypass the allowlist', () => {
    // A 44rem width cut is an undocumented 704px track the pixel allowlist
    // cannot see. Height/aspect queries stay free-form; width is the contract.
    const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css'))
    const offenders: string[] = []
    for (const file of cssFiles) {
      for (const header of mediaHeaders(readStyle(file))) {
        if (/(?:min|max)-width:\s*[\d.]+(?:rem|em|ch|ex|vw)/.test(header)) {
          offenders.push(`${file}: ${header}`)
        }
      }
    }
    expect(offenders, 'express @media width cuts in px from the documented set').toEqual([])
  })

  it('DS-02: height-axis cuts stay on the registered allowlist (R9-29)', () => {
    // parseMedia cannot see height queries, so without this scan a
    // `@media (max-height: …)` breakpoint would bypass every width contract.
    const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css'))
    const offenders: string[] = []
    for (const file of cssFiles) {
      for (const header of mediaHeaders(readStyle(file))) {
        for (const match of header.matchAll(/(min|max)-height\s*:\s*([\d.]+)\s*(px|rem|em|vh)/g)) {
          const feature = `${match[1]}-height: ${match[2]}${match[3]}`
          if (!ALLOWED_HEIGHT_FEATURES.has(feature)) offenders.push(`${file}: ${header}`)
        }
      }
    }
    expect(offenders, 'register new height-axis breakpoints in ALLOWED_HEIGHT_FEATURES').toEqual([])
  })

  it('DS-02: compact search stays in the bar at ≤540', () => {
    const hideSearch = navRules.filter(
      (r) =>
        r.selector === '.nav-search-compact' &&
        r.media?.max === 540 &&
        /display:\s*none/.test(r.body),
    )
    expect(hideSearch, 'search must remain reachable without opening the drawer').toEqual([])
  })

  it('DS-02: 541–1099 hides Log in only, not Get started', () => {
    const midCta = collectRules(nav).filter(
      (r) =>
        r.media?.min === 541 &&
        r.media.max === 1099 &&
        r.selector.startsWith('.nav-actions > a.btn') &&
        /display:\s*none/.test(r.body),
    )
    expect(midCta.map((r) => r.selector)).toEqual(['.nav-actions > a.btn-ghost'])
    expect(midCta.some((r) => r.selector === '.nav-actions > a.btn')).toBe(false)
    expect(midCta.some((r) => r.selector.includes('btn-primary'))).toBe(false)
  })

  it('DS-02: full search and burger-off align with --bp-lg 1100; nav-links and Library at 720', () => {
    const searchShow = collectRules(nav).filter(
      (r) => r.selector === '.nav-search' && /display:\s*inline-flex/.test(r.body),
    )
    expect(searchShow.some((r) => r.media?.min === 1100 && r.media.max == null)).toBe(true)

    const burgerHide = collectRules(nav).filter(
      (r) => r.selector === '.nav-burger' && /display:\s*none/.test(r.body),
    )
    expect(burgerHide.some((r) => r.media?.min === 1100 && r.media.max == null)).toBe(true)

    const navLinks = collectRules(nav).filter(
      (r) => r.selector === '.nav-links' && /display:\s*flex/.test(r.body),
    )
    expect(navLinks.some((r) => r.media?.min === 720)).toBe(true)

    const libraryTwoCol = libraryRules.filter(
      (r) => r.selector === '.library-desk' && r.media?.min === 720 && /grid-template-columns/.test(r.body),
    )
    expect(libraryTwoCol.length).toBeGreaterThan(0)
  })

  it('DS-10: below the board-fit cut Dashboard stacks modules; no scaled preview or EmptyState reject', () => {
    expect(pages).not.toMatch(/dashboard-page\s*>\s*\*:not\(\.dashboard-mobile-only\)/)
    expect(pages).not.toMatch(/--dashboard-preview-scale/)

    // Class-string presence in dashboard.css is not proof — the reset must win from
    // `@layer components` so it can beat `.tile { position: absolute }`.
    // Computed-style matrix (390/768/899): Dashboard.test.tsx
    // "DS-10: stacked tiles compute position:relative at 390/768/899".
    const position = winningStackTileProperty(loadDashboardCascadeRules(), 'position', 768)
    expect(
      position,
      'winning stack reset must live in @layer components (same layer as .tile)',
    ).toMatchObject({ value: 'relative', layer: 'components' })

    const tabletShell = pagesRules.find(
      (r) =>
        r.selector === '.dashboard-page .canvas-shell' &&
        r.media?.min === 640 &&
        r.media.max === 899,
    )
    expect(tabletShell).toBeUndefined()

    const tabletBoard = pagesRules.find(
      (r) => r.selector === '.dashboard-page .board' && r.media?.min === 640 && r.media.max === 899,
    )
    expect(tabletBoard).toBeUndefined()

    const clip = collectRules(cards).find(
      (r) =>
        r.selector === '.dashboard-page .canvas-shell--custom' &&
        r.media?.min === 640 &&
        r.media.max === 899,
    )
    expect(clip).toBeUndefined()
  })

  it('DS-10: the board cut is the canvas-fit width (1476px) in CSS and JS alike', () => {
    /* The board is a fixed 1400px canvas; the shell adds both --gutter caps
       (2 × 2.35rem = 75.2px), so it only fits whole from 1476px. Between the
       old 900px cut and 1475px the board clipped behind the overflow fade —
       the stack must cover that whole range. Lock the CSS cut, its X-1 pair,
       and the JS constant that gates stackLayout + fullscreen. */
    const stackHide = pagesRules.find(
      (r) => r.selector === '.dashboard-stack' && /display:\s*none/.test(r.body),
    )
    expect(stackHide?.media, 'stack yields to the board only where the 1400px canvas fits').toEqual({
      min: 1476,
      max: undefined,
    })

    const fullscreenRevert = mediaHeaders(readStyle('dashboard.css')).filter((h) =>
      h.includes('max-width: 1475px'),
    )
    expect(fullscreenRevert, 'chrome-hide reverts across the whole stack range (X-1 pair)').toHaveLength(1)

    const fullscreenTs = readFileSync(resolve(stylesDir, '../lib/fullscreen.ts'), 'utf8')
    expect(fullscreenTs).toMatch(/DESKTOP_DASHBOARD_MIN\s*=\s*1476/)

    // No dashboard rule may reintroduce the board inside the stack range.
    const boardInStackRange = pagesRules.filter(
      (r) =>
        r.selector.startsWith('.dashboard-page') &&
        r.media?.min != null &&
        r.media.min < 1476 &&
        /canvas-shell|\.board\b/.test(r.selector),
    )
    expect(boardInStackRange, 'no board styling below the board-fit cut').toEqual([])
  })

  it('DS-10: a pages-layer stack reset beats the components .tile base (pages sit above components)', () => {
    // The order is `components < pages`: a route may specialise component
    // chrome, and the cascade emulation used by the dashboard stack contract
    // must agree with the browser on that.
    const rules = [
      ...collectLayeredRules(
        `@layer components { .tile { position: absolute; width: var(--w); transform: translate3d(var(--x), var(--y), 0); } }`,
      ),
      ...collectLayeredRules(
        `@layer pages { .dashboard-stack .tile { position: relative; width: 100%; transform: none; } }`,
      ),
    ]
    for (const width of [390, 768, 899]) {
      expect(winningStackTileProperty(rules, 'position', width)).toMatchObject({
        value: 'relative',
        layer: 'pages',
      })
    }
    // …while a later components-layer rule still beats an earlier one of the
    // same layer, so the real reset in the widget chapters keeps winning
    // over cards.css `.tile` by import order.
    const sameLayer = [
      ...collectLayeredRules(`@layer components { .tile { position: absolute; } }`),
      ...collectLayeredRules(`@layer components { .dashboard-stack .tile { position: relative; } }`),
    ]
    expect(winningStackTileProperty(sameLayer, 'position', 768)).toMatchObject({
      value: 'relative',
      layer: 'components',
    })
  })

  it('DS-11: Landing and Share heroes use the same 900px two-column cut', () => {
    /* The dither-field hero (landing rework) retired .landing-hero-inner and
       its two-column cut: the hero is a fixed centered stage at every width.
       Lock that no landing hero grid cut comes back; Share keeps 900px. */
    const landingTwoCol = pagesRules.filter(
      (r) => r.selector === '.landing-hero-inner' && /grid-template-columns/.test(r.body),
    )
    expect(landingTwoCol, 'the dither-field hero has no two-column grid cut').toEqual([])

    const shareTwoCol = shareRules.filter(
      (r) => r.selector === '.share-hero-inner' && /grid-template-columns/.test(r.body),
    )
    expect(shareTwoCol).toHaveLength(1)
    expect(shareTwoCol[0]?.media).toEqual({ min: 900, max: undefined })

    const shareBodyGrids = ['.share-beats', '.share-reasons', '.share-spotlight-grid', '.share-footer-cta-inner']
    for (const sel of shareBodyGrids) {
      const cuts = shareRules.filter((r) => r.selector === sel && /grid-template-columns/.test(r.body))
      expect(cuts, `${sel} must share the 900px hero cut`).toHaveLength(1)
      expect(cuts[0]?.media).toEqual({ min: 900, max: undefined })
    }

    const shareTabletHero = shareRules.filter(
      (r) =>
        r.selector.startsWith('.share-hero') &&
        r.media?.min === 640 &&
        r.media.max === 899 &&
        /grid-template-columns/.test(r.body),
    )
    expect(shareTabletHero, 'Share must not go two-column in the 640–899 band').toEqual([])

    expect(mediaHeaders(pages).some((h) => /landing-hero/.test(h))).toBe(false)
    expect(stripComments(pages)).not.toMatch(/@media\s*\(min-width:\s*960px\)[^{]*\{[^}]*landing-hero-inner/)
    expect(stripComments(share)).not.toMatch(/@media\s*\(min-width:\s*960px\)[^{]*\{[^}]*share-hero-inner/)
  })

  it('DS-02: landing collections keep a Browse CTA at ≤639', () => {
    const hidden = pagesRules.filter(
      (r) =>
        r.media?.max === 639 &&
        r.selector.includes('landing-collections-section') &&
        /display:\s*none/.test(r.body),
    )
    expect(hidden, 'phone landing must not hide Browse all collections').toEqual([])
  })
})
