import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P2-04 / R11-08: Classify is a single decision card at ≤899px.
 * The queue stays in the DOM; CSS hides it. Desktop ≥900px keeps the
 * two-column grid. Skip/File dock above the tab bar / home indicator.
 */

const stylesDir = resolve(import.meta.dirname)

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function mediaBlocks(source: string, headerRe: RegExp): string {
  const text = stripComments(source)
  const blocks: string[] = []
  const re = new RegExp(headerRe.source, 'g')
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

function ruleBody(block: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  const match = block.match(re)
  return match?.[1] ?? null
}

describe('classify single-card decision flow (P2-04 / R11-08)', () => {
  const classify = readStyle('classify.css')
  const mobile = mediaBlocks(classify, /@media\s*\(\s*max-width:\s*899px\s*\)\s*\{/)
  const desktop = mediaBlocks(classify, /@media\s*\(\s*min-width:\s*900px\s*\)\s*\{/)

  it('hides the queue column inside max-width 899px', () => {
    const aside = ruleBody(mobile, '.inbox-layout > aside')
    expect(aside, '.inbox-layout > aside @ 899px').toMatch(/display:\s*none/)
  })

  it('docks Skip/File above the tab bar or home indicator at ≤899px', () => {
    const actions = ruleBody(mobile, '.classify-actions')
    expect(actions, '.classify-actions @ 899px').toMatch(/position:\s*fixed/)
    expect(actions, '.classify-actions stacking token').toMatch(
      /--bottom-nav-h|--safe-bottom/,
    )
  })

  it('ellipsizes a long File label inside its own half of the docked bar', () => {
    /* The bar is flex-wrap:nowrap with two flex:1 buttons; .btn is
       white-space:nowrap, so an unclipped "File to {folder} and add N tags"
       overflows its button and paints over Skip. The label must ellipsize. */
    const label = ruleBody(mobile, '.classify-file-label')
    expect(label, '.classify-file-label @ 899px must exist').not.toBeNull()
    expect(label).toMatch(/min-width:\s*0/)
    expect(label).toMatch(/overflow:\s*hidden/)
    expect(label).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('keeps the two-column queue + cards grid at min-width 900px', () => {
    const layout = ruleBody(desktop, '.inbox-layout')
    expect(layout, '.inbox-layout @ 900px').toMatch(
      /grid-template-columns:\s*16rem\s+minmax\(0,\s*1fr\)/,
    )
    const aside = ruleBody(desktop, '.inbox-layout > aside')
    expect(aside, '.inbox-layout > aside @ 900px').toMatch(/grid-row:\s*1\s*\/\s*span\s*2/)
  })
})
