import {
  COLLECTIONS_SITEMAP_MAX_BYTES,
  COLLECTIONS_SITEMAP_MAX_URLS,
  collectionsSitemapLastmod,
  escapeSitemapXml,
} from './collections-sitemap.js';
import { SITE_ORIGIN } from './spa-html-meta.js';

/** M-10 stays a single urlset under the same protocol ceiling as collections. */
export const PROFILES_SITEMAP_MAX_URLS = COLLECTIONS_SITEMAP_MAX_URLS;
export const PROFILES_SITEMAP_MAX_BYTES = COLLECTIONS_SITEMAP_MAX_BYTES;

export interface ProfilesSitemapEntry {
  readonly canonicalHandle: string;
  /** MAX(updated_at) across this Profile's included public publications. */
  readonly updatedAt: string;
}

export interface ProfilesSitemapLimits {
  readonly maxUrls?: number;
  readonly maxBytes?: number;
}

export const profilesSitemapLastmod = collectionsSitemapLastmod;

const PREFIX = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
`;
const SUFFIX = `
</urlset>
`;

export function buildProfilesSitemapUrlset(
  entries: readonly ProfilesSitemapEntry[],
  limits: ProfilesSitemapLimits = {},
): string {
  const maxUrls = positiveSafeInteger(limits.maxUrls ?? PROFILES_SITEMAP_MAX_URLS, 'maxUrls');
  const maxBytes = positiveSafeInteger(limits.maxBytes ?? PROFILES_SITEMAP_MAX_BYTES, 'maxBytes');
  const urls: string[] = [];
  let byteLength = Buffer.byteLength(PREFIX + SUFFIX, 'utf8');
  if (byteLength > maxBytes) {
    throw new RangeError('profiles sitemap maxBytes is too small for an empty urlset');
  }
  for (const entry of entries) {
    if (urls.length >= maxUrls) break;
    // Keep the serialized boundary as narrow as M-09's canonical authority
    // without introducing an infrastructure-http -> identity-module edge.
    if (entry.canonicalHandle === '.' || entry.canonicalHandle === '..'
        || !/^[a-z0-9._~-]{1,64}$/u.test(entry.canonicalHandle)) {
      throw new Error('profiles sitemap entry is missing a canonical handle');
    }
    const loc = `${SITE_ORIGIN}/u/${encodeURIComponent(entry.canonicalHandle)}`;
    const lastmod = profilesSitemapLastmod(entry.updatedAt);
    const separator = urls.length === 0 ? '' : '\n';
    const url = `${separator}  <url>
    <loc>${escapeSitemapXml(loc)}</loc>
    <lastmod>${escapeSitemapXml(lastmod)}</lastmod>
  </url>`;
    const urlBytes = Buffer.byteLength(url, 'utf8');
    if (byteLength + urlBytes > maxBytes) break;
    urls.push(url);
    byteLength += urlBytes;
  }
  return `${PREFIX}${urls.join('')}${SUFFIX}`;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`profiles sitemap ${name} must be a positive safe integer`);
  }
  return value;
}
