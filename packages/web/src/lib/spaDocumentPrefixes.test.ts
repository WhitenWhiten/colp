/* SPA document prefix table.
 *
 * Two different kinds of claim live here and they are kept apart:
 *
 * 1. Behaviour — the exported parser/checker (`routePathFirstSegment`,
 *    `collectLayoutRouteFirstSegments`, `assertLayoutRouteFirstSegmentsCovered`)
 *    does what its name says on real route fixtures. Driven directly.
 *
 * 2. Architecture — App.tsx's router and this nginx prefix table are two
 *    hand-maintained lists that must agree, and the agreement is only
 *    observable behind nginx: a route whose first segment is missing from the
 *    table still renders perfectly in vitest (the client router is what runs
 *    here) and only 404s in production when nginx refuses the SPA fallback.
 *    The real-App assertion is therefore kept, and it is the one `?raw`
 *    import left in this file.
 */
import { describe, expect, it } from 'vitest'
import appSource from '../App.tsx?raw'
import {
  assertLayoutRouteFirstSegmentsCovered,
  collectLayoutRouteFirstSegments,
  routePathFirstSegment,
  SITEMAP_INDEXABLE_PATHS,
  SPA_DOCUMENT_PREFIXES,
} from './spaDocumentPrefixes'

const TRUST_PAGES = ['about', 'contact', 'privacy', 'mcp', 'developers'] as const
const NEGATIVE_PREFIXES = ['api', 'colp', 'assets', 'ready', '_cache_purge', 'well-known'] as const

const ORPHAN_APP_FIXTURE = `
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="today" element={<Today />} />
        <Route path="orphan" element={<Orphan />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="demo" element={<Layout />}>
        <Route path="landing" element={<Landing />} />
        <Route path="resource/:id" element={<Resource />} />
      </Route>
    </Routes>
  )
}
`

/* A well-formed app: the catch-all and the demo children are present in the
   input, so "not collected" below is a real exclusion rather than an empty
   input quietly satisfying `not.toContain`. */
const COVERED_APP_FIXTURE = `
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="today" element={<Today />} />
        <Route path="library/:id?" element={<Library />} />
        <Route path="c/:slug" element={<Collection />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="demo" element={<Layout />}>
        <Route path="landing" element={<Landing />} />
        <Route path="resource/:id" element={<Resource />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
`

describe('SPA document prefix behaviour', () => {
  it('fails when a product Layout route first segment is missing from the table', () => {
    expect(() => assertLayoutRouteFirstSegmentsCovered(ORPHAN_APP_FIXTURE)).toThrow(/orphan/)
  })

  it('accepts a Layout tree whose first segments are all covered', () => {
    expect(() => assertLayoutRouteFirstSegmentsCovered(COVERED_APP_FIXTURE)).not.toThrow()
    expect(() => assertLayoutRouteFirstSegmentsCovered(COVERED_APP_FIXTURE, [])).toThrow(
      /today, library, c, settings/,
    )
  })

  it('reduces a route path to its first segment and drops index/param-only/catch-all routes', () => {
    expect(routePathFirstSegment('c/:slug')).toBe('c')
    expect(routePathFirstSegment('library/:id?')).toBe('library')
    expect(routePathFirstSegment('/reports/:slug')).toBe('reports')
    expect(routePathFirstSegment('')).toBeNull()
    expect(routePathFirstSegment('index')).toBeNull()
    expect(routePathFirstSegment('*')).toBeNull()
    expect(routePathFirstSegment(':id')).toBeNull()
  })

  it('keeps the dev-only demo tree out of the document prefixes and ignores its children', () => {
    // R15-09: /demo and /demos are dev-only, so production nginx must 404 them.
    expect(SPA_DOCUMENT_PREFIXES).not.toContain('demo')
    expect(SPA_DOCUMENT_PREFIXES).not.toContain('demos')
    expect(SPA_DOCUMENT_PREFIXES).not.toContain('landing')
    expect(SPA_DOCUMENT_PREFIXES).not.toContain('resource')

    const collected = collectLayoutRouteFirstSegments(COVERED_APP_FIXTURE)
    /* The fixture really declares these under the demo tree, so their absence
       from `collected` is the demo split working, not an empty parse. */
    expect(COVERED_APP_FIXTURE).toMatch(/path\s*=\s*["']landing["']/)
    expect(COVERED_APP_FIXTURE).toMatch(/path\s*=\s*["']resource\/:id["']/)
    expect(collected).not.toContain('landing')
    expect(collected).not.toContain('resource')
    expect(collected).toEqual(['today', 'library', 'c', 'settings'])
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('covers every product Layout route first segment from App.tsx', () => {
    /* Cross-artifact contract: the router in App.tsx and the nginx SPA
       fallback list are two hand-maintained files, and the seam is only
       observable behind nginx — every one of these routes resolves fine in
       the client router that vitest runs, so no render can falsify the
       agreement. Kept on the real App source (the input the production
       checker is designed to consume). */
    expect(() => assertLayoutRouteFirstSegmentsCovered(appSource)).not.toThrow()

    const segments = collectLayoutRouteFirstSegments(appSource)
    /* Non-vacuity anchors: App.tsx really does declare a catch-all and the
       demo children, so the exclusions below are falsifiable — dropping the
       catch-all or a demo child from the router fails here first. */
    /* Non-vacuity: an empty `?raw` import would make the exclusions below
       pass on an app that declares nothing at all. */
    expect(appSource.length).toBeGreaterThan(10_000)
    expect(appSource).toMatch(/path\s*=\s*["']demo["']/)
    expect(appSource).toMatch(/path\s*=\s*["']\*["']/)
    expect(appSource).toMatch(/path\s*=\s*["']library\/:id\?["']/)
    expect(segments).not.toContain('*')
    expect(segments).not.toContain('landing')
    expect(segments).not.toContain('resource')
    /* `*` can never be a first segment, so the catch-all can never smuggle a
       document prefix into the table. */
    expect(SPA_DOCUMENT_PREFIXES).not.toContain('*')
  })

  it('omits trust-page first segments (those are exact static locations)', () => {
    for (const segment of TRUST_PAGES) {
      expect(SPA_DOCUMENT_PREFIXES).not.toContain(segment)
    }
  })

  it('omits nginx / API / well-known prefixes that must not SPA-fallback', () => {
    for (const segment of NEGATIVE_PREFIXES) {
      expect(SPA_DOCUMENT_PREFIXES).not.toContain(segment)
    }
  })
})

describe('SITEMAP_INDEXABLE_PATHS', () => {
  it('equals the §7.3 indexable whitelist and omits agent files', () => {
    /* `toEqual` is the binding assertion — it pins the list exactly. The
       `not.toContain` lines are the human-readable half of the same claim. */
    expect(SITEMAP_INDEXABLE_PATHS).toEqual([
      '/',
      '/explore',
      '/about',
      '/contact',
      '/privacy',
      '/extension',
      '/mcp',
      '/developers',
      '/embed-guide',
      '/login',
      '/register',
    ])
    expect(SITEMAP_INDEXABLE_PATHS).not.toContain('/robots.txt')
    expect(SITEMAP_INDEXABLE_PATHS).not.toContain('/sitemap.xml')
    expect(SITEMAP_INDEXABLE_PATHS).not.toContain('/sitemap-static.xml')
    expect(SITEMAP_INDEXABLE_PATHS).not.toContain('/sitemap-collections.xml')
    expect(SITEMAP_INDEXABLE_PATHS).not.toContain('/llms.txt')
  })
})
