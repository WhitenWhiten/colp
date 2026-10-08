import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Semantic text tokens must stay AA on the surfaces they sit on.
 * Desk themes (ink / mist) re-scope --faint locally; this test parses
 * those blocks and the :root ladder so a quiet contrast drop cannot ship.
 */

const stylesDir = resolve(import.meta.dirname)

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function srgbChannel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b)
}

function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(...fg)
  const l2 = relativeLuminance(...bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function parseRgb(value: string): [number, number, number] | null {
  const match = value.trim().match(/^rgb\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\)$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function tokenMap(block: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1]!, match[2]!.trim())
  }
  return map
}

function ruleBody(source: string, selector: string): string {
  const text = stripComments(source)
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`)
  const hit = re.exec(text)
  if (!hit) throw new Error(`missing ${selector}`)
  let depth = 1
  let i = hit.index + hit[0].length
  const start = i
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') depth -= 1
    i += 1
  }
  return text.slice(start, i - 1)
}

const AA = 4.5

describe('semantic faint contrast (WCAG AA)', () => {
  const tokens = readStyle('tokens.css')
  const themes = readStyle('desk-themes.css')

  const palettes: Array<{ name: string; tokens: Map<string, string> }> = [
    { name: ':root', tokens: tokenMap(ruleBody(tokens, ':root')) },
    { name: '.tile-theme-ink', tokens: tokenMap(ruleBody(themes, '.tile-theme-ink')) },
    { name: '.tile-theme-mist', tokens: tokenMap(ruleBody(themes, '.tile-theme-mist')) },
  ]

  it.each(palettes)('$name --faint is ≥4.5:1 on --surface and --paper', ({ tokens: map }) => {
    const faint = parseRgb(map.get('faint') ?? '')
    const surface = parseRgb(map.get('surface') ?? '')
    const paper = parseRgb(map.get('paper') ?? '')
    expect(faint, `${map.get('faint')} must be rgb() --faint`).not.toBeNull()
    expect(surface, 'theme must declare rgb() --surface').not.toBeNull()
    expect(paper, 'theme must declare rgb() --paper').not.toBeNull()
    expect(contrastRatio(faint!, surface!), '--faint on --surface').toBeGreaterThanOrEqual(AA)
    expect(contrastRatio(faint!, paper!), '--faint on --paper').toBeGreaterThanOrEqual(AA)
  })
})

/* R15-43: non-text contrast (1.4.11) for form-control boundaries and the
   switch's state, from the real :root tokens. */
describe('control boundary contrast (WCAG 1.4.11)', () => {
  const root = tokenMap(ruleBody(readStyle('tokens.css'), ':root'))
  const rgb = (name: string) => {
    const value = parseRgb(root.get(name) ?? '')
    if (!value) throw new Error(`--${name} must be an opaque rgb() token`)
    return value
  }
  /** --line-control is translucent ink; blend it onto the surface under it. */
  function blendedControlLine(onto: [number, number, number]): [number, number, number] {
    const match = (root.get('line-control') ?? '').match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/)
    if (!match) throw new Error('--line-control must be rgb(r g b / a)')
    const alpha = Number(match[4])
    return [1, 2, 3].map((i) => Number(match[i]) * alpha + onto[i - 1]! * (1 - alpha)) as [number, number, number]
  }

  it.each(['surface', 'paper', 'paper-2'])('--line-control is ≥3:1 on --%s', (surface) => {
    const bg = rgb(surface)
    expect(contrastRatio(blendedControlLine(bg), bg)).toBeGreaterThanOrEqual(3)
  })

  it('the switch OFF thumb (--ink-3) is ≥3:1 on its track (--paper-2)', () => {
    expect(contrastRatio(rgb('ink-3'), rgb('paper-2'))).toBeGreaterThanOrEqual(3)
    const toggle = stripComments(readStyle('workbench-chrome.css'))
    expect(toggle).toMatch(/\.toggle::after\s*\{[^}]*background:\s*var\(--ink-3\)/u)
    expect(toggle).toMatch(/\.toggle\s*\{[^}]*border:\s*1px solid var\(--line-control\)/u)
  })
})
