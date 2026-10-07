import { SITE_ORIGIN } from './spa-html-meta.js';
import {
  isSearchIndexableVisibility,
  SEARCH_INDEXABLE_VISIBILITY,
} from './public-shell-header.js';

/** Protocol ceiling while this surface stays a single urlset (T-20). Pagination is a follow-up. */
export const COLLECTIONS_SITEMAP_MAX_URLS = 50_000;
/** Soft size ceiling while this surface stays a single urlset (T-20). */
export const COLLECTIONS_SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export interface CollectionsSitemapEntry {
  readonly publicationSlug: string;
  readonly updatedAt: string;
  readonly visibility?: string;
}

export function escapeSitemapXml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** lastmod is the collection content-revision time, never `Date.now()`. */
export function collectionsSitemapLastmod(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error('collections sitemap lastmod is not a valid instant');
  }
  return new Date(parsed).toISOString();
}

export function filterSearchIndexableSitemapEntries<T extends { readonly visibility: string }>(
  entries: readonly T[],
): readonly T[] {
  return Object.freeze(entries.filter((entry) => isSearchIndexableVisibility(entry.visibility)));
}

export function buildCollectionsSitemapUrlset(entries: readonly CollectionsSitemapEntry[]): string {
  const urls = [];
  for (const entry of entries) {
    if (entry.visibility !== undefined && !isSearchIndexableVisibility(entry.visibility)) continue;
    if (typeof entry.publicationSlug !== 'string' || entry.publicationSlug.length === 0) {
      throw new Error('collections sitemap entry is missing publicationSlug');
    }
    const loc = `${SITE_ORIGIN}/c/${entry.publicationSlug}`;
    const lastmod = collectionsSitemapLastmod(entry.updatedAt);
    urls.push(`  <url>
    <loc>${escapeSitemapXml(loc)}</loc>
    <lastmod>${escapeSitemapXml(lastmod)}</lastmod>
  </url>`);
    if (urls.length >= COLLECTIONS_SITEMAP_MAX_URLS) break;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

export { SEARCH_INDEXABLE_VISIBILITY };
