import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P02 source-skin contract.
 *
 * Source skins (rules whose first selector starts with `.tile-`, `.source-`
 * or `.compact-row--`) must never reassign base surface/ink tokens. Base
 * tokens are single-owner semantic primitives (C01); dark interiors and
 * brand hues are expressed with local `--source-accent*` tokens instead,
 * so source skins can never tint ordinary collection cards or page
 * surfaces.
 */

const stylesDir = resolve(import.meta.dirname)

/** Base surface / ink / line / accent ladder owned by tokens.css. */
const BASE_TOKENS = [
  '--paper',
  '--paper-2',
  '--surface',
  '--surface-raised',
  '--surface-sunken',
  '--ink',
  '--ink-2',
  '--ink-3',
  '--muted',
  '--faint',
  '--ghost',
  '--line',
  '--line-strong',
  '--line-heavy',
  '--accent',
  '--accent-ink',
  '--accent-soft',
]

const SOURCE_PREFIXES = ['.tile-', '.source-', '.compact-row--']
const SOURCE_FILES = ['cards.css', 'source-skins.css', 'collection.css', 'library.css', 'auth.css']

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Collect every rule (header + body), recursing into at-rules. */
function collectRules(text: string, out: Array<{ header: string; body: string }> = []) {
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open === -1) break
    const header = text.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1
      else if (text[j] === '}') depth -= 1
      j += 1
    }
    const body = text.slice(open + 1, j - 1)
    if (header.startsWith('@')) {
      collectRules(body, out)
    } else if (header) {
      out.push({ header, body })
    }
    i = j
  }
  return out
}

function isSourceAreaRule(header: string): boolean {
  const first = header.split(',')[0]!.trim()
  if (first.startsWith('.tile-theme-')) return false
  return SOURCE_PREFIXES.some((p) => first.startsWith(p))
}

const SOURCE_ACCENT_ASSIGN = /(?:^|;)\s*--source-accent\s*:\s*([^;]+)/g

describe('source skin contract (P02)', () => {
  for (const file of SOURCE_FILES) {
    const source = readFileSync(resolve(stylesDir, file), 'utf8')

    it(`${file}: source-area selectors never reassign base surface/ink tokens`, () => {
      const violations: string[] = []
      for (const rule of collectRules(stripComments(source))) {
        if (!isSourceAreaRule(rule.header)) continue
        for (const token of BASE_TOKENS) {
          const re = new RegExp(`(?:^|;)\\s*${token}\\s*:`, 'g')
          if (re.test(rule.body)) violations.push(`${rule.header} reassigns ${token}`)
        }
      }
      expect(violations, 'source skins must use local --source-accent* tokens').toEqual([])
    })

    it(`${file}: --source-accent is only assigned var(--source-*)`, () => {
      const violations: string[] = []
      for (const rule of collectRules(stripComments(source))) {
        if (!isSourceAreaRule(rule.header)) continue
        SOURCE_ACCENT_ASSIGN.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = SOURCE_ACCENT_ASSIGN.exec(rule.body))) {
          const value = m[1]!.trim()
          if (!/^var\(--source-[a-z0-9-]+\)/.test(value)) {
            violations.push(`${rule.header} sets --source-accent to ${value}`)
          }
        }
      }
      expect(violations, 'source skins must assign --source-accent: var(--source-*)').toEqual([])
    })

    it(`${file}: every source-area rule keeps a non-empty body`, () => {
      for (const rule of collectRules(stripComments(source))) {
        if (isSourceAreaRule(rule.header)) {
          expect(rule.body.trim(), `${rule.header} must not be empty`).not.toBe('')
        }
      }
    })
  }

  it('source-skins text color uses --source-ink, not a brand --source-* hue', () => {
    const source = stripComments(readFileSync(resolve(stylesDir, 'source-skins.css'), 'utf8'))
    const offenders: string[] = []
    for (const rule of collectRules(source)) {
      for (const match of rule.body.matchAll(/(?:^|[;{])\s*color:\s*var\((--source-[a-z0-9-]+)\)/g)) {
        if (match[1] !== '--source-ink') offenders.push(`${rule.header}: ${match[1]}`)
      }
    }
    expect(offenders, 'brand hues are marks/fills; text must use --source-ink').toEqual([])
  })
})
