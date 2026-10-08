import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Embed iframe root contract.
 *
 * Embed cards (`/share/:slug?embed=1`, `/reports/...?embed=1`) render inside
 * foreign iframes that can be narrower than the app's 320px viewport floor.
 * global.css must lift `min-width` and the always-reserved scrollbar gutter
 * when a `.share-embed-page` is present, or the card's right edge is clipped
 * and classic-scrollbar platforms paint a dead gutter strip. If this test
 * fails, the reset regressed — do not weaken it back into the embed path.
 */

const globalCss = readFileSync(resolve(import.meta.dirname, 'global.css'), 'utf8')

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '')

function embedHtmlBlock(): string | null {
  const match = stripComments(globalCss).match(/html:has\(\.share-embed-page\)\s*\{([^}]*)\}/u)
  return match?.[1] ?? null
}

describe('embed iframe root reset', () => {
  it('scopes the reset to documents rendering a .share-embed-page', () => {
    expect(embedHtmlBlock()).not.toBeNull()
  })

  it('lifts the 20rem viewport floor', () => {
    expect(embedHtmlBlock()).toMatch(/min-width:\s*0/)
  })

  it('drops the always-reserved scrollbar gutter', () => {
    expect(embedHtmlBlock()).toMatch(/scrollbar-gutter:\s*auto/)
  })
})
