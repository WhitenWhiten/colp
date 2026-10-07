import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesDir = resolve(import.meta.dirname)

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('result-card radius family', () => {
  it('keeps .result-card and .result-card--collection on the same radius token', () => {
    const css = stripComments(readFileSync(resolve(stylesDir, 'cards-ui.css'), 'utf8'))
    const base = css.match(/\.result-card\s*\{[^}]*border-radius:\s*([^;]+)/)
    const collection = css.match(/\.result-card--collection\s*\{[^}]*border-radius:\s*([^;]+)/)
    expect(base?.[1]?.trim()).toBe('var(--radius)')
    expect(collection?.[1]?.trim()).toBe('var(--radius)')
  })
})
