import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P0-03 / R11-04: device safe-area insets are tokens.
 *
 * `env(safe-area-inset-*)` may only appear as the four `--safe-*`
 * definitions in tokens.css. Call sites must use `var(--safe-top)`,
 * `var(--safe-right)`, `var(--safe-bottom)`, or `var(--safe-left)`.
 */

const stylesDir = resolve(import.meta.dirname)

const SAFE_TOKENS = [
  '--safe-top',
  '--safe-right',
  '--safe-bottom',
  '--safe-left',
] as const

const TOKEN_DEFS = [
  '--safe-top: env(safe-area-inset-top, 0px)',
  '--safe-right: env(safe-area-inset-right, 0px)',
  '--safe-bottom: env(safe-area-inset-bottom, 0px)',
  '--safe-left: env(safe-area-inset-left, 0px)',
] as const

describe('safe-area inset tokens (P0-03 / R11-04)', () => {
  const cssFiles = readdirSync(stylesDir).filter((file) => file.endsWith('.css'))
  const tokens = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')

  it('defines --safe-top/right/bottom/left in tokens.css', () => {
    for (const name of SAFE_TOKENS) {
      expect(tokens, `${name} must be declared in tokens.css`).toContain(`${name}:`)
    }
  })

  it('tokens.css uses env(safe-area-inset- only in the four --safe-* definitions', () => {
    const hits = [...tokens.matchAll(/env\(safe-area-inset-/g)]
    expect(
      hits,
      'only the four --safe-* token definitions may call env(safe-area-inset-*)',
    ).toHaveLength(4)
    for (const def of TOKEN_DEFS) {
      expect(tokens).toContain(def)
    }
  })

  it('no stylesheet outside tokens.css contains env(safe-area-inset-', () => {
    const offenders: string[] = []
    for (const file of cssFiles) {
      if (file === 'tokens.css') continue
      const source = readFileSync(resolve(stylesDir, file), 'utf8')
      if (source.includes('env(safe-area-inset-')) offenders.push(file)
    }
    expect(offenders, 'replace env(safe-area-inset-*) with var(--safe-*)').toEqual([])
  })
})
