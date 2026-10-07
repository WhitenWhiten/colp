import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CQ-01: a named container is only worth its containment cost when some
 * rule queries it. `container: collection-card / inline-size` sat in
 * cards-ui.css with no `@container collection-card` anywhere; this pins that
 * every declared container name is queried, and every query names a
 * declared container (a typo in either direction silently disables the rule).
 *
 * Scope honesty (R9-29): this contract checks the declared↔queried name
 * closure ONLY. It does not verify that a `size` (vs `inline-size`)
 * containment's layout cost is justified, that the query condition matches
 * the intent, or that a viewport fallback exists — those need a
 * real-browser contract and stay unverified here by design.
 */

const stylesDir = resolve(import.meta.dirname)

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function allCss(): string {
  return readdirSync(stylesDir)
    .filter((file) => file.endsWith('.css'))
    .map((file) => stripComments(readFileSync(resolve(stylesDir, file), 'utf8')))
    .join('\n')
}

describe('container query contract (CQ-01)', () => {
  const css = allCss()
  const declared = new Set<string>()
  for (const m of css.matchAll(/container(?:-name)?\s*:\s*([a-zA-Z_][\w-]*)/g)) {
    if (m[1] !== 'inline-size' && m[1] !== 'size' && m[1] !== 'normal' && m[1] !== 'none') declared.add(m[1]!)
  }
  const queried = new Set<string>()
  for (const m of css.matchAll(/@container\s+([a-zA-Z_][\w-]*)\s*\(/g)) queried.add(m[1]!)

  it('declares at least the desk tile container', () => {
    expect(declared).toContain('tile')
  })

  it('queries every declared container name', () => {
    const unused = [...declared].filter((name) => !queried.has(name)).sort()
    expect(unused, 'declared containers with no @container query — remove the declaration or add the query').toEqual([])
  })

  it('declares every container name a query refers to', () => {
    const dangling = [...queried].filter((name) => !declared.has(name)).sort()
    expect(dangling, '@container queries naming an undeclared container').toEqual([])
  })
})
