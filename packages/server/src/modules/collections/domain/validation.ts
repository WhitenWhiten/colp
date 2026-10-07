import { BookmarkFaviconValidationError, CollectionsError } from './errors.js';

export const COLLECTION_KINDS = [
  'bookmarks',
  'reading_path',
  'knowledge_collection',
  'mixed',
] as const;

export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export const NODE_KINDS = ['folder', 'bookmark'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_VISIBILITIES = ['inherit', 'protected', 'private'] as const;
export type NodeVisibility = (typeof NODE_VISIBILITIES)[number];

const TITLE_MAX = 512;
const SUMMARY_MAX = 2000;
const DESCRIPTION_MAX = 20_000;
const TAG_MAX_ITEMS = 64;
const TAG_MAX_LENGTH = 64;
/**
 * FO-05 write-path byte caps (contract x-rules enablement precondition):
 * one maximal BrowseNode item must serialize under half of the 65536-byte
 * children page budget, which requires UTF-8 BYTE caps — not just code-point
 * caps — on the canonical node fields.
 */
const TITLE_MAX_BYTES = 1024;
const DESCRIPTION_MAX_BYTES = 16_384;

export {
  acceptBookmarkUrl,
  assertValidHttpUrlNoUserInfo,
  isAcceptedBookmarkUrl,
} from './bookmark-url.js';

export function assertValidCollectionTitle(title: string): string {
  if (typeof title !== 'string' || title.length < 1 || title.length > TITLE_MAX) {
    throw new CollectionsError(
      'invalid_collection_title',
      `title must be 1..${TITLE_MAX} characters`,
    );
  }
  if (title.trim().length === 0) {
    throw new CollectionsError(
      'invalid_collection_title',
      'title cannot be whitespace-only',
    );
  }
  return title;
}

export function assertValidCollectionSummary(summary: string | null): string | null {
  if (summary === null) return null;
  if (typeof summary !== 'string' || summary.length > SUMMARY_MAX) {
    throw new CollectionsError(
      'invalid_collection_summary',
      `summary must be null or at most ${SUMMARY_MAX} characters`,
    );
  }
  return summary;
}

export function assertValidCollectionKind(kind: string): CollectionKind {
  if (!(COLLECTION_KINDS as readonly string[]).includes(kind)) {
    throw new CollectionsError(
      'invalid_collection_kind',
      `kind must be one of: ${COLLECTION_KINDS.join(', ')}`,
    );
  }
  return kind as CollectionKind;
}

export function assertNonEmptyField(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CollectionsError('invalid_collection_input', `${field} is required`);
  }
  return value;
}

/** Node title: same length/blank rules as Collection title plus the FO-05 byte cap. */
export function assertValidNodeTitle(title: string): string {
  if (typeof title !== 'string' || title.length < 1 || title.length > TITLE_MAX) {
    throw new CollectionsError(
      'invalid_node_title',
      `title must be 1..${TITLE_MAX} characters`,
    );
  }
  if (title.trim().length === 0) {
    throw new CollectionsError(
      'invalid_node_title',
      'title cannot be whitespace-only',
    );
  }
  if (Buffer.byteLength(title, 'utf8') > TITLE_MAX_BYTES) {
    throw new CollectionsError(
      'invalid_node_title',
      `title must be at most ${TITLE_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return title;
}

export function assertValidNodeDescription(description: string | null): string | null {
  if (description === null) return null;
  if (typeof description !== 'string' || description.length > DESCRIPTION_MAX) {
    throw new CollectionsError(
      'invalid_node_description',
      `description must be null or at most ${DESCRIPTION_MAX} characters`,
    );
  }
  if (Buffer.byteLength(description, 'utf8') > DESCRIPTION_MAX_BYTES) {
    throw new CollectionsError(
      'invalid_node_description',
      `description must be at most ${DESCRIPTION_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return description;
}

/**
 * Tags: max 64 items, each 1..64 code points, case-sensitive exact dedupe preserving order.
 * Whitespace-only tags rejected; no silent trim/normalization.
 */
export function assertValidNodeTags(tags: readonly string[]): readonly string[] {
  if (!Array.isArray(tags)) {
    throw new CollectionsError('invalid_node_tags', 'tags must be an array');
  }
  if (tags.length > TAG_MAX_ITEMS) {
    throw new CollectionsError(
      'invalid_node_tags',
      `tags must have at most ${TAG_MAX_ITEMS} items`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (typeof tag !== 'string' || tag.length < 1 || tag.length > TAG_MAX_LENGTH) {
      throw new CollectionsError(
        'invalid_node_tags',
        `tags[${i}] must be 1..${TAG_MAX_LENGTH} characters`,
      );
    }
    if (tag.trim().length === 0) {
      throw new CollectionsError(
        'invalid_node_tags',
        `tags[${i}] cannot be whitespace-only`,
      );
    }
    if (seen.has(tag)) {
      throw new CollectionsError(
        'invalid_node_tags',
        `tags must be unique (duplicate "${tag}")`,
      );
    }
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function assertValidNodeVisibility(visibility: string): NodeVisibility {
  if (!(NODE_VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new CollectionsError(
      'invalid_node_visibility',
      `visibility must be one of: ${NODE_VISIBILITIES.join(', ')}`,
    );
  }
  return visibility as NodeVisibility;
}

const FAVICON_URL_MAX = 2048;
/** FO-05 write-path byte cap: the resolved icon URL must fit the children page budget. */
const FAVICON_URL_MAX_BYTES = 2048;
const SAME_ORIGIN_FAVICON_PATH_PATTERN = /^\/api\/v1\/favicon\/[a-f0-9-]{36}$/iu;

function parseStrictHttpsFaviconUrl(value: string): string | null {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.href.includes('#')) {
    return null;
  }
  if (parsed.href.length > FAVICON_URL_MAX) return null;
  if (Buffer.byteLength(parsed.href, 'utf8') > FAVICON_URL_MAX_BYTES) return null;
  return parsed.href;
}

/**
 * Same-origin Product favicon URL: HTTPS, no userinfo, no fragment, no
 * non-default port, path exactly `/api/v1/favicon/{uuid}` with `[a-f0-9-]{36}` i.
 * External URLs are rejected. Do not import identity for this predicate.
 */
export function assertSameOriginFaviconUrl(
  faviconUrl: string,
  productOrigin: string,
): string {
  const canonical = parseStrictHttpsFaviconUrl(faviconUrl);
  if (canonical === null) {
    throw new BookmarkFaviconValidationError(
      'favicon URL must be an absolute https URL without userinfo, fragment, or non-default port',
    );
  }
  let origin: URL;
  try {
    origin = new URL(productOrigin);
  } catch {
    throw new BookmarkFaviconValidationError(
      'favicon URL must be a same-origin /api/v1/favicon/<uuid> URL',
    );
  }
  const url = new URL(canonical);
  if (url.origin !== origin.origin || !SAME_ORIGIN_FAVICON_PATH_PATTERN.test(url.pathname)) {
    throw new BookmarkFaviconValidationError(
      'favicon URL must be a same-origin /api/v1/favicon/<uuid> URL',
    );
  }
  return canonical;
}

export function assertValidNodeKind(kind: string): NodeKind {
  if (!(NODE_KINDS as readonly string[]).includes(kind)) {
    throw new CollectionsError(
      'invalid_node_kind',
      `kind must be one of: ${NODE_KINDS.join(', ')}`,
    );
  }
  return kind as NodeKind;
}
