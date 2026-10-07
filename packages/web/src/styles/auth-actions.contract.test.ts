// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computedFor, prop, unmountCascade } from './css-contract.test-helper'

/**
 * The auth surface has exactly two action containers, and each one states its
 * cross-axis intent out loud:
 *
 *   .auth-action-row  — inline actions kept at their label width
 *   .auth-cta-stack   — stacked full-bleed CTAs for a whole-screen decision
 *
 * They exist because `.btn` is inline-flex: dropped into a column-flex parent
 * that leaves `align-items` at its `stretch` default, every button silently
 * spans the container. That is right for a "check your email" card and wrong
 * for a settings row, and the old `.auth-pending-actions` could not tell the
 * two apart — it was used for both and got full bleed by accident.
 */

const stylesDir = resolve(import.meta.dirname)
const srcDir = resolve(import.meta.dirname, '..')

/** Classes retired by the split; a copy-paste from history must not revive them. */
const RETIRED = ['auth-pending-actions', 'auth-action-danger']

/** Entry cascade around auth.css, so a later layer resetting the axis would show. */
const CASCADE = [
  'tokens.css', 'global.css', 'page-chrome.css', 'overlays.css', 'shared-chrome.css',
  'auth.css', 'polish.css', 'interactions.css', 'utilities.css',
]

afterEach(() => unmountCascade())

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(tsx?|css)$/.test(entry) ? [full] : []
  })
}

describe('auth action containers', () => {
  it.each([
    ['.auth-action-row', 'center'],
    ['.auth-cta-stack', 'stretch'],
  ])('%s computes its own align-items (%s), never the flex default', (selector, expected) => {
    const style = computedFor(`.auth-card ${selector}`, CASCADE)
    expect(prop(style, 'display')).toBe('flex')
    expect(prop(style, 'align-items')).toBe(expected)
  })

  it('keeps the two containers on opposite axes', () => {
    expect(prop(computedFor('.auth-card .auth-cta-stack', CASCADE), 'flex-direction')).toBe('column')
    expect(prop(computedFor('.auth-card .auth-action-row', CASCADE), 'flex-direction')).not.toBe('column')
  })

  it('still defines both containers in auth.css (owner file)', () => {
    const authCss = readFileSync(resolve(stylesDir, 'auth.css'), 'utf8')
    expect(authCss).toMatch(/\.auth-action-row\s*\{/)
    expect(authCss).toMatch(/\.auth-cta-stack\s*\{/)
  })

  it('gives every auth card one feedback slot outside its form', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(resolve(srcDir, 'pages'))) {
      if (!file.endsWith('.tsx') || file.includes('.test.')) continue
      const source = readFileSync(file, 'utf8')
      if (!source.includes('auth-card')) continue
      // Card-level feedback lives in the shared slot under the header. Inline
      // per-field `.field-error` is a separate, deliberate pattern (Login).
      for (const match of source.matchAll(/className="([^"]+)"/g)) {
        const tokens = match[1]!.split(/\s+/)
        const isFeedback = tokens.includes('auth-notice') || tokens.includes('auth-alert')
        if (isFeedback && !tokens.includes('auth-feedback')) {
          offenders.push(`${file.slice(srcDir.length + 1)}: ${match[1]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it.each(RETIRED)('has no call site or rule left for the retired %s', (className) => {
    const offenders = sourceFiles(srcDir)
      .filter((file) => readFileSync(file, 'utf8').includes(className))
      .map((file) => file.slice(srcDir.length + 1))
      .filter((file) => file !== 'styles/auth-actions.contract.test.ts')
    expect(offenders).toEqual([])
  })
})
