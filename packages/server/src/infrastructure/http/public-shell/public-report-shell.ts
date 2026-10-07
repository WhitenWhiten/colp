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
import { escapePublicShellMarkdown } from './public-collection-markdown.js';
import {
  sanitizePublicShellText,
  truncatePublicShellDescription,
} from './sanitize-public-shell-text.js';

export interface PublicReportShellIssue {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly publishedAt: string;
  /** A same-origin report URL supplied by the route mapper; null on a
      moderation tombstone, which renders without a link. */
  readonly url: string | null;
  /** 'hidden' marks a hide_public moderation tombstone (#21). */
  readonly state?: 'visible' | 'hidden';
  /** Series-scoped issue key (for example 2026-W36), when the projection exposes it. */
  readonly issueKey?: string;
  /** One-based ordinal of the Edition within its series. */
  readonly editionOrdinal?: number;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  /** Public slug of the source Collection, when the projection exposes it. */
  readonly sourceCollectionSlug?: string | null;
}

export interface PublicReportShellCurator {
  readonly profileId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
}

export interface PublicReportShellSeries {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'public' | 'unlisted';
  readonly indexable: boolean;
  readonly updatedAt: string;
  /** Public Profile summary of the series owner, when the projection exposes it. */
  readonly curator?: PublicReportShellCurator;
  readonly followerCount?: number;
  readonly sourceCollectionSlug?: string;
  readonly issues: readonly PublicReportShellIssue[];
}

export interface PublicReportShellInjectionOptions {
  /** Optional issue-detail canonical path; invalid values are ignored. */
  readonly canonicalPath?: string;
}

export const PUBLIC_REPORT_TITLE = 'Digests — Know-N';
export const PUBLIC_REPORT_PATH = '/reports';
/** Keep no-JS report documents bounded; the API issue endpoint is paginated. */
export const PUBLIC_REPORT_SHELL_ISSUE_LIMIT = 50;
const PUBLIC_REPORT_LINK_PATTERN = /^\/reports\/[^/]+(?:\/issues\/[^/]+)?$/u;

export function injectPublicReportShell(
  html: string,
  series: PublicReportShellSeries | null,
  directory: readonly PublicReportShellSeries[] = [],
  options: PublicReportShellInjectionOptions = {},
): string {
  const defaultCanonicalPath = series ? reportPath(series.slug) : PUBLIC_REPORT_PATH;
  const canonicalPath = options.canonicalPath === undefined
    ? defaultCanonicalPath
    : safeReportPath(options.canonicalPath) ?? defaultCanonicalPath;
  const canonical = `${SITE_ORIGIN}${canonicalPath}`;
  const title = series
    ? `${clean(series.title, 140)} — Know-N`
    : PUBLIC_REPORT_TITLE;
  const description = series
    ? reportDescription(series)
    : 'Public digest series and their latest issues on Know-N.';

  let output = replaceTitle(html, title);
  output = replaceOgTitle(output, title);
  output = replaceMetaDescription(output, description);
  output = replaceOgDescription(output, description);
  output = replaceCanonical(output, canonical);
  output = replaceOgUrl(output, canonical);
  output = replaceJsonLd(output, buildJsonLd(series, canonical));

  const body = series
    ? renderSeriesBody(series, description)
    : renderDirectoryBody(directory);
  output = replaceMarkedRegion(output, wrapAgentPublicFallback(body));
  if (series && !series.indexable) output = addNoIndex(output);
  return output;
}

export function buildPublicReportMarkdown(
  series: PublicReportShellSeries | null,
  directory: readonly PublicReportShellSeries[] = [],
): string {
  if (!series) {
    return [
      '# Digests',
      '',
      'Public digest series and their latest issues on Know-N.',
      '',
      ...directory.map((item) =>
        `- [${escapePublicShellMarkdown(clean(item.title, 140))}](${reportPath(item.slug)})`),
      '',
      '[llms.txt](/llms.txt)',
      '',
    ].join('\n');
  }

  const parts = [
    `# ${escapePublicShellMarkdown(clean(series.title, 140))}`,
    '',
    escapePublicShellMarkdown(clean(series.summary ?? '', 300)),
  ];
  if (series.curator) {
    parts.push('', `Curated by ${escapePublicShellMarkdown(clean(series.curator.displayName, 120))} (@${escapePublicShellMarkdown(clean(series.curator.handle, 64))})`);
  }
  if (!series.indexable) parts.push('', 'robots: noindex');
  if (series.issues.length > 0) {
    parts.push('', '## Issues', '');
    for (const issue of series.issues.slice(0, PUBLIC_REPORT_SHELL_ISSUE_LIMIT)) {
      const key = typeof issue.issueKey === 'string' && issue.issueKey.length > 0
        ? `${escapePublicShellMarkdown(clean(issue.issueKey, 128))} · `
        : '';
      const title = escapePublicShellMarkdown(clean(issue.title, 140));
      const path = issue.url === null ? null : safeReportPath(issue.url);
      const source = safeCollectionPath(issue.sourceCollectionSlug);
      const line = path ? `- [${key}${title}](${path})` : `- ${key}${title}`;
      parts.push(source ? `${line} — [Source collection](${source})` : line);
    }
  }
  parts.push('', '[llms.txt](/llms.txt)', '');
  return parts.join('\n');
}

export function buildPublicReportMarkdownNotFound(): string {
  return '# Digest not found\n\nThis digest is not available.\n\n'
    + 'See [/sitemap.xml](/sitemap.xml) and [/llms.txt](/llms.txt).\n';
}

function reportDescription(series: PublicReportShellSeries): string {
  const summary = clean(series.summary ?? '', 160);
  return truncatePublicShellDescription(
    summary || `Latest issues from ${clean(series.title, 140)}.`,
  );
}

function renderSeriesBody(
  series: PublicReportShellSeries,
  description: string,
): string {
  const heading = `<h1>${escapeHtml(clean(series.title, 140))}</h1>`;
  const intro = `<p>${escapeHtml(description)}</p>`;
  const byline = series.curator
    ? `\n<p>Curated by ${escapeHtml(clean(series.curator.displayName, 120))} (@${escapeHtml(clean(series.curator.handle, 64))})</p>`
    : '';
  if (series.issues.length === 0) return `${heading}\n${intro}${byline}\n<p>No published issues yet.</p>`;

  const issues = series.issues
    .slice(0, PUBLIC_REPORT_SHELL_ISSUE_LIMIT)
    .map(renderIssueHtml)
    .join('\n');
  return `${heading}\n${intro}${byline}\n<h2>Issues</h2>\n<ul>\n${issues}\n</ul>`;
}

function renderDirectoryBody(
  directory: readonly PublicReportShellSeries[],
): string {
  const heading = '<h1>Digests</h1>';
  const intro = '<p>Public digest series and their latest issues on Know-N.</p>';
  if (directory.length === 0) return `${heading}\n${intro}\n<p>No public digests yet.</p>`;
  const links = directory.map((item) =>
    `  <li><a href="${escapeAttr(reportPath(item.slug))}">${escapeHtml(clean(item.title, 140))}</a></li>`,
  ).join('\n');
  return `${heading}\n${intro}\n<ul>\n${links}\n</ul>`;
}

function renderIssueHtml(issue: PublicReportShellIssue): string {
  const title = escapeHtml(clean(issue.title, 140));
  const path = issue.url === null ? null : safeReportPath(issue.url);
  const source = safeCollectionPath(issue.sourceCollectionSlug);
  const sourceLink = source ? ` — <a href="${escapeAttr(source)}">Source collection</a>` : '';
  return path
    ? `  <li><a href="${escapeAttr(path)}">${title}</a>${sourceLink}</li>`
    : `  <li>${title}${sourceLink}</li>`;
}

function buildJsonLd(
  series: PublicReportShellSeries | null,
  canonical: string,
): string {
  const value = {
    '@context': 'https://schema.org',
    '@type': series ? 'Report' : 'CollectionPage',
    name: series?.title ?? 'Digests',
    url: canonical,
  };
  const escaped = escapeJsonForHtmlScript(JSON.stringify(value, null, 2));
  return `<script type="application/ld+json">\n${escaped}\n    </script>`;
}

function addNoIndex(html: string): string {
  return html.includes('noindex')
    ? html
    : html.replace('</head>', '<meta name="robots" content="noindex, nofollow">\n</head>');
}

function clean(value: string, max: number): string {
  return sanitizePublicShellText(value, max) || 'Untitled digest';
}

function reportPath(slug: string): string {
  return `${PUBLIC_REPORT_PATH}/${encodeURIComponent(slug)}`;
}

/** Resolve a projection-provided source slug to a same-origin collection path. */
function safeCollectionPath(slug: string | null | undefined): string | null {
  if (slug === undefined || slug === null || slug.length < 1 || slug.length > 63) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ? `/c/${slug}` : null;
}

/** Resolve a route-provided URL to a fixed-origin report path. */
function safeReportPath(value: string): string | null {
  try {
    const parsed = new URL(value, SITE_ORIGIN);
    if (parsed.origin !== SITE_ORIGIN || !PUBLIC_REPORT_LINK_PATTERN.test(parsed.pathname)) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}
