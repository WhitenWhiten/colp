// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESK_WIDGET_STYLESHEETS,
  collectLayeredRules,
  flattenAllLayeredCssForHappyDom,
  readStyle,
  winningDeclaredProperty,
  type LayeredCssRule,
} from './dashboard-stack-cascade.test-helper'

/**
 * Desk-widget tile skins live in the widget-*.css chapters (R8-01, one file
 * per widget); library row chrome lives in cards-ui.css.
 * happy-dom drops `@layer`, so winners are scored with collectLayeredRules
 * (layer rank, later-same-layer wins). Flattened CSS is injected for
 * getComputedStyle. happy-dom also drops `color-mix()` and `linear-gradient`
 * that still contain `var()`, so gradient/accent fills are asserted on the
 * flatten text; SSH `--ssh-head` and compact typography do compute.
 *
 * File order matches src/main.tsx + pages/Dashboard.tsx: cards.css,
 * source-skins.css, library.css, cards-ui.css, desk-themes.css,
 * dashboard-desk.css, widget-*.css.
 */

const CASCADE_FILES = ['cards.css', 'source-skins.css', 'library.css', 'cards-ui.css', 'desk-themes.css', 'dashboard-desk.css', ...DESK_WIDGET_STYLESHEETS] as const
const STYLE_ID = 'card-skin-cascade-happy-dom'
const TOOL_HEAD_MIX = 'color-mix(in srgb, var(--ink) 4%, var(--surface))'

/** Tokens happy-dom needs to resolve compact title type (tokens.css is not in this sheet). */
const COMPUTED_TOKEN_STUB = `:root { --weight-semibold: 600; --weight-bold: 700; --text-md: 1rem; }`

function loadSkinCascadeRules(): LayeredCssRule[] {
  return CASCADE_FILES.flatMap((file) => collectLayeredRules(readStyle(file)))
}

function restSelector(selector: string): boolean {
  return !/:(hover|focus|active|focus-visible|disabled)/.test(selector)
}

/* R10-26: widget-intrinsic skins are registered tile themes — a weather /
   sticky / ssh element carries `.tile-X tile-theme-{wash,terminal}`, so
   the skin selectors are matched alongside the tile class. */
function appliesToSticky(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && (s === '.tile' || s === '.tile-sticky' || s === '.tile.tile-theme-wash' || s === ".tile[class*='tile-theme-']")
}

function appliesToWeather(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && (s === '.tile' || s === '.tile-weather' || s === '.tile.tile-theme-wash' || s === ".tile[class*='tile-theme-']")
}

function appliesToSshHead(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && (s === '.card-head' || s === '.tile.tile-theme-terminal .card-head' || s === ".tile[class*='tile-theme-'] .card-head")
}

function appliesToExpandedLink(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && (s === '.lib-link' || s === '.lib-link.is-expanded')
}

function appliesToCompactLink(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && (s === '.lib-link' || s === '.lib-link--compact')
}

function appliesToCompactTitle(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && (s === '.lib-link-hit h4' || s === '.lib-link--compact .lib-link-hit h4')
}

function appliesToStandardTileContent(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && s === '.tile-content'
}

function appliesToFillTileContent(selector: string): boolean {
  const s = selector.replace(/\s+/g, ' ').trim()
  return restSelector(s) && s === '.tile-content--fill'
}

const STANDARD_TILE_CONTENT_PADDING = 'var(--hair-85) var(--hair-90) 2.1rem'

function paddingShorthand(body: string): string | null {
  const match = body.match(/(?<![a-z-])padding\s*:\s*([^;}{]+)/i)
  return match ? match[1]!.replace(/!important/i, '').trim() : null
}

/** Inner CSS of the first `@container tile (min-width: 20rem)` block. */
function wideTileContainerBody(source: string): string | null {
  const header = source.match(/@container\s+tile\s*\(min-width:\s*20rem\)\s*\{/)
  if (!header || header.index == null) return null
  const open = header.index + header[0].length - 1
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return null
}

function flattenedSkinCss(): string {
  return flattenAllLayeredCssForHappyDom(CASCADE_FILES.map((file) => readStyle(file)))
}

function injectFlattenedCascade(): string {
  document.getElementById(STYLE_ID)?.remove()
  const css = `${COMPUTED_TOKEN_STUB}\n${flattenedSkinCss()}`
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
  return css
}

/** Last unlayered block for an exact selector in flatten output (later-same-layer). */
function lastFlattenBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped} \\{([\\s\\S]*?)\\n\\s*\\}`, 'g')
  let last: string | null = null
  for (const match of css.matchAll(re)) last = match[1] ?? null
  return last
}

describe('card / library skin cascade winners', () => {
  const rules = loadSkinCascadeRules()

  it('keeps the sticky hero gradient on the shared wash theme (R10-26)', () => {
    const winner = winningDeclaredProperty(rules, 'background', { matches: appliesToSticky })
    expect(winner, '.tile.tile-theme-wash must declare a background').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.tile.tile-theme-wash')
    expect(winner!.value).toMatch(/linear-gradient/)
    expect(winner!.value).not.toBe('var(--surface)')
  })

  it('keeps the weather hero gradient on the shared wash theme (R10-26)', () => {
    const winner = winningDeclaredProperty(rules, 'background', { matches: appliesToWeather })
    expect(winner, '.tile.tile-theme-wash must declare a background').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.tile.tile-theme-wash')
    expect(winner!.value).toMatch(/linear-gradient/)
    expect(winner!.value).not.toBe('var(--surface)')
  })

  it('keeps the SSH header on --ssh-head via the terminal theme, not the generic tool-head mix', () => {
    const winner = winningDeclaredProperty(rules, 'background', { matches: appliesToSshHead })
    expect(winner, '.tile.tile-theme-terminal .card-head must declare a background').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.tile.tile-theme-terminal .card-head')
    expect(winner!.value).toBe('var(--ssh-head)')
    expect(winner!.value).not.toBe(TOOL_HEAD_MIX)
  })

  it('paints expanded library rows with the accent mix from components', () => {
    const winner = winningDeclaredProperty(rules, 'background', { matches: appliesToExpandedLink })
    expect(winner, '.lib-link.is-expanded must declare a background').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.lib-link.is-expanded')
    expect(winner!.value).toMatch(/var\(--accent\)/)
    expect(winner!.value).not.toBe('var(--surface)')
  })

  it('lets compact titles override base .lib-link-hit h4 typography', () => {
    const weight = winningDeclaredProperty(rules, 'font-weight', { matches: appliesToCompactTitle })
    expect(weight?.selector).toBe('.lib-link--compact .lib-link-hit h4')
    expect(weight?.layer).toBe('components')
    expect(weight?.value).toBe('var(--weight-semibold)')
  })

  it('lets compact rows drop the base .lib-link surface fill', () => {
    const winner = winningDeclaredProperty(rules, 'background', { matches: appliesToCompactLink })
    expect(winner, '.lib-link--compact must declare a background').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.lib-link--compact')
    expect(winner!.value).toBe('transparent')
    expect(winner!.value).not.toBe('var(--surface)')
  })

  /* Post-R10-26 boundary: widget tile skins are registered themes
     (desk-themes.css) — they must not leak back into cards-ui.css or the
     widget-*.css chapters. */
  it('does not let cards-ui.css or widget chapters re-declare the widget skins', () => {
    const ui = collectLayeredRules(readStyle('cards-ui.css'))
    const stickyFill = ui.filter((rule) => rule.selector === '.tile-sticky' && /background\s*:/.test(rule.body))
    const weatherFill = ui.filter((rule) => rule.selector === '.tile-weather' && /background\s*:/.test(rule.body))
    const sshHead = ui.filter((rule) => rule.selector === '.tile-ssh .card-head' && /background\s*:/.test(rule.body))
    expect(stickyFill).toEqual([])
    expect(weatherFill).toEqual([])
    expect(sshHead).toEqual([])

    for (const file of DESK_WIDGET_STYLESHEETS) {
      const chapter = collectLayeredRules(readStyle(file))
      const widgetHeadCopies = chapter.filter((rule) =>
        /^\.tile-[a-z]+ \.card-head$/.test(rule.selector) && rule.body.includes(TOOL_HEAD_MIX))
      expect(widgetHeadCopies, `${file} must not copy the shared card-head tint`).toEqual([])
    }
  })

  it('keeps standard .tile-content padding at the old cards-ui density', () => {
    const winner = winningDeclaredProperty(rules, 'padding', { matches: appliesToStandardTileContent })
    expect(winner, '.tile-content must declare padding').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.tile-content')
    expect(winner!.value).toBe(STANDARD_TILE_CONTENT_PADDING)
  })

  it('does not let @container tile (min-width: 20rem) re-loosen .tile-content padding', () => {
    const inner = wideTileContainerBody(readStyle('source-skins.css'))
    expect(inner, '@container tile (min-width: 20rem) must exist in source-skins.css').toBeTruthy()
    const paddings = collectLayeredRules(inner!)
      .filter((rule) => rule.selector === '.tile-content')
      .map((rule) => paddingShorthand(rule.body))
      .filter((value): value is string => value != null)
    expect(paddings.every((value) => value === STANDARD_TILE_CONTENT_PADDING)).toBe(true)
  })

  it('keeps .tile-content--fill padding at 0', () => {
    const winner = winningDeclaredProperty(rules, 'padding', { matches: appliesToFillTileContent })
    expect(winner, '.tile-content--fill must declare padding').toBeTruthy()
    expect(winner!.layer).toBe('components')
    expect(winner!.selector).toBe('.tile-content--fill')
    expect(winner!.value).toBe('0')
  })

  it('does not let cards-ui.css declare .tile-content padding', () => {
    const ui = collectLayeredRules(readStyle('cards-ui.css'))
    const padded = ui.filter(
      (rule) => rule.selector === '.tile-content' && paddingShorthand(rule.body) != null,
    )
    expect(padded).toEqual([])
  })
})

describe('card / library skins via flattened getComputedStyle', () => {
  afterEach(() => {
    document.getElementById(STYLE_ID)?.remove()
    document.body.replaceChildren()
  })

  it('computes SSH dark chrome and compact title type after flatten', () => {
    const css = injectFlattenedCascade()

    expect(lastFlattenBody(css, '.tile.tile-theme-wash')).toMatch(/linear-gradient/)
    expect(lastFlattenBody(css, '.tile.tile-theme-terminal .card-head')).toMatch(/var\(--ssh-head\)/)
    expect(lastFlattenBody(css, '.lib-link.is-expanded')).toMatch(/var\(--accent\)/)
    expect(lastFlattenBody(css, '.lib-link.is-expanded')).not.toMatch(/background:\s*var\(--surface\)/)
    expect(lastFlattenBody(css, '.lib-link--compact')).toMatch(/background:\s*transparent/)

    const sticky = document.createElement('div')
    sticky.className = 'tile tile-sticky tile-theme-wash'
    const ssh = document.createElement('div')
    ssh.className = 'tile tile-ssh tile-theme-terminal'
    const sshHead = document.createElement('div')
    sshHead.className = 'card-head'
    ssh.append(sshHead)
    const compact = document.createElement('div')
    compact.className = 'lib-link lib-link--compact'
    const compactHit = document.createElement('a')
    compactHit.className = 'lib-link-hit'
    const compactTitle = document.createElement('h4')
    compactHit.append(compactTitle)
    compact.append(compactHit)
    const comfort = document.createElement('div')
    comfort.className = 'lib-link'
    const comfortHit = document.createElement('a')
    comfortHit.className = 'lib-link-hit'
    const comfortTitle = document.createElement('h4')
    comfortHit.append(comfortTitle)
    comfort.append(comfortHit)
    document.body.append(sticky, ssh, compact, comfort)

    expect(getComputedStyle(sticky).position).toBe('absolute')
    expect(getComputedStyle(sshHead).backgroundColor).toBe('rgb(20 22 26)')
    expect(getComputedStyle(compact).backgroundColor).toBe('transparent')
    expect(getComputedStyle(compactTitle).fontWeight).toBe('600')
    // line-height is token-referenced (R9-06); happy-dom leaves var() in
    // line-height unresolved, so assert the declaration on the flat text.
    expect(lastFlattenBody(css, '.lib-link--compact .lib-link-hit h4')).toMatch(/line-height:\s*var\(--leading-clamp\)/)
    expect(getComputedStyle(comfortTitle).fontWeight).toBe('700')
    // Line-start anchor: '.lib-link-hit h4' must not suffix-match
    // '.lib-link--compact .lib-link-hit h4'.
    const baseTitleBody = css.match(/(?:^|\n)\s*\.lib-link-hit h4 \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
    expect(baseTitleBody).toMatch(/line-height:\s*var\(--leading-ui\)/)
  })
})
