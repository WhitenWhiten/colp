/**
 * SPA document first-segments that must keep HTTP 200 + index.html (nginx).
 * Trust pages (about / contact / privacy / mcp) are exact static locations, not this table.
 * The demo tree (/demo, /demos) is dev-only (R15-09) and deliberately absent, so production
 * nginx answers those URLs with a real 404.
 */
export const SPA_DOCUMENT_PREFIXES = [
  'today',
  'updates',
  'explore',
  'reports',
  'search',
  'feed',
  'c',
  'path',
  'share',
  'u',
  'profile',
  'r',
  'read',
  'library',
  'dashboard',
  'login',
  'consent',
  'register',
  'reset-password',
  'verify-email',
  'auth',
  'onboarding',
  'graph',
  'creator',
  'settings',
  'export',
  'extension',
  'sync',
  'classify',
  'import',
  'notifications',
  'credits',
  'community',
  'moderation',
  'admin',
  'approvals',
  'ai',
] as const

export type SpaDocumentPrefix = (typeof SPA_DOCUMENT_PREFIXES)[number]

/** Crawlable static urlset only (`sitemap-static.xml`, plan §7.3). Agent files are not listed here. */
export const SITEMAP_INDEXABLE_PATHS = [
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
] as const

export type SitemapIndexablePath = (typeof SITEMAP_INDEXABLE_PATHS)[number]

const TRUST_PAGE_FIRST_SEGMENTS = ['about', 'contact', 'privacy', 'mcp', 'developers', 'embed-guide'] as const
const DEMO_TREE_ROUTE = /<Route\s+path\s*=\s*(["'])demo\1/
const ROUTE_PATH_ATTR = /\bpath\s*=\s*(["'])([^"']*)\1/g

/** Product Layout tree is everything before `<Route path="demo" …>`. */
export function splitAppSourceAtDemoTree(appSource: string): { productTree: string; demoTree: string } {
  const match = DEMO_TREE_ROUTE.exec(appSource)
  if (!match || match.index === undefined) {
    return { productTree: appSource, demoTree: '' }
  }
  return {
    productTree: appSource.slice(0, match.index),
    demoTree: appSource.slice(match.index),
  }
}

/** First URL segment of a react-router `path` (`c/:slug` → `c`; `library/:id?` → `library`). */
export function routePathFirstSegment(routePath: string): string | null {
  const trimmed = routePath.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'index') return null
  const withoutLeading = trimmed.replace(/^\/+/u, '')
  const first = withoutLeading.split('/')[0] ?? ''
  const optionalStripped = first.replace(/\?+$/u, '')
  if (optionalStripped === '' || optionalStripped.startsWith(':')) return null
  return optionalStripped
}

/** Unique product-tree first segments; demo children are ignored. */
export function collectLayoutRouteFirstSegments(appSource: string): string[] {
  const { productTree } = splitAppSourceAtDemoTree(appSource)
  const seen = new Set<string>()
  const segments: string[] = []
  for (const match of productTree.matchAll(ROUTE_PATH_ATTR)) {
    const first = routePathFirstSegment(match[2] ?? '')
    if (first === null || seen.has(first)) continue
    seen.add(first)
    segments.push(first)
  }
  return segments
}

/**
 * Every product Layout `Route path` first segment must be in
 * `prefixes ∪ {about,contact,privacy} ∪ *`. Demo-tree children are not checked.
 */
export function assertLayoutRouteFirstSegmentsCovered(
  appSource: string,
  prefixes: readonly string[] = SPA_DOCUMENT_PREFIXES,
): void {
  const allowed = new Set<string>([...prefixes, ...TRUST_PAGE_FIRST_SEGMENTS, '*'])
  const orphans = collectLayoutRouteFirstSegments(appSource).filter((segment) => !allowed.has(segment))
  if (orphans.length > 0) {
    throw new Error(
      `Route path first segment(s) missing from SPA document prefixes: ${orphans.join(', ')}`,
    )
  }
}
