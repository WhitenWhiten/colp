import { BOOKMARK_FAVICON_MAX_BYTES, sniffBookmarkFaviconCanonicalMime,
  type BookmarkFaviconCanonicalMime } from './favicon-sniff.js';

export interface DecodedBookmarkFavicon {
  readonly contentType: BookmarkFaviconCanonicalMime;
  readonly bytes: Uint8Array;
}

const MAX_BASE64_CHARS = Math.ceil(BOOKMARK_FAVICON_MAX_BYTES * 4 / 3) + 4;

/**
 * Decode a Netscape ICON data URL into sniffed favicon bytes. Never fetches.
 * Accepts `data:image/png;base64,...` and `data:;base64,...` with optional charset.
 */
export function decodeBookmarkFaviconDataUrl(icon: string): DecodedBookmarkFavicon | null {
  if (typeof icon !== 'string') return null;
  const value = icon.trim();
  if (!value.toLowerCase().startsWith('data:')) return null;
  const rest = value.slice(5);
  const comma = rest.indexOf(',');
  if (comma < 0) return null;
  const tokens = rest.slice(0, comma).split(';').map((part) => part.trim());
  if (!tokens.some((part) => part.toLowerCase() === 'base64')) return null;
  const mediaType = declaredMediaType(tokens);
  if (mediaType === 'text/html' || mediaType === 'image/svg+xml') return null;
  const payload = rest.slice(comma + 1);
  if (payload.length === 0 || payload.length > MAX_BASE64_CHARS) return null;
  let binary: string;
  try { binary = atob(payload); } catch { return null; }
  if (binary.length === 0 || binary.length > BOOKMARK_FAVICON_MAX_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const contentType = sniffBookmarkFaviconCanonicalMime(bytes);
  if (!contentType) return null;
  return { contentType, bytes };
}

function declaredMediaType(tokens: readonly string[]): string {
  const first = tokens[0]?.toLowerCase() ?? '';
  if (!first || first === 'base64' || first.startsWith('charset=')) return '';
  return first;
}
