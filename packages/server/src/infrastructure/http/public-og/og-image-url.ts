import { SITE_ORIGIN } from '../public-shell/spa-html-meta.js';

/**
 * Canonical og:image URL for a public collection (D1), stamped into the
 * shell by injectPublicCollectionShell and served by
 * transport/public-og-image-routes.ts. The collection `updatedAt` versions
 * the URL so an edit busts social-crawler caches; SITE_ORIGIN is the literal
 * production origin, same rule as canonical/og:url (docs/public-surfaces.md).
 */
export function buildCollectionOgImageUrl(slug: string, updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  const version = Number.isFinite(parsed) ? `?v=${parsed}` : '';
  return `${SITE_ORIGIN}/og/collections/${encodeURIComponent(slug)}.png${version}`;
}
