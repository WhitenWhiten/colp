/**
 * LP-02 link preview candidate selection (pure; no I/O, no DOM).
 *
 * Input is the flat list of `<meta>` / `<link>` facts an adapter read from
 * the page. Output is at most LINK_PREVIEW_MAX_CANDIDATES absolute image
 * URLs in the fixed D1 precedence: og:image:secure_url, og:image,
 * og:image:url, twitter:image, twitter:image:src, link[rel~=image_src].
 * Within one key, document order wins. Duplicates collapse to the first.
 */
export type LinkPreviewSource = 'rule' | 'og' | 'twitter' | 'image_src';

export type LinkPreviewHeadTag =
  | { readonly kind: 'meta'; readonly key: string; readonly content: string }
  | { readonly kind: 'link'; readonly rel: string; readonly href: string };

export interface LinkPreviewCandidate {
  readonly url: string;
  readonly source: LinkPreviewSource;
}

export const LINK_PREVIEW_MAX_CANDIDATES = 3;
export const LINK_PREVIEW_IMAGE_URL_MAX_LENGTH = 2048;

const META_PRECEDENCE: ReadonlyArray<readonly [key: string, source: LinkPreviewSource]> = [
  ['og:image:secure_url', 'og'],
  ['og:image', 'og'],
  ['og:image:url', 'og'],
  ['twitter:image', 'twitter'],
  ['twitter:image:src', 'twitter'],
];

/**
 * Resolve a page-supplied image reference to an absolute http(s) URL, or
 * null. `data:`, `javascript:`, userinfo and over-long URLs never pass.
 */
export function resolvePreviewImageUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > LINK_PREVIEW_IMAGE_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname.length === 0) return null;
  parsed.hash = '';
  return parsed.href.length > LINK_PREVIEW_IMAGE_URL_MAX_LENGTH ? null : parsed.href;
}

export function selectPreviewCandidates(
  tags: readonly LinkPreviewHeadTag[],
  baseUrl: string,
): LinkPreviewCandidate[] {
  const ordered: Array<{ readonly value: string; readonly source: LinkPreviewSource }> = [];
  for (const [key, source] of META_PRECEDENCE) {
    for (const tag of tags) {
      if (tag.kind === 'meta' && tag.key.trim().toLowerCase() === key) ordered.push({ value: tag.content, source });
    }
  }
  for (const tag of tags) {
    if (tag.kind === 'link' && tag.rel.toLowerCase().split(/\s+/u).includes('image_src')) {
      ordered.push({ value: tag.href, source: 'image_src' });
    }
  }
  const seen = new Set<string>();
  const candidates: LinkPreviewCandidate[] = [];
  for (const entry of ordered) {
    const url = resolvePreviewImageUrl(entry.value, baseUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, source: entry.source });
    if (candidates.length === LINK_PREVIEW_MAX_CANDIDATES) break;
  }
  return candidates;
}
