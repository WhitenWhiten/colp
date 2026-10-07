import { describe, expect, it } from 'vitest'
import { collectLayeredRules, readStyle } from './dashboard-stack-cascade.test-helper'

/**
 * Reader narrow-width contract.
 *
 * .reader-toolbar-meta / .reader-toolbar-status are display:none below the
 * widths where they join the toolbar, but the status sentence is the only
 * place save failures are reported — error/unknown must surface at every
 * width, on its own toolbar row at ≤639px.
 *
 * The Contents panel lives in the context rail, which renders after the
 * whole article below 900px; an inline <details> copy heads the column
 * there instead, and the two never show at once.
 */

describe('reader narrow-width contract', () => {
  const rules = collectLayeredRules(readStyle('reader.css'))
  const failingStates = ['error', 'unknown'] as const

  it('surfaces save failures in the toolbar meta at every width', () => {
    for (const state of failingStates) {
      const meta = rules.find((rule) => (
        rule.selector === `.reader-toolbar-meta:has(.reader-toolbar-status[data-save-state='${state}'])`
        && !rule.media
      ))
      expect(meta, `meta :has(${state}) base rule must exist`).toBeTruthy()
      expect(meta!.body).toMatch(/display:\s*flex/)

      const status = rules.find((rule) => (
        rule.selector === `.reader-toolbar-status[data-save-state='${state}']` && !rule.media
      ))
      expect(status, `status [data-save-state='${state}'] base rule must exist`).toBeTruthy()
      expect(status!.body).toMatch(/display:\s*inline-block/)
      expect(status!.body).toMatch(/color:\s*var\(--danger\)/)
    }
  })

  it('drops the failure sentence to its own toolbar row at ≤639px', () => {
    for (const state of failingStates) {
      const meta = rules.find((rule) => (
        rule.selector === `.reader-toolbar-meta:has(.reader-toolbar-status[data-save-state='${state}'])`
        && rule.media?.max === 639
      ))
      expect(meta, `meta :has(${state}) needs a ≤639px row placement`).toBeTruthy()
      expect(meta!.body).toMatch(/grid-column:\s*1\s*\/\s*-1/)
      expect(meta!.body).toMatch(/grid-row:\s*2/)
    }
  })

  it('keeps exactly one Contents rendering per width band', () => {
    /* ≥900px the rail owns Contents; the inline disclosure must be gone. */
    const inlineAtDesktop = rules.find((rule) => (
      rule.selector === '.reader-contents-inline'
      && rule.media?.min === 900
      && /display:\s*none/.test(rule.body)
    ))
    expect(inlineAtDesktop, '.reader-contents-inline must hide at ≥900px').toBeTruthy()

    /* ≤899px the rail's Contents panel retires; the inline copy carries it. */
    const railAtNarrow = rules.find((rule) => (
      rule.selector === '.reader-panel--contents'
      && rule.media?.max === 899
      && /display:\s*none/.test(rule.body)
    ))
    expect(railAtNarrow, '.reader-panel--contents must hide at ≤899px').toBeTruthy()

    /* Focus mode is the article alone — the inline copy follows the rail. */
    const focusInline = rules.find((rule) => (
      rule.selector === '.reader-page.is-focus .reader-contents-inline'
      && !rule.media
      && /display:\s*none/.test(rule.body)
    ))
    expect(focusInline, 'focus mode must hide the inline contents').toBeTruthy()
  })
})
