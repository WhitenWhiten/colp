/**
 * Typed copy of `Known-Frontend/web/scripts/spa-html-meta.mjs`.
 * Keep replacements equivalent; `spa-html-meta-equivalence.test.ts` pins both.
 * Strategy (recorded on public-surfaces.md): source-copy, not a workspace package.
 */

export const SITE_ORIGIN = 'https://know-n.com';
export const MARKER_START = '<!-- agent-public:start -->';
export const MARKER_END = '<!-- agent-public:end -->';
export const HOME_CANONICAL = '<link rel="canonical" href="https://know-n.com/" />';
export const HOME_OG_URL = '<meta property="og:url" content="https://know-n.com/" />';
export const HOME_HTML_LANG = '<html lang="en">';
export const HOME_OG_LOCALE = '<meta property="og:locale" content="en_US" />';
export const SITE_OG_IMAGE_URL = 'https://know-n.com/og-cover.png';

const TITLE_PATTERN = /<title>[^<]*<\/title>/u;
const OG_TITLE_PATTERN = /<meta property="og:title" content="[^"]*" \/>/u;
const META_DESCRIPTION_PATTERN = /<meta name="description" content="[^"]*" \/>/u;
const OG_DESCRIPTION_PATTERN = /<meta property="og:description" content="[^"]*" \/>/u;
const JSON_LD_PATTERN = /<script type="application\/ld\+json">[\s\S]*?<\/script>/u;
const OG_IMAGE_PATTERN = /<meta property="og:image" content="[^"]*" \/>/u;
const OG_TYPE_PATTERN = /<meta property="og:type" content="[^"]*" \/>/u;

export function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/gu, '&quot;');
}

/** Escape JSON before embedding it in an HTML raw-text script element. */
export function escapeJsonForHtmlScript(json: string): string {
  return json
    .replace(/&/gu, '\\u0026')
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

export function replaceExact(
  html: string,
  pattern: string | RegExp,
  replacement: string,
  label: string,
): string {
  if (pattern instanceof RegExp) {
    if (!pattern.test(html)) {
      throw new Error(`Failed to replace ${label}: pattern not found`);
    }
    pattern.lastIndex = 0;
    return html.replace(pattern, () => replacement);
  }
  if (!html.includes(pattern)) {
    throw new Error(`Failed to replace ${label}: pattern not found`);
  }
  return html.replace(pattern, () => replacement);
}

export function removeExact(html: string, snippet: string, label: string): string {
  if (!html.includes(snippet)) {
    throw new Error(`Failed to remove ${label}: pattern not found`);
  }
  return html.replace(`    ${snippet}\n`, '').replace(`${snippet}\n`, '').replace(snippet, '');
}

export function replaceMarkedRegion(html: string, inner: string): string {
  const start = html.indexOf(MARKER_START);
  const end = html.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`dist/index.html must contain ${MARKER_START} and ${MARKER_END} inside #root`);
  }
  const before = html.slice(0, start + MARKER_START.length);
  const after = html.slice(end);
  return `${before}\n${inner}\n      ${after}`;
}

export function wrapAgentPublicFallback(html: string): string {
  return `<div id="agent-public-fallback" hidden>\n${html}\n</div>`;
}

export function replaceTitle(html: string, title: string): string {
  return replaceExact(html, TITLE_PATTERN, `<title>${escapeHtml(title)}</title>`, '<title>');
}

export function replaceOgTitle(html: string, title: string): string {
  return replaceExact(
    html,
    OG_TITLE_PATTERN,
    `<meta property="og:title" content="${escapeAttr(title)}" />`,
    'og:title',
  );
}

export function replaceOgType(html: string, type: string): string {
  return replaceExact(
    html,
    OG_TYPE_PATTERN,
    `<meta property="og:type" content="${escapeAttr(type)}" />`,
    'og:type',
  );
}

export function replaceMetaDescription(html: string, description: string): string {
  return replaceExact(
    html,
    META_DESCRIPTION_PATTERN,
    `<meta name="description" content="${escapeAttr(description)}" />`,
    'meta description',
  );
}

export function replaceOgDescription(html: string, description: string): string {
  return replaceExact(
    html,
    OG_DESCRIPTION_PATTERN,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    'og:description',
  );
}

export function replaceCanonical(html: string, pageUrl: string): string {
  return replaceExact(html, HOME_CANONICAL, `<link rel="canonical" href="${pageUrl}" />`, 'canonical');
}

export function replaceOgUrl(html: string, pageUrl: string): string {
  return replaceExact(html, HOME_OG_URL, `<meta property="og:url" content="${pageUrl}" />`, 'og:url');
}

export function replaceHtmlLang(html: string, lang: string): string {
  return replaceUniqueExact(html, HOME_HTML_LANG, `<html lang="${escapeAttr(lang)}">`, 'html lang');
}

/** Replace the single English baseline, or remove it for a language-only tag. */
export function replaceOgLocale(html: string, ogLocale: string | null): string {
  const replacement = ogLocale === null
    ? ''
    : `<meta property="og:locale" content="${escapeAttr(ogLocale)}" />`;
  return replaceUniqueExact(html, HOME_OG_LOCALE, replacement, 'og:locale');
}

function replaceUniqueExact(html: string, snippet: string, replacement: string, label: string): string {
  const count = html.split(snippet).length - 1;
  if (count !== 1) {
    throw new Error(`Failed to replace ${label}: expected exactly one baseline, found ${count}`);
  }
  if (replacement === '') {
    return html.replace(`    ${snippet}\n`, '').replace(`${snippet}\n`, '').replace(snippet, '');
  }
  return html.replace(snippet, () => replacement);
}

export function replaceJsonLd(html: string, script: string): string {
  return replaceExact(html, JSON_LD_PATTERN, script, 'JSON-LD');
}

/** P3 injection point: swap the site-wide og:image for a per-collection URL. */
export function replaceOgImage(html: string, imageUrl: string): string {
  return replaceExact(
    html,
    OG_IMAGE_PATTERN,
    `<meta property="og:image" content="${escapeAttr(imageUrl)}" />`,
    'og:image',
  );
}

export function buildWebPageJsonLd(input: {
  readonly name: string;
  readonly description: string;
  readonly url: string;
}): string {
  const body = escapeJsonForHtmlScript(JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: input.name,
      description: input.description,
      url: input.url,
    },
    null,
    2,
  ))
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return `<script type="application/ld+json">\n${body}\n    </script>`;
}

export function applyPageHead(
  indexHtml: string,
  input: {
    readonly title: string;
    readonly description: string;
    readonly canonicalPath: string | null;
    readonly ogUrlPath?: string;
  },
): string {
  let html = replaceTitle(indexHtml, input.title);
  html = replaceOgTitle(html, input.title);
  html = replaceMetaDescription(html, input.description);
  html = replaceOgDescription(html, input.description);
  if (input.canonicalPath == null) {
    html = removeExact(html, HOME_CANONICAL, 'canonical');
    html = removeExact(html, HOME_OG_URL, 'og:url');
    html = replaceExact(html, /<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/u, '', 'JSON-LD');
    return html;
  }
  const pageUrl = `${SITE_ORIGIN}${input.canonicalPath}`;
  const ogUrl = `${SITE_ORIGIN}${input.ogUrlPath ?? input.canonicalPath}`;
  html = replaceCanonical(html, pageUrl);
  html = replaceOgUrl(html, ogUrl);
  return replaceJsonLd(html, buildWebPageJsonLd({
    name: input.title, description: input.description, url: pageUrl,
  }));
}
