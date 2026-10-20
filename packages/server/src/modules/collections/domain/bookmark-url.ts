import { CollectionsError } from './errors.js';

/**
 * Known-Backend bookmark URL accept and normalize.
 *
 * Accept (Product HTTP, COLP sync, MCP write/store, Postgres invariants):
 * absolute http(s), no userinfo, 8..4096 code points, no whitespace, WHATWG
 * host. Success **preserves the original string** — no scheme/host rewrite.
 *
 * Normalize (link-health only): lowercase host; strip userinfo, hash, default
 * ports, and a trailing slash when the path is longer than one character.
 * Returns `null` on failure. Never used to rewrite stored bookmark URLs.
 * Advisory for health, redirect compare, and LibraryHealth candidates only —
 * not Node identity and not Extension mapping identity (exact raw URL).
 */

export const BOOKMARK_URL_MAX_LENGTH = 4096;
export const BOOKMARK_URL_MIN_LENGTH = 8;
/**
 * FO-05 write-path byte cap (contract x-rules enablement precondition):
 * BrowseNode.url must serialize under the 65536-byte children page budget.
 */
export const BOOKMARK_URL_MAX_BYTES = 4096;

/** Absolute http(s) URI without userinfo; host segment cannot contain @. */
const HTTP_URL_NO_USERINFO =
  /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^/?#@\s]+(?:[/?#]|$)/;

/** ECMA-262 source shared with the MCP `nodes.create` JSON Schema `pattern`. */
export const BOOKMARK_URL_HTTP_NO_USERINFO_PATTERN = HTTP_URL_NO_USERINFO.source;

function acceptedBookmarkUrlError(url: unknown): string | null {
  if (
    typeof url !== 'string'
    || url.length < BOOKMARK_URL_MIN_LENGTH
    || url.length > BOOKMARK_URL_MAX_LENGTH
  ) {
    return `url must be ${BOOKMARK_URL_MIN_LENGTH}..${BOOKMARK_URL_MAX_LENGTH} characters`;
  }
  if (Buffer.byteLength(url, 'utf8') > BOOKMARK_URL_MAX_BYTES) {
    return `url must be at most ${BOOKMARK_URL_MAX_BYTES} UTF-8 bytes`;
  }
  if (/\s/.test(url)) {
    return 'url must not contain whitespace';
  }
  if (!HTTP_URL_NO_USERINFO.test(url)) {
    return 'url must be an absolute http or https URI without userinfo';
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url is not a valid absolute URI';
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return 'url scheme must be http or https';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'url must not include userinfo';
  }
  if (!parsed.hostname) {
    return 'url must include a host';
  }

  return null;
}

/** Same accept predicate as {@link acceptBookmarkUrl}, without throwing. */
export function isAcceptedBookmarkUrl(url: unknown): boolean {
  return acceptedBookmarkUrlError(url) === null;
}

/**
 * Phase 1 Bookmark URL: absolute http/https, no userinfo, max 4096 code points.
 * Preserves the input string on success (no scheme/host case rewrite).
 */
export function acceptBookmarkUrl(url: string): string {
  const reason = acceptedBookmarkUrlError(url);
  if (reason !== null) {
    throw new CollectionsError('invalid_node_url', reason);
  }
  return url;
}

/** Thin alias for {@link acceptBookmarkUrl}; keeps `invalid_node_url`. */
export function assertValidHttpUrlNoUserInfo(url: string): string {
  return acceptBookmarkUrl(url);
}

/**
 * Bookmark URL normalization for link-health duplicate detection and redirect
 * comparison. Pure: no I/O. Invalid URLs (including userinfo) return null and
 * never equal each other.
 */
export function normalizeBookmarkUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length < 1) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hostname.length < 1) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === 'http:' && parsed.port === '80')
    || (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.href;
}

/**
 * True when `requested` is a different raw spelling of `stored` that
 * has the same parsed URL — a non-semantic rewrite the caller should
 * pin to the stored string (generation fence). Byte-identical strings and
 * unparseable inputs return false: identical needs no pin, unparseable
 * never compares equal.
 */
export function isEquivalentBookmarkUrlRewrite(
  stored: string | null,
  requested: string | null,
): boolean {
  if (stored === null || requested === null || stored === requested) return false;
  if (!isAcceptedBookmarkUrl(stored) || !isAcceptedBookmarkUrl(requested)) return false;
  // Content identity includes fragment routes and path trailing slashes. The
  // link-health normalizer deliberately drops these and must never decide
  // whether to discard a user's bookmark edit. URL serialization only folds
  // equivalent syntax such as scheme/host case and the default port here.
  return new URL(stored).href === new URL(requested).href;
}

/** A URL-only editor cannot maintain metadata derived from the old URL.
 * Explicitly submitted metadata remains subject to normal validation. Call
 * after any equivalent-spelling pin so unchanged URLs retain their metadata. */
export function invalidateOmittedBookmarkUrlMetadata<T extends Readonly<Record<string, unknown>>>(
  fields: T,
  current: Readonly<Record<string, unknown>>,
): T {
  if (typeof fields.url !== 'string' || fields.url === current.url) return fields;
  const cleared: Record<string, unknown> = { ...fields };
  for (const field of ['canonicalUrl', 'urlHash']) {
    if (!Object.hasOwn(fields, field) && current[field] !== undefined && current[field] !== null) cleared[field] = null;
  }
  return cleared as T;
}
