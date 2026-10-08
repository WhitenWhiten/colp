import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * R10-02 display-scale contract.
 *
 * `font-size: clamp(...)` is a display-scale decision: the only permitted
 * fluid headline sizes are the --display-sm/md/lg rungs (plus --text-lede)
 * in tokens.css. A `font-size: clamp(` declaration in any other stylesheet
 * must carry an `off-scale: <reason>` comment on the same line — for
 * exceptions that are not page display type at all (container-query card
 * text sized in cqi/cqh, glyphs that scale with their container) or the
 * registered display exceptions (landing/share hero mobile, journal
 * masthead). A bare clamp with no reason fails so a new ad-hoc fluid size
 * cannot slip in silently.
 */

const stylesDir = resolve(import.meta.dirname)

const DECL_RE = /(?:^|[;{])\s*font-size\s*:\s*clamp\(/g

/** Blank comment contents in place so offsets and line numbers survive. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

type Hit = { file: string; line: number }

function collectClamps(file: string): Hit[] {
  const text = readFileSync(resolve(stylesDir, file), 'utf8')
  const blanked = blankComments(text)
  const lines = text.split('\n')
  const hits: Hit[] = []
  let offset = 0
  let line = 0
  for (const match of blanked.matchAll(DECL_RE)) {
    /* match.index lands on the boundary `;`/`{` — the declaration itself
       starts at 'font-size' inside the match. */
    const declIndex = match.index + match[0].indexOf('font-size')
    while (offset + lines[line]!.length < declIndex) {
      offset += lines[line]!.length + 1
      line += 1
    }
    const rawLine = lines[line]!
    if (!/\/\*\s*off-scale:/.test(rawLine)) hits.push({ file, line: line + 1 })
  }
  return hits
}

describe('display scale contract (R10-02)', () => {
  const cssFiles = readdirSync(stylesDir).filter((f) => f.endsWith('.css') && f !== 'tokens.css')

  it('font-size: clamp() only appears in tokens.css or carries an off-scale reason', () => {
    const offenders = cssFiles
      .flatMap(collectClamps)
      .map((h) => `${h.file}:${h.line}`)
    expect(
      offenders,
      'fluid font sizes must use a --display-*/--text-* token; off-scale needs an `off-scale: <reason>` comment',
    ).toEqual([])
  })

  it('utility classes map onto the matching --display-* token', () => {
    const global = readFileSync(resolve(stylesDir, 'global.css'), 'utf8')
    expect(global).toMatch(/\.display-sm\s*\{[^}]*font-size:\s*var\(--display-sm\)/)
    expect(global).toMatch(/\.display-md\s*\{[^}]*font-size:\s*var\(--display-md\)/)
    expect(global).toMatch(/\.display-lg[\s\S]*?font-size:\s*var\(--display-lg\)/)
  })
})
