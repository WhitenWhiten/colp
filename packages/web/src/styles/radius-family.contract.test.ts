import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesDir = resolve(import.meta.dirname)

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('result-card radius family', () => {
  it('keeps .result-card on the shared radius token', () => {
    const css = stripComments(readFileSync(resolve(stylesDir, 'cards-ui.css'), 'utf8'))
    const base = css.match(/\.result-card\s*\{[^}]*border-radius:\s*([^;]+)/)
    expect(base?.[1]?.trim()).toBe('var(--radius)')
  })
})
