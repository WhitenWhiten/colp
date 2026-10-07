// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computedFor, prop, unmountCascade } from './css-contract.test-helper'

/**
 * Every comment composer keeps one footer row that wraps to full width with
 * the length counter and the actions side by side, while the input flexes
 * beside the avatar. The base class carries that layout;
 * `.community-comments-composer--reply` adds only the top margin. Until the
 * base carried it, the root and edit forms stacked every child vertically
 * while reply composers shared a footer line — same control, two layouts
 * depending on which form you opened.
 */
const stylesDir = resolve(import.meta.dirname)

/** Entry cascade around page-layouts.css, so a later layer resetting the
    axis would show instead of silently shipping. */
const CASCADE = [
  'tokens.css', 'global.css', 'nav.css', 'skeleton.css', 'page-chrome.css', 'overlays.css',
  'shared-chrome.css', 'cards.css', 'source-skins.css', 'landing.css', 'explore.css',
  'collection.css', 'pages-shared.css', 'workbench-chrome.css', 'auth.css', 'polish.css',
  'search.css', 'studio.css', 'cards-ui.css', 'data-table.css', 'stepper.css', 'reading.css',
  'page-layouts.css', 'interactions.css', 'utilities.css',
]

afterEach(() => unmountCascade())

describe('community comment composer footers', () => {
  it('the base composer wraps onto a footer row, never a column stack', () => {
    const style = computedFor('.community-comments .community-comments-composer', CASCADE)
    expect(prop(style, 'display')).toBe('flex')
    expect(prop(style, 'flex-direction')).toBe('row')
    expect(prop(style, 'flex-wrap')).toBe('wrap')
  })

  it('lays out the reply variant on the same contract', () => {
    const style = computedFor(
      '.community-comments .community-comments-composer.community-comments-composer--reply',
      CASCADE,
    )
    expect(prop(style, 'display')).toBe('flex')
    expect(prop(style, 'flex-direction')).toBe('row')
    expect(prop(style, 'flex-wrap')).toBe('wrap')
  })

  it('keeps the composer foot on its own line in the owner file', () => {
    const css = readFileSync(resolve(stylesDir, 'page-layouts.css'), 'utf8')
    expect(css).toMatch(/\.community-composer-foot\s*\{[^}]*flex:\s*1\s+1\s+100%/)
  })

  it('lets the reply variant add only its margin — no competing axis', () => {
    const css = readFileSync(resolve(stylesDir, 'page-layouts.css'), 'utf8')
    expect(css).not.toMatch(/\.community-comments-composer--reply\s*\{[^}]*flex-direction/)
    expect(css).not.toMatch(/\.community-comments-composer--reply\s+\.community-comments-input\s*\{/)
  })
})
