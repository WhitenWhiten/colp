import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Disabled button chrome is a color change, never a fade. Opacity stacked
 * on already-quiet text drops contrast below AA without the consumer knowing.
 */

const stylesDir = resolve(import.meta.dirname)

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('disabled chrome recipe', () => {
  it('does not dim .btn:disabled with a fractional opacity', () => {
    const global = stripComments(readFileSync(resolve(stylesDir, 'global.css'), 'utf8'))
    const collection = stripComments(readFileSync(resolve(stylesDir, 'collection.css'), 'utf8'))
    const offenders: string[] = []
    for (const [file, source] of [['global.css', global], ['collection.css', collection]] as const) {
      for (const match of source.matchAll(/([^{}]*\.btn[^{]*:disabled[^{]*)\{([^}]*)\}/g)) {
        if (/opacity\s*:\s*(0?\.\d+|0)\b/.test(match[2] ?? '')) {
          offenders.push(`${file}: ${match[1]!.replace(/\s+/g, ' ').trim()}`)
        }
      }
    }
    expect(offenders, '.btn:disabled must recolor, not fade').toEqual([])
  })
})
