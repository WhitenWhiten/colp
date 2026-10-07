import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P1-03 / R11-07: default-chrome phone sheet grabber is scoped by
 * `data-chrome="default"` inside `max-width: 639px`. Sheet/inline chrome
 * must not pick up the ::before handle.
 */

const stylesDir = resolve(import.meta.dirname)

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function mediaMax639(source: string): string {
  const text = stripComments(source)
  const blocks: string[] = []
  const re = /@media\s*\(\s*max-width:\s*639px\s*\)(?:,\s*\([^)]+\))?\s*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length
    let depth = 1
    let i = start
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') depth -= 1
      i += 1
    }
    blocks.push(text.slice(start, i - 1))
  }
  return blocks.join('\n')
}

describe('modal sheet grabber (P1-03 / R11-07)', () => {
  const overlays = readStyle('overlays.css')
  const mobile = mediaMax639(overlays)

  it('scopes the grabber ::before to default chrome inside max-width 639px', () => {
    expect(mobile).toMatch(/\.modal-panel\[data-chrome=["']default["']\]::before/)
    expect(mobile).toMatch(/width:\s*2\.25rem/)
    expect(mobile).toMatch(/height:\s*0\.25rem/)
    expect(mobile).toMatch(/margin:\s*var\(--space-2\)\s+auto\s+var\(--space-1\)/)
    expect(mobile).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    expect(mobile).toMatch(/background:\s*var\(--line-strong\)/)
  })

  it('does not target sheet chrome or the save-folder-picker by exclusion selectors', () => {
    expect(mobile).not.toMatch(/\.modal-panel\[data-chrome=["']sheet["']\]::before/)
    expect(mobile).not.toContain(':not(.save-folder-picker)')
    expect(mobile).not.toContain(':not([data-chrome="sheet"])')
    expect(mobile).not.toMatch(/\.save-folder-picker::before/)
  })

  it('does not declare the grabber outside the 639px sheet block', () => {
    const grabber = /\.modal-panel\[data-chrome=["']default["']\]::before/g
    expect([...stripComments(overlays).matchAll(grabber)]).toHaveLength(1)
    expect(mobile.match(grabber)).toHaveLength(1)
  })

  it('keeps follow-the-finger and pan-y on default chrome only', () => {
    expect(mobile).toMatch(
      /\.modal-panel\[data-chrome=["']default["']\]\.is-sheet-dragging/,
    )
    expect(mobile).toMatch(/touch-action:\s*pan-y/)
    expect(mobile).toContain('var(--modal-sheet-drag')
  })
})
