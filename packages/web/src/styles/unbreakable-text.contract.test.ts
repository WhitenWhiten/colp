// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildElement, computedFor, mountCascade, prop, unmountCascade } from './css-contract.test-helper'
import { DESK_WIDGET_STYLESHEETS } from './dashboard-stack-cascade.test-helper'

/**
 * R7-21: a long unbreakable token (bookmark URL, display name, email,
 * client_id) must wrap inside the measure instead of painting past it.
 * Clamp boxes that already set overflow:hidden need the wrap on the same
 * element so overflow:hidden shears a wrapped line, not a one-line glyph run.
 *
 * Asserted on the computed style of the element each selector describes,
 * with the real stylesheets mounted in cascade order — so a rule may move
 * between files or be inherited from a primitive, but a later layer that
 * resets the wrap would fail here.
 */

const stylesDir = resolve(import.meta.dirname)

/* The Know-N checkout kept popup.css next to Known-Frontend. This copy
   vendors that file so the contract still runs inside the colp repo. */
const extensionPopupPath = resolve(stylesDir, '../../upstream-fixtures/popup.css')

/** Entry order from main.tsx plus the route-owned files these elements live in. */
const CASCADE = [
  'tokens.css', 'global.css', 'nav.css', 'page-chrome.css', 'overlays.css', 'shared-chrome.css',
  'cards.css', 'source-skins.css', 'landing.css', 'explore.css', 'collection.css', 'pages-shared.css',
  'library.css', 'auth.css', 'polish.css', 'search.css', 'studio.css', 'cards-ui.css', 'reading.css', 'collab.css',
  'page-layouts.css', 'interactions.css', 'utilities.css',
  'today.css', 'collection-history.css', 'reader.css', 'path-reader.css', 'library-health.css',
  'data-export.css', 'import.css', 'saved-resources.css',
  'share.css', 'profile.css', 'graph.css', ...DESK_WIDGET_STYLESHEETS,
]

afterEach(() => unmountCascade())

function wraps(selector: string): void {
  const style = computedFor(selector, CASCADE)
  expect(prop(style, 'overflow-wrap'), `${selector} must compute overflow-wrap: anywhere`).toBe('anywhere')
}

describe('unbreakable tokens stay inside their measure', () => {
  it('locks wrap on heading and display primitives', () => {
    for (const selector of ['h1', 'h2', 'h3', 'h4', '.display']) wraps(selector)
  })

  it('wraps next to each overflow box', () => {
    for (const selector of [
      '.page-head h1',
      '.page-head .display',
      '.empty-state h3',
      '.empty-state h1',
      '.empty-state-text',
      '.modal-title',
      '.toast-message',
      '.reader-article h1',
      '.reading-title',
      '.reading-body',
      '.share-hero-copy .display',
      '.profile-hero .display',
      '.profile-hero p.lede',
      '.journal-intro h1.display',
      '.journal-intro p.journal-bio',
      '.collection-masthead .display',
      '.collection-page[data-in-folder] .collection-masthead .display',
      '.feed-card .result-row-title',
      '.graph-side h3',
      '.publication-canonical',
      '.publication-canonical code',
      '.collist-pop-title',
      '.auth-card',
      'pre',
      '.trust-doc',
    ]) wraps(selector)
  })

  it('lets a modal title shrink in its flex header', () => {
    expect(prop(computedFor('.modal-title', CASCADE), 'min-width')).toMatch(/^0(px)?$/)
  })

  it('negative control: the harness sees a later reset, not just the declaring rule', () => {
    mountCascade(CASCADE)
    const title = buildElement('.modal-title')
    expect(prop(getComputedStyle(title), 'overflow-wrap')).toBe('anywhere')
    const reset = document.createElement('style')
    reset.textContent = '.modal-title { overflow-wrap: normal !important; }'
    document.head.appendChild(reset)
    try {
      expect(prop(getComputedStyle(title), 'overflow-wrap')).toBe('normal')
    } finally {
      reset.remove()
    }
  })

  it('overrides pre default nowrap so MCP curl bodies wrap', () => {
    const style = computedFor('pre', CASCADE)
    expect(prop(style, 'white-space')).toBe('pre-wrap')
    expect(prop(style, 'max-width')).toBe('100%')
  })

  it('keeps the extension popup bar shrinkable and its status text ellipsized', () => {
    // The extension ships its own stylesheet outside this app's cascade.
    //
    // This used to be `it.skipIf(!hasExtensionPopup)`, which meant a checkout
    // where the path did not resolve silently ran NOTHING and still reported a
    // green suite — the assertion could vanish without anyone noticing. The
    // contract is cross-module and the sibling directory is always present in
    // this repository, so a missing file is a failure, not a reason to skip.
    expect(existsSync(extensionPopupPath),
      `the extension popup stylesheet must exist at ${extensionPopupPath}`).toBe(true)
    const css = readFileSync(extensionPopupPath, 'utf8')
    // The popup shell (10d2c6d43) keeps the account chip as a monogram-only
    // avatar button (#open-account.pp-avatar-btn wraps #account-label), so
    // there is no account text left in the 360px bar to ellipsize: the button
    // only has to stay a bounded, fixed-size target with a bounded avatar.
    const avatarButton = css.match(/\.pp-avatar-btn\s*\{([^}]*)\}/)?.[1]
    expect(avatarButton, '.pp-avatar-btn must be defined in popup.css').toBeTruthy()
    expect(avatarButton).toMatch(/width:\s*2rem/)
    expect(avatarButton).toMatch(/height:\s*2rem/)
    expect(css).toMatch(/\.pp-avatar-btn\s+\.avatar\s*\{[^}]*width:\s*1\.5rem/)
    // The capture status line is the remaining unbreakable-token surface in
    // that shell: both its text and its meta span must shrink and ellipsize.
    for (const selector of ['.pp-status-text', '.pp-status-meta']) {
      const rule = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1]
      expect(rule, `${selector} must be defined in popup.css`).toBeTruthy()
      expect(rule).toMatch(/min-width:\s*0/)
      expect(rule).toMatch(/overflow:\s*hidden/)
      expect(rule).toMatch(/text-overflow:\s*ellipsis/)
      expect(rule).toMatch(/white-space:\s*nowrap/)
    }
  })
})
