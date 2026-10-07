import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESK_WIDGET_STYLESHEETS } from './dashboard-stack-cascade.test-helper'

/**
 * Desk widget chips / icon buttons keep a compact mouse size and grow to
 * the shared 2.75rem (44px) hit box under `(pointer: coarse)`. jsdom does
 * not emulate that media query, so this contract asserts the rule text
 * rather than computed style.
 */

const stylesDir = resolve(import.meta.dirname)

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function coarseBlocks(source: string): string[] {
  const text = stripComments(source)
  const blocks: string[] = []
  const re = /@media\s*\(\s*pointer:\s*coarse\s*\)\s*\{/g
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
  return blocks
}

function coarseRules(source: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = []
  for (const block of coarseBlocks(source)) {
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const header = match[1]!.trim()
      if (header.startsWith('@')) continue
      for (const selector of header.split(',')) {
        rules.push({ selector: selector.replace(/\s+/g, ' ').trim(), body: match[2] ?? '' })
      }
    }
  }
  return rules
}

function hasTouchSize(body: string): boolean {
  if (/min-height:\s*2\.75rem/.test(body)) return true
  return /width:\s*2\.75rem/.test(body) && /height:\s*2\.75rem/.test(body)
}

function hasSquareTouch(body: string): boolean {
  if (/min-width:\s*2\.75rem/.test(body) && /min-height:\s*2\.75rem/.test(body)) return true
  return /width:\s*2\.75rem/.test(body) && /height:\s*2\.75rem/.test(body)
}

const WIDGET_CHIPS = [
  '.desk-ai-scopes button',
  '.desk-wordbook-tabs button',
  '.desk-ai-starters button',
  '.desk-word-ratings button',
  '.desk-word-open',
]

const WIDGET_ICONS = [
  '.desk-ai-compose button',
  '.desk-word-add > button',
  '.desk-word-remove',
]

const CHROME_CHIPS = [
  '.desk-reading-filter',
  '.desk-pomo-mode',
  '.desk-ql-chip',
  '.desk-habit-row',
  '.desk-weather-refresh',
]

const CHROME_ICONS = [
  '.desk-ql-remove',
  '.desk-todo-remove',
  '.desk-reading-mark',
]

describe('desk widget coarse pointer hit areas', () => {
  /* One chapter file per widget; each owns its own (pointer: coarse) block,
     so the rules are read from all of them in import order. */
  const widgets = DESK_WIDGET_STYLESHEETS.map((file) => readStyle(file)).join('\n')
  const chrome = readStyle('cards-ui.css')
  const widgetRules = coarseRules(widgets)
  /* Desk-widget chrome (collist, reading, pomodoro, quicklinks, habits,
     weather) moved from cards-ui.css to the widget chapters — the coarse
     hit-area rules moved with it, so chrome rules are read from there. */
  const chromeRules = coarseRules(widgets)

  it.each(WIDGET_CHIPS)('grows %s to 2.75rem in its widget chapter under pointer: coarse', (selector) => {
    const rule = widgetRules.find((r) => r.selector === selector)
    expect(rule, `${selector} must be in a (pointer: coarse) block`).toBeTruthy()
    expect(hasTouchSize(rule!.body), `${selector} must set min-height 2.75rem`).toBe(true)
  })

  it.each(WIDGET_ICONS)('grows square %s in its widget chapter under pointer: coarse', (selector) => {
    const rule = widgetRules.find((r) => r.selector === selector)
    expect(rule, `${selector} must be in a (pointer: coarse) block`).toBeTruthy()
    expect(hasSquareTouch(rule!.body), `${selector} must set min-width and min-height 2.75rem`).toBe(true)
  })

  it.each(CHROME_CHIPS)('grows %s to 2.75rem in its widget chapter under pointer: coarse', (selector) => {
    const rule = chromeRules.find((r) => r.selector === selector)
    expect(rule, `${selector} must be in a (pointer: coarse) block`).toBeTruthy()
    expect(hasTouchSize(rule!.body), `${selector} must set min-height 2.75rem`).toBe(true)
  })

  it.each(CHROME_ICONS)('keeps square %s at 2.75rem in its widget chapter under pointer: coarse', (selector) => {
    const rule = chromeRules.find((r) => r.selector === selector)
    expect(rule, `${selector} must be in a (pointer: coarse) block`).toBeTruthy()
    expect(hasSquareTouch(rule!.body), `${selector} must set 2.75rem width and height`).toBe(true)
  })

  it('does not apply the 2.75rem hit box outside (pointer: coarse)', () => {
    const compact = [
      [widgets, '.desk-ai-scopes button'],
      [widgets, '.desk-wordbook-tabs button'],
      [widgets, '.desk-reading-filter'],
      [widgets, '.desk-pomo-mode'],
    ] as const
    for (const [source, selector] of compact) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const first = stripComments(source).match(
        new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^{}]*)\\}`),
      )
      expect(first, `${selector} compact rule missing`).toBeTruthy()
      expect(first![1]).not.toMatch(/min-height:\s*2\.75rem/)
    }
  })

  it('does not put coarse fills on tile skins', () => {
    const coarse = [...coarseBlocks(widgets), ...coarseBlocks(chrome)].join('\n')
    expect(coarse).not.toMatch(/\.tile-sticky|\.tile-weather|\.tile-ssh/)
  })
})
