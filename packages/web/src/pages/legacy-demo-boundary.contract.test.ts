import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const srcDir = resolve(import.meta.dirname, '..')

/*
 * DS-05 boundary: production code must not import values from
 * legacy-demo/data. The two sanctioned gateways are DemoHub.tsx (the demo
 * product map) and api/mock-data.ts (the mock barrel every flag-off
 * fallback re-exports through). Type-only imports stay allowed so catalog
 * types can keep documenting where seed values live.
 *
 * Scope covers pages, components, and lib — before 2026-08 the check only
 * scanned pages/, which let sourceLabel/isVideoSource leak into SourceCard,
 * CollistItem, and the resource-card chrome from a demo directory.
 */
const ALLOW_VALUE_IMPORTS = new Set(['pages/DemoHub.tsx'])
const SCANNED_DIRS = ['pages', 'components', 'lib']

function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...collectSources(path))
    } else if ((entry.endsWith('.tsx') || entry.endsWith('.ts')) && !entry.endsWith('.test.tsx') && !entry.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('legacy-demo value import boundary (DS-05)', () => {
  it('product pages, components, and lib do not import values from legacy-demo/data', () => {
    const offenders: string[] = []
    for (const dir of SCANNED_DIRS) {
      for (const path of collectSources(resolve(srcDir, dir))) {
        const name = relative(srcDir, path)
        if (ALLOW_VALUE_IMPORTS.has(name)) continue
        const source = readFileSync(path, 'utf8')
        const imports = source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)
        for (const match of imports) {
          const clause = match[1] ?? ''
          const spec = match[2] ?? ''
          if (!spec.includes('legacy-demo/data/')) continue
          if (/^type\s/.test(clause.trim())) continue
          offenders.push(`${name} → ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
