import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Elevation vocabulary (tokens.css): stacking above page flow goes through
 * `--z-*`, halos through `--shadow-ring*`, lifts and popovers through the
 * shadow ladder. This test turns the written policy into a gate:
 *
 * - numeric `z-index` is allowed only for local in-component layering
 *   (-1 … 20); anything higher must be a `--z-*` token, except the one
 *   registered `.tile.is-moving/.is-resizing` escape (150 !important).
 * - literal ring shadows (`0 0 0 Npx …`) and the `0 2px 8px` lift may not
 *   reappear outside tokens.css; the remaining literal shadows are counted
 *   and ratcheted so the debt can only shrink.
 */

const stylesDir = resolve(import.meta.dirname)
const files = readdirSync(stylesDir).filter((name) => name.endsWith('.css'))

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

const Z_INDEX_LOCAL_MAX = 20
const Z_INDEX_REGISTERED_EXCEPTIONS: Record<string, number[]> = {
  'cards.css': [150],
}

/** Literal box-shadow declarations outside tokens.css and the theme re-scopes. */
const LITERAL_SHADOW_BUDGET = 22

describe('elevation vocabulary', () => {
  it('keeps numeric z-index to local layering; floating chrome uses --z-* tokens', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file === 'tokens.css') continue
      const source = stripComments(readFileSync(resolve(stylesDir, file), 'utf8'))
      for (const match of source.matchAll(/z-index:\s*(-?\d+)/g)) {
        const value = Number(match[1])
        if (value >= -1 && value <= Z_INDEX_LOCAL_MAX) continue
        if (Z_INDEX_REGISTERED_EXCEPTIONS[file]?.includes(value)) continue
        offenders.push(`${file}: z-index: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never redeclares a ring or lift halo as a literal outside tokens.css', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file === 'tokens.css') continue
      const source = stripComments(readFileSync(resolve(stylesDir, file), 'utf8'))
      for (const match of source.matchAll(/box-shadow:\s*([^;{}]+);/g)) {
        const value = match[1]!.replace(/\s+/g, ' ').trim()
        if (/^0 0 0 [23]px color-mix\(in srgb, var\(--(ink|accent)\)/.test(value)) offenders.push(`${file}: ${value}`)
        if (/^0 2px 8px /.test(value)) offenders.push(`${file}: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('ratchets the remaining literal box-shadow declarations downward', () => {
    let count = 0
    const seen: string[] = []
    for (const file of files) {
      if (file === 'tokens.css' || file === 'desk-themes.css') continue
      const source = stripComments(readFileSync(resolve(stylesDir, file), 'utf8'))
      for (const match of source.matchAll(/box-shadow:\s*([^;{}]+);/g)) {
        const value = match[1]!.replace(/\s+/g, ' ').trim()
        if (/^(none|inherit|unset|initial)$/.test(value)) continue
        if (/^var\(--[a-z-]+\)(,\s*var\(--[a-z-]+\))*$/.test(value)) continue
        count += 1
        seen.push(`${file}: ${value}`)
      }
    }
    expect(count, `literal box-shadow declarations:\n${seen.join('\n')}`).toBeLessThanOrEqual(LITERAL_SHADOW_BUDGET)
  })
})
