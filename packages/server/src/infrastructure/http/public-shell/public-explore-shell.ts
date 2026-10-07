import {
  PUBLIC_SHELL_DESCRIPTION_MAX,
  PUBLIC_SHELL_TITLE_MAX,
  sanitizePublicShellText,
  truncatePublicShellDescription,
} from './sanitize-public-shell-text.js';
import { escapePublicShellMarkdown } from './public-collection-markdown.js';
import {
  escapeAttr,
  escapeHtml,
  escapeJsonForHtmlScript,
  replaceCanonical,
  replaceJsonLd,
  replaceMarkedRegion,
  replaceMetaDescription,
  replaceOgDescription,
  replaceOgTitle,
  replaceOgUrl,
  replaceTitle,
  SITE_ORIGIN,
  wrapAgentPublicFallback,
} from './spa-html-meta.js';

export const PUBLIC_EXPLORE_PATH = '/explore';
/**
 * Must equal what the hydrated SPA writes (`PageHead documentTitle="Explore"`
 * → `Explore — Know-N`, and its `meta.description`). Two different values
 * in raw HTML and rendered DOM are exactly the conflicting-signal case the
 * runtime head layer was meant to avoid. `public-explore-shell.test.ts`
 * pins the frontend source.
 */
export const PUBLIC_EXPLORE_TITLE = 'Explore — Know-N';
export const PUBLIC_EXPLORE_HEADING = 'Explore collections';
export const PUBLIC_EXPLORE_DESCRIPTION = 'Explore public collections and curated learning paths on Know-N.';
/** Newest public collections listed in the no-JS body, markdown and ItemList. */
export const PUBLIC_EXPLORE_ITEM_LIMIT = 50;

export interface PublicExploreShellItem {
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly nodeCount: number;
  readonly updatedAt: string;
}

interface NormalizedExploreItem {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly nodeCount: number;
  readonly updated: string;
}

// Mirrors publication's isCanonicalProductPublicCollectionSlug without an
// infrastructure-http -> publication-module dependency. Non-canonical rows
// are dropped rather than escaped: they can never resolve on /c/:slug.
const CANONICAL_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,261}[a-z0-9])$/u;

export function normalizeExploreItems(
  items: readonly PublicExploreShellItem[],
  limit: number = PUBLIC_EXPLORE_ITEM_LIMIT,
): readonly NormalizedExploreItem[] {
  const normalized: NormalizedExploreItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (normalized.length >= limit) break;
    if (typeof item.slug !== 'string' || !CANONICAL_SLUG.test(item.slug) || seen.has(item.slug)) continue;
    seen.add(item.slug);
    normalized.push({
      slug: item.slug,
      title: sanitizePublicShellText(item.title, PUBLIC_SHELL_TITLE_MAX) || 'Untitled',
      summary: item.summary === null
        ? ''
        : truncatePublicShellDescription(sanitizePublicShellText(item.summary, PUBLIC_SHELL_DESCRIPTION_MAX)),
      nodeCount: Number.isInteger(item.nodeCount) && item.nodeCount >= 0 ? item.nodeCount : 0,
      updated: formatUpdatedDate(item.updatedAt),
    });
  }
  return normalized;
}

export function buildExploreJsonLd(items: readonly NormalizedExploreItem[]): string {
  const url = `${SITE_ORIGIN}${PUBLIC_EXPLORE_PATH}`;
  const body = escapeJsonForHtmlScript(JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: PUBLIC_EXPLORE_HEADING,
      description: PUBLIC_EXPLORE_DESCRIPTION,
      url,
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: items.length,
        itemListElement: items.map((item, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          url: `${SITE_ORIGIN}/c/${item.slug}`,
          name: item.title,
        })),
      },
    },
    null,
    2,
  ))
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return `<script type="application/ld+json">\n${body}\n    </script>`;
}

function itemMeta(item: NormalizedExploreItem): string {
  const noun = item.nodeCount === 1 ? 'item' : 'items';
  return `${item.nodeCount} ${noun} · updated ${item.updated}`;
}

export function injectPublicExploreShell(html: string, input: readonly PublicExploreShellItem[]): string {
  const items = normalizeExploreItems(input);
  const pageUrl = `${SITE_ORIGIN}${PUBLIC_EXPLORE_PATH}`;
  let stamped = replaceTitle(html, PUBLIC_EXPLORE_TITLE);
  stamped = replaceOgTitle(stamped, PUBLIC_EXPLORE_TITLE);
  stamped = replaceMetaDescription(stamped, PUBLIC_EXPLORE_DESCRIPTION);
  stamped = replaceOgDescription(stamped, PUBLIC_EXPLORE_DESCRIPTION);
  stamped = replaceCanonical(stamped, pageUrl);
  stamped = replaceOgUrl(stamped, pageUrl);
  stamped = replaceJsonLd(stamped, buildExploreJsonLd(items));

  const list = items.length === 0
    ? '<p>No public collections yet.</p>'
    : `<ul>\n${items.map((item) => {
      const summary = item.summary === '' ? '' : ` — ${escapeHtml(item.summary)}`;
      return `  <li><a href="/c/${escapeAttr(item.slug)}">${escapeHtml(item.title)}</a>${summary} · ${escapeHtml(itemMeta(item))}</li>`;
    }).join('\n')}\n</ul>`;
  stamped = replaceMarkedRegion(stamped, wrapAgentPublicFallback(
    `<h1>${escapeHtml(PUBLIC_EXPLORE_HEADING)}</h1>\n`
    + `<p>${escapeHtml(PUBLIC_EXPLORE_DESCRIPTION)}</p>\n`
    + `${list}\n`
    + '<p><a href="/sitemap-collections.xml">All public collections</a> · <a href="/llms.txt">llms.txt</a></p>',
  ));
  return stamped;
}

export function buildPublicExploreMarkdown(input: readonly PublicExploreShellItem[]): string {
  const items = normalizeExploreItems(input);
  const parts = [
    `# ${escapePublicShellMarkdown(PUBLIC_EXPLORE_HEADING)}`,
    '',
    escapePublicShellMarkdown(PUBLIC_EXPLORE_DESCRIPTION),
    '',
  ];
  if (items.length === 0) {
    parts.push('No public collections yet.');
  } else {
    for (const item of items) {
      const summary = item.summary === '' ? '' : ` — ${escapePublicShellMarkdown(item.summary)}`;
      parts.push(`- [${escapePublicShellMarkdown(item.title)}](/c/${item.slug})${summary} · ${itemMeta(item)}`);
    }
  }
  parts.push('', 'All public collections: [/sitemap-collections.xml](/sitemap-collections.xml)', '', '[llms.txt](/llms.txt)', '');
  return parts.join('\n');
}

function formatUpdatedDate(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return sanitizePublicShellText(updatedAt, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}
