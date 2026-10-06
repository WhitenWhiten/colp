import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';

import type { BookmarkUrl, HttpUrl } from '../types/index.js';

const addFormats = addFormatsImport as unknown as FormatsPlugin;
const uriFormat = addFormats.get('uri') as (value: string) => boolean;
const absoluteUriPattern = /^[A-Za-z][A-Za-z0-9+.-]*:[^\u0000-\u0020\u007F]*$/u;
const httpUrlPattern = /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/iu;
const httpUrlUserInfoPattern = /^https?:\/\/[^/?#]*@/iu;
const httpsNamespacePattern = /^https:\/\/(?:\[[^\]]+\]|[^:/?#@]+)(?::[0-9]+)?(?:[/?#]|$)/iu;
const unsafeBookmarkSchemePattern = /^(?:javascript|vbscript|data):/iu;

/** RFC 3986 URI assertion shared with the canonical JSON Schema validator. */
export function isRfc3986Uri(value: string): boolean {
  return uriFormat(value);
}

/** Absolute RFC 3986 URI assertion matching the Schema's shared lexical constraints. */
export function isAbsoluteRfc3986Uri(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 4096 &&
    absoluteUriPattern.test(value) &&
    isRfc3986Uri(value)
  );
}

/** Absolute HTTP(S) URL assertion matching the canonical `$defs.httpUrl` contract. */
export function isHttpUrl(value: unknown): value is HttpUrl {
  return (
    isAbsoluteRfc3986Uri(value) &&
    httpUrlPattern.test(value) &&
    !httpUrlUserInfoPattern.test(value)
  );
}

/** HTTPS Namespace assertion requiring a host, no userinfo, and a valid optional port. */
export function isHttpsNamespaceUri(value: unknown): value is string {
  return typeof value === 'string' && httpsNamespacePattern.test(value) && isRfc3986Uri(value);
}

/** Bookmark URI assertion matching the canonical `$defs.bookmarkUrl` contract. */
export function isBookmarkUrl(value: unknown): value is BookmarkUrl {
  return isAbsoluteRfc3986Uri(value) && !unsafeBookmarkSchemePattern.test(value);
}

/**
 * Validate a Bookmark URL without changing any code unit of the caller's value.
 *
 * This deliberately does not use `URL`: parsing and serializing can fold case,
 * remove default ports, rewrite escapes, or otherwise invalidate opaque query
 * signatures. Sensitivity is a caller/source-protocol fact, not something this
 * function guesses from query parameter names.
 */
export function preserveBookmarkUrl(value: unknown): BookmarkUrl {
  if (!isBookmarkUrl(value)) {
    throw new TypeError(
      'Bookmark URL must be an absolute RFC 3986 URI without control characters or an executable scheme.',
    );
  }
  return value;
}

/** Returns the normalized scheme of an absolute URI, without invoking WHATWG URL parsing. */
export function absoluteUriScheme(value: string): string | undefined {
  if (!isAbsoluteRfc3986Uri(value)) return undefined;
  return value.slice(0, value.indexOf(':')).toLowerCase();
}
