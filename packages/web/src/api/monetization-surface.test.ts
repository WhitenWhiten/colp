/* Deferred monetization frontend boundary.
 *
 * This suite is entirely an absence invariant: "no paid subscription,
 * checkout or payout surface exists anywhere a user can reach." Grant-funded
 * classification consent and a read-only credit ledger are delivered features.
 * That cannot be proven by running code — a route that does not exist cannot
 * be visited and a control that does not exist cannot be clicked — so the
 * scan IS the assertion, and the honest form is to make the scanned set
 * complete rather than to sample it:
 *
 *   - every production module under src/pages and src/components is scanned,
 *     plus the app shell and the generated public markdown. A new page or
 *     component cannot escape the boundary by not being added to a
 *     hand-maintained list; and
 *   - the scan fails loudly when the scanned set is unexpectedly small, which
 *     is what a broken/mis-anchored glob would otherwise turn into a silent
 *     pass (an empty string matches no forbidden word).
 */
import { describe, expect, it } from 'vitest'
import appSource from '../App.tsx?raw'
import aboutMarkdown from '../../content/agent-public/about.md?raw'
import contactMarkdown from '../../content/agent-public/contact.md?raw'
import developersMarkdown from '../../content/agent-public/developers.md?raw'
import mcpMarkdown from '../../content/agent-public/mcp.md?raw'
import privacyMarkdown from '../../content/agent-public/privacy.md?raw'

/* The reachable user-facing surface: production modules only. */
const pageAndComponentSources = import.meta.glob(
  [
    '../pages/**/*.{ts,tsx}',
    '../components/**/*.{ts,tsx}',
    '!**/*.test.*',
    '!**/*.test-helper.*',
    '!**/*.test-mocks.*',
  ],
  { eager: true, import: 'default', query: '?raw' },
) as Record<string, string>

const deferredCommercialSurface =
  /\/(?:subscribe|subscriptions|checkout|billing)(?:\/|['"`])|\b(?:checkout|monetization|paid|payment|paywall|pricing|revenue|payouts?|subscription|subscriptions)\b/iu

/* Comments, module specifiers, class names, test ids and request intent ids
   are wiring, not copy: a user never reads them, so they cannot promise a
   paid surface. */
function stripNonVisibleWiring(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|\s)\/\/.*$/gmu, '$1')
    .replace(/^\s*import\b[^;]*?\bfrom\s*['"][^'"]*['"];?\s*$/gmu, '')
    .replace(/\b(?:className|data-testid)=(?:"[^"]*"|'[^']*'|\{[^}]*\})/gu, '')
    .replace(/\bintentId:\s*'[^']*'/gu, "intentId: ''")
}

/* Bookmark subscriptions: the free, read-only feature that follows a
   collection's bookmarks into the browser through the extension. It is not
   a paid plan, so its name is neutralised before the scan. */
const bookmarkSubscriptionPhrase = /\b(?:bookmark|browser|read-only)[ -]subscriptions?\b/giu

function commercialSurfaceSource(name: string, source: string): string {
  const visible = stripNonVisibleWiring(source).replace(bookmarkSubscriptionPhrase, 'bookmark follow')
  // These Credits ledger-kind labels render only if the backend returns
  // historical payment entries; they are not an invitation to make a payment.
  // Keep every other part of Credits.tsx inside the same commercial boundary.
  if (name !== '../pages/Credits.tsx') return visible
  return visible
    .replaceAll("'Payment refund'", "'Historical refund'")
    .replaceAll("payment_received: 'Payment received'", "historical_received: 'Historical received'")
    .replaceAll("payment_refunded: 'Payment refunded'", "historical_refunded: 'Historical refunded'")
    .replaceAll("payment: 'Payment'", "historical: 'Historical'")
}

describe('deferred monetization frontend boundary', () => {
  it('does not register paid subscription or checkout routes', () => {
    expect(appSource).not.toMatch(/path=["'](?:subscribe|subscriptions|checkout)/iu)
    /* No machine-readable offer/product metadata in the app shell either:
       structured commercial data would survive as a paid surface even with no
       visible control. */
    expect(appSource).not.toMatch(/application\/ld\+json/iu)
  })

  it('scans the whole reachable surface, not a hand-maintained sample', () => {
    const scanned = Object.keys(pageAndComponentSources)
    expect(scanned.length).toBeGreaterThan(100)
    /* Anchor the glob so a silently empty or mis-anchored pattern fails here
       instead of vacuously passing the boundary below. */
    for (const required of [
      '../pages/Feed.tsx',
      '../pages/ResourceDetail.tsx',
      '../components/Footer.tsx',
      '../components/TopNav.tsx',
    ]) {
      expect(scanned, required).toContain(required)
    }
  })

  it('keeps commercial controls and promises out of user-facing surfaces', () => {
    const surfaces: Record<string, string> = {
      ...pageAndComponentSources,
      appSource,
      aboutMarkdown,
      contactMarkdown,
      developersMarkdown,
      mcpMarkdown,
      privacyMarkdown,
    }
    expect(Object.keys(surfaces).length).toBeGreaterThan(100)
    /* Report every offending line at once rather than the first file. */
    const offenders = Object.entries(surfaces).flatMap(([name, source]) =>
      commercialSurfaceSource(name, source).split('\n')
        .filter(line => deferredCommercialSurface.test(line))
        .map(line => `${name}: ${line.trim()}`))
    expect(offenders).toEqual([])
  })

  it('permits credit protocol fields and the historical refund label while still rejecting payment controls', () => {
    expect('const billing = consent; send({ billing })').not.toMatch(deferredCommercialSurface)
    expect(commercialSurfaceSource('../pages/Credits.tsx', "'Payment refund'")).not.toMatch(deferredCommercialSurface)
    expect(commercialSurfaceSource('../components/X.tsx', "import { a } from './subscriptions/a'\n<p className=\"subscription-note\">Bookmark subscriptions</p> // paid later")).not.toMatch(deferredCommercialSurface)
    expect(commercialSurfaceSource('../components/X.tsx', '<p className="note">Start a subscription</p> // note')).toMatch(deferredCommercialSurface)
    for (const forbidden of ["href='/checkout'", "href='/billing'", "'Payment settings'", "'Paid subscription'", "'Payout'", "'Payment'"]) {
      expect(commercialSurfaceSource('../pages/Credits.tsx', forbidden)).toMatch(deferredCommercialSurface)
    }
  })
})
