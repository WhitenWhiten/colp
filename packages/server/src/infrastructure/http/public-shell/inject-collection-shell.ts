import {
  PUBLIC_SHELL_DESCRIPTION_MAX,
  PUBLIC_SHELL_TITLE_MAX,
  sanitizePublicShellText,
  truncatePublicShellDescription,
} from './sanitize-public-shell-text.js';
import {
  outlinePublicCollection,
  type PublicShellMarkdownNode,
  type PublicShellOutlineEntry,
} from './public-collection-outline.js';
import {
  escapeAttr,
  escapeHtml,
  escapeJsonForHtmlScript,
  replaceCanonical,
  replaceJsonLd,
  replaceHtmlLang,
  replaceMarkedRegion,
  replaceMetaDescription,
  replaceOgDescription,
  replaceOgImage,
  replaceOgLocale,
  replaceOgTitle,
  replaceOgUrl,
  replaceTitle,
  SITE_ORIGIN,
  wrapAgentPublicFallback,
} from './spa-html-meta.js';
import { isSearchIndexableVisibility } from './public-shell-header.js';
import { buildCollectionOgImageUrl } from '../public-og/og-image-url.js';

/** `share` / `path` / `graph` are wrappers: their canonical is always `/c/:slug`. */
export type PublicShellSurface = 'c' | 'share' | 'path' | 'graph';

export interface PublicShellCollectionInput {
  readonly slug: string;
  readonly collectionId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly curator: string;
  /** Canonical public Profile handle of the owner; links `Curated by` and JSON-LD `creator` to `/u/{handle}`. */
  readonly curatorHandle?: string | null;
  readonly itemCount: number;
  readonly updatedAt: string;
  readonly visibility: 'public' | 'unlisted';
  /**
   * Final search-indexing verdict. Defaults to `isSearchIndexableVisibility(visibility)`;
   * routes pass `false` for seed-registered collections so a public demo
   * fixture still renders but carries `noindex`.
   */
  readonly searchIndexable?: boolean;
  readonly language: string | null;
  /**
   * Snapshot nodes (same page the markdown variant reads). When present the
   * no-JS body carries the folder / bookmark outline and JSON-LD lists the
   * first bookmarks. Absent or null keeps the header-only body.
   */
  readonly nodes?: readonly PublicShellMarkdownNode[] | null;
}

/** ItemList entries embedded in JSON-LD; the HTML outline still shows up to the snapshot cap. */
export const PUBLIC_SHELL_JSON_LD_ITEM_CAP = 50;
const HANDLE_PATTERN = /^[a-z0-9._~-]{1,64}$/u;

export interface NormalizedContentLanguage {
  readonly htmlLang: string;
  readonly ogLocale: string | null;
}

export function normalizeContentLanguage(value: string | null): NormalizedContentLanguage | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  const match = /^([a-z]{2,3})(?:-([a-z]{2}))?$/u.exec(normalized);
  if (match === null) return null;
  const language = match[1];
  if (language === undefined) return null;
  const region = match[2];
  if (region === undefined) return { htmlLang: language, ogLocale: null };
  const upperRegion = region.toUpperCase();
  return { htmlLang: `${language}-${upperRegion}`, ogLocale: `${language}_${upperRegion}` };
}

export const FALLBACK_CURATOR = 'Know-N';

export function fallbackCollectionDescription(curator: string): string {
  return `A public collection on Know-N by ${curator}`;
}

export function buildCollectionPageJsonLd(input: {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly numberOfItems: number;
  readonly inLanguage?: string | null;
  readonly dateModified?: string | null;
  readonly creator?: { readonly name: string; readonly url: string | null } | null;
  readonly items?: readonly { readonly name: string; readonly url: string }[];
}): string {
  const items = (input.items ?? []).slice(0, PUBLIC_SHELL_JSON_LD_ITEM_CAP);
  const body = escapeJsonForHtmlScript(JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: input.name,
      description: input.description,
      url: input.url,
      ...(input.inLanguage ? { inLanguage: input.inLanguage } : {}),
      ...(input.dateModified ? { dateModified: input.dateModified } : {}),
      ...(input.creator
        ? {
            creator: {
              '@type': 'Person',
              name: input.creator.name,
              ...(input.creator.url ? { url: input.creator.url } : {}),
            },
          }
        : {}),
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: input.numberOfItems,
        ...(items.length > 0
          ? {
              itemListElement: items.map((item, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: item.name,
                url: item.url,
              })),
            }
          : {}),
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

export function insertRobotsNoindex(html: string): string {
  if (/<meta\s+name="robots"/iu.test(html)) {
    throw new Error('Failed to insert robots noindex: robots meta already present');
  }
  if (!html.includes('<head>')) {
    throw new Error('Failed to insert robots noindex: <head> not found');
  }
  return html.replace('<head>', '<head>\n    <meta name="robots" content="noindex" />');
}

export function surfacePath(surface: PublicShellSurface, slug: string): string {
  return `/${surface}/${slug}`;
}

export function injectPublicCollectionShell(
  html: string,
  input: PublicShellCollectionInput & { readonly surface: PublicShellSurface },
): string {
  const curator = sanitizePublicShellText(input.curator, PUBLIC_SHELL_TITLE_MAX) || FALLBACK_CURATOR;
  const collectionTitle = sanitizePublicShellText(input.title, PUBLIC_SHELL_TITLE_MAX);
  const rawSummary = input.summary === null ? '' : sanitizePublicShellText(input.summary, PUBLIC_SHELL_DESCRIPTION_MAX);
  const title = `${collectionTitle} — Know-N`;
  // Full summary (≤500) stays in the no-JS body and JSON-LD; the search snippet
  // and social card get the 160-character sentence-bounded form.
  const fullDescription = sanitizePublicShellText(
    rawSummary === '' ? fallbackCollectionDescription(curator) : rawSummary,
    PUBLIC_SHELL_DESCRIPTION_MAX,
  );
  const description = truncatePublicShellDescription(fullDescription);
  const canonicalUrl = `${SITE_ORIGIN}/c/${input.slug}`;
  const ogUrl = `${SITE_ORIGIN}${surfacePath(input.surface, input.slug)}`;
  const updated = formatUpdatedDate(input.updatedAt);
  let stamped = replaceTitle(html, title);
  const language = normalizeContentLanguage(input.language);
  if (language !== null) {
    stamped = replaceHtmlLang(stamped, language.htmlLang);
    stamped = replaceOgLocale(stamped, language.ogLocale);
  }
  stamped = replaceOgTitle(stamped, title);
  stamped = replaceMetaDescription(stamped, description);
  stamped = replaceOgDescription(stamped, description);
  stamped = replaceCanonical(stamped, canonicalUrl);
  stamped = replaceOgUrl(stamped, ogUrl);
  const handle = typeof input.curatorHandle === 'string' && HANDLE_PATTERN.test(input.curatorHandle)
    && input.curatorHandle !== '.' && input.curatorHandle !== '..'
    ? input.curatorHandle
    : null;
  const curatorUrl = handle === null ? null : `${SITE_ORIGIN}/u/${encodeURIComponent(handle)}`;
  const outline = input.nodes ? outlinePublicCollection(input.nodes) : null;
  const bookmarks = outline?.entries.filter((entry) => entry.kind === 'bookmark') ?? [];
  const remaining = outline === null ? 0 : Math.max(0, input.itemCount - outline.included);
  const dateModified = Number.isFinite(Date.parse(input.updatedAt)) ? new Date(Date.parse(input.updatedAt)).toISOString() : null;
  // D1: per-collection OG card, versioned by updatedAt so edits bust social
  // caches. Hidden/private slugs never reach this stamp (generic 404 above).
  stamped = replaceOgImage(stamped, buildCollectionOgImageUrl(input.slug, input.updatedAt));
  stamped = replaceJsonLd(stamped, buildCollectionPageJsonLd({
    name: collectionTitle,
    description: fullDescription,
    url: canonicalUrl,
    numberOfItems: input.itemCount,
    inLanguage: language?.htmlLang ?? null,
    dateModified,
    creator: curator === FALLBACK_CURATOR ? null : { name: curator, url: curatorUrl },
    items: bookmarks.map((entry) => ({ name: entry.title, url: entry.url })),
  }));
  const curatorHtml = curatorUrl === null
    ? escapeHtml(curator)
    : `<a href="/u/${escapeAttr(encodeURIComponent(handle!))}">${escapeHtml(curator)}</a>`;
  stamped = replaceMarkedRegion(stamped, wrapAgentPublicFallback(
    `<h1>${escapeHtml(collectionTitle)}</h1>\n`
    + `<p>${escapeHtml(fullDescription)}</p>\n`
    + `<p>Curated by ${curatorHtml} · ${input.itemCount} items · updated ${escapeHtml(updated)}</p>\n`
    + (outline === null ? '' : renderPublicCollectionOutlineHtml(outline.entries))
    + (remaining > 0 ? `<p>and ${remaining} more</p>\n` : '')
    + `<p><a href="/colp/v0.1/collections/${encodeURIComponent(input.collectionId)}/snapshot">COLP snapshot</a></p>`,
  ));
  if (!resolveSearchIndexable(input)) stamped = insertRobotsNoindex(stamped);
  return stamped;
}

/** Visibility decides by default; an explicit `searchIndexable: false` (seed data) always wins. */
export function resolveSearchIndexable(input: {
  readonly visibility: string;
  readonly searchIndexable?: boolean;
}): boolean {
  return isSearchIndexableVisibility(input.visibility) && input.searchIndexable !== false;
}

/**
 * Folders become `<h2>`..`<h6>` by depth; consecutive bookmarks share one
 * `<ul>`. Outbound links are user-supplied, so they carry
 * `rel="nofollow ugc noopener"` and pass through the same http(s)/no-userinfo
 * acceptance as the markdown variant (done in the outline).
 */
export function renderPublicCollectionOutlineHtml(entries: readonly PublicShellOutlineEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = [];
  let open = false;
  for (const entry of entries) {
    if (entry.kind === 'folder') {
      if (open) {
        lines.push('</ul>');
        open = false;
      }
      const level = Math.min(entry.depth + 2, 6);
      lines.push(`<h${level}>${escapeHtml(entry.title)}</h${level}>`);
    } else {
      if (!open) {
        lines.push('<ul>');
        open = true;
      }
      lines.push(`  <li><a href="${escapeAttr(entry.url)}" rel="nofollow ugc noopener">${escapeHtml(entry.title)}</a></li>`);
    }
  }
  if (open) lines.push('</ul>');
  return `${lines.join('\n')}\n`;
}

function formatUpdatedDate(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return updatedAt.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}
