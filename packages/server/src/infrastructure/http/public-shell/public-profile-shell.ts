import {
  PUBLIC_SHELL_DESCRIPTION_MAX,
  PUBLIC_SHELL_META_DESCRIPTION_MAX,
  PUBLIC_SHELL_TITLE_MAX,
  sanitizePublicShellText,
  truncatePublicShellDescription,
} from './sanitize-public-shell-text.js';
import { escapePublicShellMarkdown } from './public-collection-markdown.js';
import { insertRobotsNoindex } from './inject-collection-shell.js';
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
  replaceOgType,
  replaceOgUrl,
  replaceTitle,
  SITE_ORIGIN,
  wrapAgentPublicFallback,
} from './spa-html-meta.js';

export const PUBLIC_PROFILE_DESCRIPTION_MAX = PUBLIC_SHELL_META_DESCRIPTION_MAX;
export const PUBLIC_PROFILE_DISPLAY_NAME_MAX = 120;
export const PUBLIC_PROFILE_HANDLE_MAX = 64;

export interface PublicProfileShellCollection {
  readonly slug: string;
  readonly title: string;
  readonly updatedAt: string;
  /** `false` for seed-registered collections: still listed, but not counted for indexability. */
  readonly searchIndexable?: boolean;
}

export interface PublicProfileShellInput {
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly collections: readonly PublicProfileShellCollection[];
  readonly hasMoreCollections: boolean;
}

/** Indexable iff at least one listed public collection is itself search-indexable (not seed data). */
export function isIndexableProfile(
  input: Pick<PublicProfileShellInput, 'collections'>,
): boolean {
  return input.collections.some((collection) => collection.searchIndexable !== false);
}

export function buildProfilePageJsonLd(input: {
  readonly name: string;
  readonly url: string;
}): string {
  const body = escapeJsonForHtmlScript(JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url: input.url,
    mainEntity: {
      '@type': 'Person',
      name: input.name,
      url: input.url,
    },
  }, null, 2))
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return `<script type="application/ld+json">\n${body}\n    </script>`;
}

export function injectPublicProfileShell(html: string, input: PublicProfileShellInput): string {
  const normalized = normalizeProfile(input);
  const canonicalUrl = `${SITE_ORIGIN}/u/${encodeURIComponent(normalized.handle)}`;
  const title = `${normalized.displayName} (@${normalized.handle}) — Know-N`;
  const description = profileDescription(
    input.bio,
    normalized.displayName,
    normalized.collections.length,
    normalized.hasMoreCollections,
  );

  let stamped = replaceTitle(html, title);
  stamped = replaceOgTitle(stamped, title);
  stamped = replaceOgType(stamped, 'profile');
  stamped = replaceMetaDescription(stamped, description);
  stamped = replaceOgDescription(stamped, description);
  stamped = replaceCanonical(stamped, canonicalUrl);
  stamped = replaceOgUrl(stamped, canonicalUrl);
  stamped = replaceJsonLd(stamped, buildProfilePageJsonLd({
    name: normalized.displayName,
    url: canonicalUrl,
  }));

  const bio = normalized.bio || description;
  const collectionLinks = normalized.collections.length === 0
    ? '<p>No public collections yet.</p>'
    : `<h2>Public collections</h2>\n<ul>\n${normalized.collections.map((collection) =>
      `  <li><a href="/c/${escapeAttr(encodeURIComponent(collection.slug))}">${escapeHtml(collection.title)}</a></li>`
    ).join('\n')}\n</ul>`;
  const moreCollections = normalized.hasMoreCollections
    ? '\n<p>More public collections are available.</p>'
    : '';
  stamped = replaceMarkedRegion(stamped, wrapAgentPublicFallback(
    `<h1>${escapeHtml(normalized.displayName)}</h1>\n`
    + `<p>${escapeHtml(bio)}</p>\n`
    + `${collectionLinks}${moreCollections}`,
  ));
  if (!isIndexableProfile(normalized)) stamped = insertRobotsNoindex(stamped);
  return stamped;
}

export function buildPublicProfileMarkdown(input: PublicProfileShellInput): string {
  const normalized = normalizeProfile(input);
  const description = profileDescription(
    input.bio,
    normalized.displayName,
    normalized.collections.length,
    normalized.hasMoreCollections,
  );
  const parts = [
    `# ${escapePublicShellMarkdown(normalized.displayName)}`,
    '',
    `@${escapePublicShellMarkdown(normalized.handle)}`,
    '',
    escapePublicShellMarkdown(normalized.bio || description),
  ];
  if (!isIndexableProfile(normalized)) {
    parts.push('', 'robots: noindex');
  }
  if (normalized.collections.length > 0) {
    parts.push('', '## Public collections', '');
    for (const collection of normalized.collections) {
      parts.push(`- [${escapePublicShellMarkdown(collection.title)}](/c/${encodeURIComponent(collection.slug)})`);
    }
  }
  if (normalized.hasMoreCollections) {
    parts.push('', 'More public collections are available.');
  }
  parts.push('', '[llms.txt](/llms.txt)', '');
  return parts.join('\n');
}

export function buildPublicProfileMarkdownNotFound(): string {
  return [
    '# Profile not found',
    '',
    'This profile is not available.',
    '',
    'See [/sitemap.xml](/sitemap.xml) and [/llms.txt](/llms.txt).',
    '',
  ].join('\n');
}

function normalizeProfile(input: PublicProfileShellInput): PublicProfileShellInput {
  // Must stay aligned with identity's isCanonicalPublicProfileHandle without
  // creating an infrastructure-http -> identity-module dependency.
  if (input.handle === '.' || input.handle === '..'
      || !/^[a-z0-9._~-]{1,64}$/u.test(input.handle)) {
    throw new TypeError('public Profile shell requires a canonical public Profile handle');
  }
  const handle = input.handle;
  const displayName = sanitizePublicShellText(input.displayName, PUBLIC_PROFILE_DISPLAY_NAME_MAX)
    || `@${handle}`;
  return {
    handle,
    displayName,
    bio: sanitizePublicShellText(input.bio, PUBLIC_SHELL_DESCRIPTION_MAX * 4),
    collections: input.collections.map((collection) => ({
      slug: sanitizePublicShellText(collection.slug, PUBLIC_SHELL_TITLE_MAX),
      title: sanitizePublicShellText(collection.title, PUBLIC_SHELL_TITLE_MAX) || 'Untitled',
      updatedAt: sanitizePublicShellText(collection.updatedAt, PUBLIC_SHELL_TITLE_MAX),
      ...(collection.searchIndexable === false ? { searchIndexable: false as const } : {}),
    })),
    hasMoreCollections: input.hasMoreCollections,
  };
}

function profileDescription(
  bio: string,
  displayName: string,
  collectionCount: number,
  hasMoreCollections: boolean,
): string {
  const firstParagraph = bio
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .split(/\n\s*\n/u, 1)[0] ?? '';
  const normalized = sanitizePublicShellText(firstParagraph, PUBLIC_SHELL_DESCRIPTION_MAX);
  if (normalized === '') {
    if (hasMoreCollections) {
      return `${displayName} curates more than ${collectionCount} public collections on Know-N`;
    }
    const noun = collectionCount === 1 ? 'collection' : 'collections';
    return `${displayName} curates ${collectionCount} public ${noun} on Know-N`;
  }
  return truncatePublicShellDescription(normalized, PUBLIC_PROFILE_DESCRIPTION_MAX);
}
