// Generated from Know-N's server classification policy. Do not edit: Know-N regenerates this file.
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
  if (new TextEncoder().encode(url).length > BOOKMARK_URL_MAX_BYTES) {
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
