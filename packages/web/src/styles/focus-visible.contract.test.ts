import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * R15-17: a :focus-visible rule may drop the outline only when another,
 * stronger cue takes over (an ink border on a wrapper, a stroke, a ::before
 * line). A halo alone (box-shadow at ~1.2:1) is not a visible focus
 * indicator. Each allowed removal names the rule that carries its cue, and
 * that rule must still set the cue property.
 */

const stylesDir = resolve(import.meta.dirname)

type Rule = { file: string; selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = []
  for (const file of readdirSync(stylesDir).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(resolve(stylesDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      out.push({ file, selector: match[1]!.replace(/\s+/gu, ' ').trim(), body: match[2]! })
    }
  }
  return out
}

/** Outline removals and the rule that carries their focus cue instead. */
const DELEGATED: Record<string, { cue: string; property: RegExp }> = {
  // Mouse focus only: keyboard focus keeps the global ring.
  ':focus:not(:focus-visible)': { cue: ':focus-visible', property: /outline\s*:/u },
  '.search-field input:focus, .search-field input:focus-visible': { cue: '.search-field:focus-within', property: /border-color\s*:/u },
  '.community-comments-input:focus, .community-comments-input:focus-visible': { cue: '.community-composer:focus-within', property: /border-color\s*:/u },
  '.graph-node:focus-visible': { cue: '.graph-node:focus-visible circle.graph-dot', property: /stroke\s*:/u },
  '.select-menu-btn:focus-visible': { cue: '.select-menu:has(select:focus-visible)', property: /border-color\s*:/u },
  '.search-palette-head input:focus, .search-palette-head input:focus-visible': { cue: '.search-palette:focus-within', property: /border-color\s*:/u },
  '.desk-search-field input:focus, .desk-search-field input:focus-visible': { cue: '.desk-search-field:focus-within', property: /border-color\s*:/u },
  '.folder-gallery-link:focus-visible': { cue: '.folder-gallery-card:has(.folder-gallery-link:focus-visible)', property: /outline\s*:/u },
}

describe('focus-visible outline removals', () => {
  const all = rules()

  it('only drop the outline where another rule carries a strong cue', () => {
    const removals = all.filter((rule) => rule.selector.includes(':focus-visible')
      && /outline\s*:\s*(?:none|0)\b/u.test(rule.body))
    // Non-vacuity: the scan does see the known delegated removals.
    expect(removals.length).toBeGreaterThanOrEqual(5)
    const undelegated = removals
      .filter((rule) => !(rule.selector in DELEGATED))
      .map((rule) => `${rule.file}: ${rule.selector}`)
    expect(undelegated, 'name the rule that carries the focus cue in DELEGATED').toEqual([])
    for (const rule of removals) {
      const { cue, property } = DELEGATED[rule.selector]!
      const carrier = all.find((candidate) => candidate.selector === cue && property.test(candidate.body))
      expect(carrier, `${rule.selector} delegates to ${cue}`).toBeDefined()
    }
  })

  it('keeps the global ink outline on checkboxes, radios and comment chips', () => {
    for (const selector of [
      ":where(input[type='checkbox'], input[type='radio']):focus-visible",
      '.community-comment-action:focus-visible',
    ]) {
      const rule = all.find((candidate) => candidate.selector === selector)
      expect(rule, selector).toBeDefined()
      expect(rule!.body, selector).not.toMatch(/outline\s*:\s*(?:none|0)\b/u)
    }
  })
})
