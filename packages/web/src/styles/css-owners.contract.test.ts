import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESK_WIDGET_STYLESHEETS } from './dashboard-stack-cascade.test-helper'

/**
 * C01 surface-primitive owner contract.
 *
 * Each shared surface primitive has exactly one chrome owner inside the
 * C01-controlled file set. Geometry/layout copies may appear in a named
 * co-owner (e.g. .view-switch track layout in collection.css). Patterns may
 * add transform/transition only. Chrome (border / radius / background /
 * shadow) must not be redeclared outside the owner — including descendant
 * selectors whose last compound targets a primitive (`.foo .btn`).
 * Layout-only descendants (width / flex / display / …) do not need
 * registration.
 *
 *   .btn              -> global.css
 *   .panel            -> global.css
 *   .field            -> global.css
 *   .search-field     -> global.css
 *   .chip / .badge / .read-mark -> global.css
 *   .pill             -> page-chrome.css (moved with the filter-chip domain, R8-12)
 *   .avatar / .view-switch / .lib-snippet -> shared-chrome.css
 *   .result-card  -> cards-ui.css
 *   .tile             -> cards.css (geometry + chrome merged in one block, R8-01)
 *   .auth-card        -> auth.css
 *
 * Patterns-layer feedback chrome (hover shadow/press/tint) painted by
 * interactions.css on another file's primitive is licensed per-selector
 * through STATE_CHROME_EXEMPTIONS (R9-12) — still chrome, still audited.
 */

const stylesDir = resolve(import.meta.dirname)

/** C01-controlled files — the only files this contract can enforce.
 *  R9-12: every author stylesheet is covered — owners, the global.css base
 *  splits, the desk stack, and the previously uncontrolled files
 *  (interactions.css, utilities.css, page-layouts.css, resource-detail.css,
 *  reports.css, canvas-background.css, desk-themes.css, workbench-chrome.css)
 *  so a patterns- or
 *  utilities-layer rule can no longer bypass primitive ownership.
 *  Only print.css (print mirror, no live chrome) and tokens.css (custom
 *  properties only) stay outside the set. */
const CONTROLLED = [
  'global.css',
  'nav.css',
  'skeleton.css',
  'page-chrome.css',
  'overlays.css',
  'shared-chrome.css',
  'cards-ui.css',
  'data-table.css',
  'stepper.css',
  'dashboard-desk.css',
  'canvas-background.css',
  'desk-themes.css',
  ...DESK_WIDGET_STYLESHEETS,
  'cards.css',
  'source-skins.css',
  'landing.css',
  'explore.css',
  'collection.css',
  'profile.css',
  'dashboard.css',
  'graph.css',
  'sync.css',
  'write-approvals.css',
  'classify.css',
  'classification-batch.css',
  'extension.css',
  'pages-shared.css',
  'polish.css',
  'search.css',
  'library.css',
  'auth.css',
  'studio.css',
  'today.css',
  'collection-history.css',
  'reader.css',
  'reading.css',
  'path-reader.css',
  'library-health.css',
  'data-export.css',
  'import.css',
  'saved-resources.css',
  'collab.css',
  'share.css',
  'demos.css',
  'interactions.css',
  'utilities.css',
  'page-layouts.css',
  'resource-detail.css',
  'reports.css',
  'workbench-chrome.css',
]

/** Base selector -> owning file. */
const BASE_OWNERS: Record<string, string> = {
  '.btn': 'global.css',
  '.panel': 'global.css',
  '.field': 'global.css',
  '.search-field': 'global.css',
  '.chip': 'global.css',
  '.badge': 'global.css',
  '.read-mark': 'global.css',
  '.avatar': 'shared-chrome.css',
  '.view-switch': 'shared-chrome.css',
  '.lib-snippet': 'shared-chrome.css',
  '.result-card': 'cards-ui.css',
  '.result-row': 'cards-ui.css',
  '.data-table': 'data-table.css',
  '.stepper': 'stepper.css',
  '.tile': 'cards.css',
  '.auth-card': 'auth.css',
}

/**
 * Selectors that may also appear in a geometry/layout file. That file must
 * not declare chrome (see CHROME_PROPS / TILE_GEOMETRY_EXTRA).
 * R8-01 revoked the dual-file licenses for .tile / .tile-content /
 * .card-action / .collist-* — those bases are single-file definitions now.
 */
const LAYOUT_COOWNERS: Record<string, string[]> = {
  '.view-switch': ['collection.css'],
  '.summary': ['source-skins.css'],
}

/**
 * Patterns-layer feedback chrome co-ownership (R9-12). interactions.css owns
 * the hover-lift/press vocabulary (translateY lift, scale press, feedback
 * shadow/tint) painted on top of another file's primitive or state selector.
 * Each entry is selector -> { file, props }: the named file may declare ONLY
 * those chrome properties on that selector — anything further still fails,
 * and non-chrome layout/motion stays unrestricted. The owner files already
 * sanction the split (shared-chrome.css's header lists the
 * `.result-card--collection:hover .avatar` detail as interactions.css-owned).
 * Shrink-only: move feedback into the owner file to remove an entry; do not
 * add entries for new surfaces — declare them in the owner instead.
 */
const STATE_CHROME_EXEMPTIONS: Record<string, { file: string; props: string[] }> = {
  '.btn-primary:hover': { file: 'interactions.css', props: ['box-shadow'] },
  '.btn-primary:active': { file: 'interactions.css', props: ['box-shadow'] },
  '.btn-secondary:hover': { file: 'interactions.css', props: ['box-shadow'] },
  '.btn-secondary:active': { file: 'interactions.css', props: ['box-shadow'] },
  '.chip:hover': { file: 'interactions.css', props: ['background'] },
  '.result-card--collection:hover .avatar': { file: 'interactions.css', props: ['box-shadow'] },
}

/** Variant/state selectors that must stay in the same file as their base. */
const VARIANT_SELECTORS: Record<string, string[]> = {
  'global.css': [
    '.btn-primary',
    '.btn-secondary',
    '.btn-ghost',
    '.btn-danger',
    '.btn-danger-ghost',
    '.btn-sm',
    '.btn-lg',
    '.btn-primary:hover',
    '.btn-secondary:hover',
    '.btn-ghost:hover',
    '.btn-danger:hover',
    '.btn-danger-ghost:hover',
    '.btn-primary:disabled',
    '.btn-danger:disabled',
    '.btn-danger-ghost:disabled',
    '.btn.is-active',
    '.btn:focus-visible',
    '.btn::before',
    '.btn:hover::before',
    '.panel-raised',
    '.panel-pad',
    '.panel-pad.panel',
    '.field input:focus',
    '.field textarea:focus',
    '.field select:focus',
    '.search-field:hover:not(:focus-within)',
    '.search-field:focus-within',
    '.search-field input:focus',
    '.search-field input:focus-visible',
    '.search-field--compact',
    '.chip--label',
    '.chip--label:hover',
    '.chip--rail',
    '.chip--kind',
    '.chip--kind:hover',
    ".chip[aria-pressed='true']",
    '.badge--read',
    '.badge--note',
    '.badge--neutral',
    '.badge--muted',
    '.badge--success',
    '.badge--warning',
    '.badge--danger',
    '.badge--accent',
    '.badge svg',
    '.read-mark.is-active',
    /* R9-12: interaction-state selectors interactions.css paints on .btn /
       .chip — listed so the patterns layer's chrome on them is visible and
       licensed (STATE_CHROME_EXEMPTIONS), not silently uncontrolled. */
    '.btn:active',
    '.btn-primary:active',
    '.btn-secondary:active',
    '.btn-lg:hover',
    '.btn-lg:active',
    '.chip:hover',
    '.chip:active',
  ],
  'cards-ui.css': [
    '.result-card:hover',
    '.result-card:focus-visible',
    '.result-card.is-read',
    '.result-row:hover',
    '.result-row:focus-visible',
    '.result-row.is-read',
    '.result-row.is-unread',
    '.result-card--digest',
    '.result-card--digest:hover',
    '.result-card--collection',
    '.result-card--collection:hover',
    '.result-card--collection:focus-visible',
    '.result-card--tombstone',
    '.result-card--tombstone:hover',
    '.collection-card-body',
    '.summary',
    '.lib-link.is-expanded',
    '.lib-link.is-read',
    '.lib-link--compact .lib-link-hit h4',
    '.lib-link-hit:hover h4',
  ],
  'cards.css': ['.tile:hover', '.tile.is-selected', '.tile-content', '.card-action'],
  'widget-collection-list.css': [
    '.collist-meta',
    '.collist-title-row',
    '.collist-item--compact',
    '.collist-item--list',
    '.collist-item-title',
  ],
}

/** Minimal chrome each owner must declare in the base block. */
const REQUIRED_CHROME: Record<string, string[]> = {
  '.btn': ['display:', 'border-radius:', 'border:'],
  '.panel': ['border:', 'border-radius:', 'background:'],
  '.search-field': ['display:', 'border:', 'border-radius:', 'background:'],
  '.chip': ['display:', 'border-radius:', 'background:'],
  '.badge': ['display:', 'border-radius:', 'border:'],
  '.read-mark': ['display:', 'border:', 'background:'],
  '.avatar': ['display:', 'border-radius:', 'background:'],
  '.view-switch': ['display:', 'border:', 'border-radius:', 'background:'],
  '.lib-snippet': ['display:', 'border:', 'border-radius:'],
  '.result-card': ['border:', 'border-radius:', 'background:'],
  '.result-row': ['border-bottom:', 'padding:'],
  '.tile': ['border-color:', 'border-radius:', 'box-shadow:'],
  '.auth-card': ['border:', 'border-radius:', 'background-color:', 'box-shadow:'],
}

const CHROME_PROPS = ['border', 'border-color', 'border-radius', 'background', 'background-color', 'box-shadow']
/** .tile background counts as geometry: .tile-* skins and desk themes own the
 *  fill axis, so a descendant/descending rule may set it outside the owner. */
const TILE_GEOMETRY_EXTRA = new Set(['background'])
const MOTION_PROP_RE = /^(transform|translate|transition|animation|opacity)(-[a-z]+)?$/

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** All rule selectors of a stylesheet, split on top-level commas and normalized. */
function collectSelectors(source: string): Set<string> {
  const noComments = stripComments(source)
  const selectors = new Set<string>()
  const stack: string[] = [] // 'rule' | 'container' | 'skip'
  let buf = ''
  let i = 0
  const inSkip = () => stack.includes('skip')
  while (i < noComments.length) {
    const ch = noComments[i]
    if (ch === '{') {
      const header = buf.trim()
      buf = ''
      if (/^@(keyframes|-\w+-keyframes)\b/i.test(header)) {
        stack.push('skip')
      } else if (header.startsWith('@')) {
        stack.push('container')
      } else {
        if (!inSkip() && header && !header.startsWith('--')) {
          for (const sel of splitSelectors(header)) selectors.add(sel)
        }
        stack.push('rule')
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
  return selectors
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

/** (header, block) pairs for every plain rule of a stylesheet. */
function ruleBlocks(source: string): Array<{ header: string; block: string }> {
  const noComments = stripComments(source)
  const blocks: Array<{ header: string; block: string }> = []
  const stack: string[] = []
  let buf = ''
  let i = 0
  const inSkip = () => stack.includes('skip')
  while (i < noComments.length) {
    const ch = noComments[i]
    if (ch === '{') {
      const header = buf.trim()
      buf = ''
      if (/^@(keyframes|-\w+-keyframes)\b/i.test(header)) {
        stack.push('skip')
      } else if (header.startsWith('@')) {
        stack.push('container')
      } else {
        if (!inSkip() && header && !header.startsWith('--')) {
          const close = noComments.indexOf('}', i)
          const block = close === -1 ? '' : noComments.slice(i + 1, close)
          blocks.push({ header, block })
        }
        stack.push('rule')
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
  return blocks
}

/** Declaration block of the first rule whose selector list contains `selector`. */
function ruleBlock(source: string, selector: string): string | null {
  for (const { header, block } of ruleBlocks(source)) {
    if (splitSelectors(header).includes(selector)) return block
  }
  return null
}

function blocksFor(source: string, selector: string): string[] {
  return ruleBlocks(source)
    .filter(({ header }) => splitSelectors(header).includes(selector))
    .map(({ block }) => block)
}

function declaredProps(block: string): string[] {
  return [...block.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/gi)].map((m) => m[1]!.toLowerCase())
}

function chromePropsIn(block: string, selector: string): string[] {
  const extra = selector === '.tile' ? TILE_GEOMETRY_EXTRA : new Set<string>()
  return declaredProps(block).filter((p) => CHROME_PROPS.includes(p) && !extra.has(p))
}

function isMotionOnly(block: string): boolean {
  const props = declaredProps(block)
  return props.length > 0 && props.every((p) => MOTION_PROP_RE.test(p))
}

/** Chrome props on `sel` in `file` that no STATE_CHROME_EXEMPTIONS entry covers. */
function unlicensedChrome(sel: string, file: string, chrome: string[]): string[] {
  const exempt = STATE_CHROME_EXEMPTIONS[sel]
  if (!exempt || exempt.file !== file) return chrome
  return chrome.filter((p) => !exempt.props.includes(p))
}

function extraHolderOk(sel: string, file: string, source: string): string | null {
  const blocks = blocksFor(source, sel)
  if (blocks.length === 0) return `${sel} listed in ${file} but no block parsed`
  if (LAYOUT_COOWNERS[sel]?.includes(file)) {
    const chrome = blocks.flatMap((b) => chromePropsIn(b, sel))
    return chrome.length
      ? `${sel} in ${file} declares chrome (${chrome.join(', ')}) — geometry/layout only`
      : null
  }
  if (blocks.every(isMotionOnly)) return null
  const unlicensed = unlicensedChrome(
    sel,
    file,
    blocks.flatMap((b) => chromePropsIn(b, sel)),
  )
  return unlicensed.length
    ? `${sel} in ${file} is neither layout co-owner nor motion-only (unlicensed chrome: ${unlicensed.join(', ')})`
    : null
}

/** Last compound of a selector (combinators at depth 0). */
function lastCompound(selector: string): string {
  const s = selector.trim()
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === '(' || ch === '[') {
      depth += 1
      continue
    }
    if (ch === ')' || ch === ']') {
      depth -= 1
      continue
    }
    if (depth !== 0) continue
    if (ch === '>' || ch === '+' || ch === '~') {
      start = i + 1
      continue
    }
    if (ch === '|' && s[i + 1] === '|') {
      start = i + 2
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      let j = i + 1
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j += 1
      const next = s[j]
      if (next === '>' || next === '+' || next === '~' || (next === '|' && s[j + 1] === '|')) {
        i = j - 1
        continue
      }
      if (j < s.length) start = j
      i = j - 1
    }
  }
  return s.slice(start).trim()
}

function classTokens(compound: string): string[] {
  let flat = ''
  let depth = 0
  for (const ch of compound) {
    if (ch === '(' || ch === '[') {
      depth += 1
      continue
    }
    if (ch === ')' || ch === ']') {
      depth -= 1
      continue
    }
    if (depth === 0) flat += ch
  }
  return [...flat.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((m) => `.${m[1]}`)
}

function primitiveSubject(sel: string): string | null {
  return classTokens(lastCompound(sel)).find((t) => t in BASE_OWNERS) ?? null
}

/**
 * Descendant/sibling combinator rules whose last compound targets a
 * surface primitive and that declare CHROME_PROPS outside the owner.
 * `transition: border-color` does not count (property is transition).
 * `.tile` background is geometry (TILE_GEOMETRY_EXTRA).
 */
function descendantChromeViolations(src: Record<string, string>): string[] {
  const violations: string[] = []
  for (const file of CONTROLLED) {
    for (const { header, block } of ruleBlocks(src[file]!)) {
      for (const sel of splitSelectors(header)) {
        if (lastCompound(sel) === sel.trim()) continue
        const primitive = primitiveSubject(sel)
        if (!primitive) continue
        const owner = BASE_OWNERS[primitive]
        if (file === owner) continue
        const unlicensed = unlicensedChrome(sel, file, chromePropsIn(block, primitive))
        if (unlicensed.length === 0) continue
        violations.push(`${sel} in ${file} declares chrome (${unlicensed.join(', ')}) on ${primitive}`)
      }
    }
  }
  return violations
}

describe('CSS surface-primitive owners (C01)', () => {
  const sources = Object.fromEntries(
    CONTROLLED.map((f) => [f, readFileSync(resolve(stylesDir, f), 'utf8')]),
  )
  const selectors = Object.fromEntries(
    CONTROLLED.map((f) => [f, collectSelectors(sources[f]!)]),
  )

  it.each(Object.entries(BASE_OWNERS))(
    '%s chrome owner is %s (geometry/motion extras allowed)',
    (sel, owner) => {
      const holders = CONTROLLED.filter((f) => selectors[f]!.has(sel))
      expect(holders, `${sel} must be declared in its chrome owner`).toContain(owner)
      const extras: string[] = []
      for (const file of holders) {
        if (file === owner) continue
        const err = extraHolderOk(sel, file, sources[file]!)
        if (err) extras.push(err)
      }
      expect(extras).toEqual([])
    },
  )

  it('keeps variant/state chrome in their base owner file', () => {
    const violations: string[] = []
    for (const [file, sels] of Object.entries(VARIANT_SELECTORS)) {
      for (const sel of sels) {
        for (const other of CONTROLLED) {
          if (other === file) continue
          if (!selectors[other]!.has(sel)) continue
          const err = extraHolderOk(sel, other, sources[other]!)
          if (err) violations.push(err)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('declares the base chrome properties in each owner file', () => {
    for (const [sel, props] of Object.entries(REQUIRED_CHROME)) {
      const owner = BASE_OWNERS[sel]
      const block = ruleBlock(sources[owner!]!, sel)
      expect(block, `${sel} base block missing in ${owner}`).not.toBeNull()
      for (const prop of props) {
        expect(block, `${sel} in ${owner} must declare ${prop}`).toContain(prop)
      }
    }
  })

  it('keeps search-field inner inputs bare so the global focus ring cannot stack', () => {
    const focus = ruleBlock(sources['global.css']!, '.search-field input:focus-visible')
    expect(focus, 'search-field input:focus-visible must live in global.css').not.toBeNull()
    expect(focus).toContain('outline: none')
    expect(focus).toContain('box-shadow: none')
    expect(ruleBlock(sources['polish.css']!, '.explore-search:focus-within')).toBeNull()
  })

  it('does not let polish declare .btn chrome', () => {
    const blocks = blocksFor(sources['polish.css']!, '.btn')
    const chrome = blocks.flatMap((b) => chromePropsIn(b, '.btn'))
    expect(chrome, 'polish.css .btn must not set border/background/radius/shadow').toEqual([])
  })

  it('forbids descendant chrome on surface primitives outside the owner', () => {
    expect(descendantChromeViolations(sources)).toEqual([])
  })

  it('fails when a controlled file paints .btn chrome through a descendant selector', () => {
    const poisoned = {
      ...sources,
      'studio.css': `${sources['studio.css']}\n.x .btn { border-color: red; }\n`,
    }
    const hits = descendantChromeViolations(poisoned)
    expect(hits.join('\n')).toMatch(/\.x \.btn in studio\.css/)
  })

  it('ignores transition that mentions a chrome property on a descendant', () => {
    const motion = {
      ...sources,
      'studio.css': `${sources['studio.css']}\n.x .btn { transition: border-color var(--duration-fast); }\n`,
    }
    expect(descendantChromeViolations(motion)).toEqual([])
  })

  it('lets a non-owner set .tile background through a descendant (geometry extra)', () => {
    const extra = {
      ...sources,
      'dashboard.css': `${sources['dashboard.css']}\n.x .tile { background: red; }\n`,
    }
    expect(descendantChromeViolations(extra)).toEqual([])
  })
})
