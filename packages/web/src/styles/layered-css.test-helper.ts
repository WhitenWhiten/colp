/**
 * Layer-aware CSS cascade for tests.
 *
 * Production sheets are wrapped in `@layer`. happy-dom's CSS parser treats
 * `@layer` as an unknown at-rule and drops every rule inside it, so a Vite
 * CSS import (or a raw `<style>` of the source file) applies nothing.
 *
 * Unwrapping `@layer` without compensation is also wrong: it discards
 * layer rank, so a rule from a layer that outranks `pages` (patterns,
 * utilities, print, or unlayered CSS) could wrongly lose to a
 * higher-specificity components/pages selector. Flattening therefore
 * parses rules with their `@layer`, emits unlayered CSS, and marks
 * declarations on layers that outrank `pages` `!important` so they keep
 * their live priority.
 *
 * Layer-order authority: the `@layer` statement in tokens.css
 *   (`@layer tokens, base, components, pages, patterns, utilities, edition, print`).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const stylesDir = resolve(import.meta.dirname)

/** Single layer-order authority: the `@layer` statement in tokens.css; later entries win across layers. */
export const LAYER_ORDER = ['tokens', 'base', 'components', 'pages', 'patterns', 'utilities', 'edition', 'print'] as const

const PAGES_RANK = LAYER_ORDER.indexOf('pages')

export type MediaQuery = { min?: number; max?: number }

export type LayeredCssRule = {
  layer: string | null
  media: MediaQuery | null
  selector: string
  body: string
}

export function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseMedia(header: string): MediaQuery | null {
  if (!header.startsWith('@media')) return null
  const min = header.match(/min-width:\s*(\d+)px/)
  const max = header.match(/max-width:\s*(\d+)px/)
  return {
    min: min ? Number(min[1]) : undefined,
    max: max ? Number(max[1]) : undefined,
  }
}

export function mediaMatches(query: MediaQuery | null, width: number): boolean {
  if (!query) return true
  if (query.min != null && width < query.min) return false
  if (query.max != null && width > query.max) return false
  return true
}

type Frame = { kind: 'media' | 'layer' | 'other'; media: MediaQuery | null; layer: string | null }

function currentMedia(stack: Frame[]): MediaQuery | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]!.kind === 'media') return stack[i]!.media
  }
  return null
}

function currentLayer(stack: Frame[]): string | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]!.kind === 'layer') return stack[i]!.layer
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

/** Top-level, `@media`, and `@layer` rules, source order, comments stripped. */
export function collectLayeredRules(source: string): LayeredCssRule[] {
  const text = stripComments(source)
  const rules: LayeredCssRule[] = []
  const stack: Frame[] = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const header = buf.trim()
      buf = ''
      if (/^@(keyframes|-\w+-keyframes)\b/i.test(header)) {
        stack.push({ kind: 'other', media: currentMedia(stack), layer: currentLayer(stack) })
      } else if (header.startsWith('@media')) {
        stack.push({ kind: 'media', media: parseMedia(header), layer: currentLayer(stack) })
      } else if (header.startsWith('@')) {
        const layerName = header.match(/^@layer\s+([\w-]+)$/)
        stack.push({
          kind: layerName ? 'layer' : 'other',
          media: currentMedia(stack),
          layer: layerName ? layerName[1] ?? null : currentLayer(stack),
        })
      } else {
        const close = matchingClose(text, i)
        const body = close === -1 ? '' : text.slice(i + 1, close)
        if (header && !header.startsWith('--')) {
          for (const selector of splitSelectors(header)) {
            rules.push({
              media: currentMedia(stack),
              layer: currentLayer(stack),
              selector,
              body,
            })
          }
        }
        stack.push({ kind: 'other', media: currentMedia(stack), layer: currentLayer(stack) })
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

function layerRank(layer: string | null): number {
  if (layer == null) return LAYER_ORDER.length + 1
  const rank = LAYER_ORDER.indexOf(layer as (typeof LAYER_ORDER)[number])
  return rank === -1 ? -1 : rank
}

function specificityScore(selector: string): number {
  const ids = selector.match(/#[a-zA-Z0-9_-]+/g)?.length ?? 0
  const classes = selector.match(/\.[a-zA-Z0-9_-]+/g)?.length ?? 0
  // Attribute selectors ([class*='tile-theme-'], [aria-pressed]) are
  // class-level specificity — counting them keeps theme rules (0,2,0) ahead
  // of single-class widget rules instead of falling back to source order.
  const attrs = selector.match(/\[[^\]]*\]/g)?.length ?? 0
  return ids * 1_000_000 + (classes + attrs) * 1_000
}

function declarationValue(body: string, property: string): string | null {
  const escaped = property.replace(/-/g, '\\-')
  const match = body.match(new RegExp(`(?<![a-z-])${escaped}\\s*:\\s*([^;}{]+)`, 'i'))
  if (!match) return null
  return match[1]!.replace(/!important/i, '').trim()
}

export function winningDeclaredProperty(
  rules: LayeredCssRule[],
  property: string,
  options: {
    matches: (selector: string) => boolean
    width?: number
  },
): { value: string; layer: string | null; selector: string } | null {
  const width = options.width ?? 1280
  let winner: {
    value: string
    layer: string | null
    selector: string
    rank: number
    spec: number
    order: number
  } | null = null

  for (const [order, rule] of rules.entries()) {
    if (!options.matches(rule.selector)) continue
    if (!mediaMatches(rule.media, width)) continue
    const value = declarationValue(rule.body, property)
    if (value == null) continue
    const rank = layerRank(rule.layer)
    const spec = specificityScore(rule.selector)
    if (
      !winner ||
      rank > winner.rank ||
      (rank === winner.rank && spec > winner.spec) ||
      (rank === winner.rank && spec === winner.spec && order > winner.order)
    ) {
      winner = { value, layer: rule.layer, selector: rule.selector, rank, spec, order }
    }
  }

  return winner ? { value: winner.value, layer: winner.layer, selector: winner.selector } : null
}

function beatsPagesLayer(layer: string | null): boolean {
  return layerRank(layer) > PAGES_RANK
}

/** Mark every custom-property-free declaration `!important` (layer compensation). */
function importantizeDeclarations(body: string): string {
  return body.replace(/(?<![a-z-])([a-z-]+)\s*:\s*([^;}{]+)/gi, (full, prop: string, value: string) => {
    if (prop.startsWith('--')) return full
    if (/\bimportant\b/i.test(value)) return full
    return `${prop}: ${value.trim()} !important`
  })
}

function mediaWrap(media: MediaQuery | null, css: string): string {
  if (!media || (media.min == null && media.max == null)) return css
  const parts: string[] = []
  if (media.min != null) parts.push(`(min-width: ${media.min}px)`)
  if (media.max != null) parts.push(`(max-width: ${media.max}px)`)
  return `@media ${parts.join(' and ')} { ${css} }`
}

/**
 * Flatten every selector (not just `.tile`) with layer compensation.
 * Declarations from layers that outrank `pages` (patterns/utilities/print,
 * plus unlayered CSS) become `!important` so happy-dom — which drops
 * `@layer` — still gives them their live priority over components/pages.
 */
export function flattenAllLayeredCssForHappyDom(sources: string[]): string {
  const rules = sources.flatMap((source) => collectLayeredRules(source))
  const chunks: string[] = []
  for (const rule of rules) {
    const body = beatsPagesLayer(rule.layer) ? importantizeDeclarations(rule.body) : rule.body
    chunks.push(mediaWrap(rule.media, `${rule.selector} { ${body} }`))
  }
  return chunks.join('\n')
}
