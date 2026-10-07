import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P1-02 / R11-06: mobile tab bar height token and stacking offsets.
 *
 * `--bottom-nav-h` is declared in tokens.css (0px on desktop). The four
 * sticky/fixed bottoms that share the home-indicator edge must mention
 * the token inside their `max-width: 719px` rules — except search, whose
 * fullscreen palette covers the tab bar at `--z-modal`.
 */

const stylesDir = resolve(import.meta.dirname)

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function mediaMax719(source: string): string {
  const text = stripComments(source)
  const blocks: string[] = []
  const re = /@media\s*\(\s*max-width:\s*719px\s*\)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length
    let depth = 1
    let i = start
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') depth -= 1
      i += 1
    }
    blocks.push(text.slice(start, i - 1))
  }
  return blocks.join('\n')
}

function ruleBody(block: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  const match = block.match(re)
  return match?.[1] ?? null
}

describe('bottom-nav stacking token (P1-02 / R11-06)', () => {
  const tokens = readStyle('tokens.css')
  const cssFiles = readdirSync(stylesDir).filter((file) => file.endsWith('.css'))

  it('declares --bottom-nav-h in tokens.css as 0px by default', () => {
    expect(tokens).toContain('--bottom-nav-h: 0px')
  })

  it('does not leave env(safe-area-inset- in the --bottom-nav-h definition', () => {
    const def = tokens.match(/--bottom-nav-h:\s*([^;]+);/)
    expect(def?.[1]).toBe('0px')
  })

  it('references --bottom-nav-h in the max-width 719px bulkbar, toast, canvas-toast, and scroll-to-top rules', () => {
    const bulkbar = ruleBody(mediaMax719(readStyle('library.css')), '.library-bulkbar')
    const toast = ruleBody(mediaMax719(readStyle('overlays.css')), '.app-shell--tabs .toast')
    const canvas = ruleBody(mediaMax719(readStyle('cards.css')), '.app-shell--tabs .canvas-toast')
    const scrollTop = ruleBody(mediaMax719(readStyle('polish.css')), '.app-shell--tabs .scroll-to-top-btn')
    expect(bulkbar, 'library-bulkbar @ 719px').toMatch(/--bottom-nav-h/)
    expect(toast, 'toast @ 719px').toMatch(/--bottom-nav-h/)
    expect(canvas, 'canvas-toast @ 719px').toMatch(/--bottom-nav-h/)
    expect(scrollTop, 'scroll-to-top @ 719px').toMatch(/--bottom-nav-h/)
  })

  it('leaves search-results padding on --safe-bottom only (palette covers the tab bar)', () => {
    const search = stripComments(readStyle('search.css'))
    expect(search).toMatch(/\.search-results[\s\S]*padding-bottom:\s*calc\(var\(--space-2\) \+ var\(--safe-bottom\)\)/)
    expect(search).not.toMatch(/\.search-results[\s\S]{0,200}--bottom-nav-h/)
  })

  it('fades tab color on the shared --duration-fast clock', () => {
    const item = stripComments(readStyle('nav.css'))
    expect(item).toMatch(/\.bottom-nav-item\s*\{[^}]*transition:[^}]*var\(--duration-fast\)/)
  })

  it('is referenced from at least one stylesheet besides tokens.css', () => {
    const others = cssFiles.filter((file) => file !== 'tokens.css')
      .filter((file) => readStyle(file).includes('--bottom-nav-h'))
    expect(others.length).toBeGreaterThan(0)
  })
})
