export const BOOKMARK_FAVICON_MAX_BYTES = 65_536;
export const BOOKMARK_FAVICON_CANONICAL_CONTENT_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/webp', 'image/x-icon',
] as const);
export type BookmarkFaviconCanonicalMime =
  (typeof BOOKMARK_FAVICON_CANONICAL_CONTENT_TYPES)[number];

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/**
 * Identify a bookmark favicon by magic bytes only. CUR (`00 00 02 00`), SVG,
 * GIF, HTML, empty, and unknown payloads return null. Port of the backend
 * sniffer; Uint8Array because the extension bundle has no Node Buffer.
 */
export function sniffBookmarkFaviconCanonicalMime(
  body: Uint8Array,
): BookmarkFaviconCanonicalMime | null {
  if (body.byteLength === 0) return null;
  if (body.byteLength >= 8 && prefixEquals(body, PNG_MAGIC)) return 'image/png';
  if (body.byteLength >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg';
  }
  if (body.byteLength >= 12 && asciiAt(body, 0, 'RIFF') && asciiAt(body, 8, 'WEBP')) return 'image/webp';
  if (body.byteLength >= 4 && body[0] === 0x00 && body[1] === 0x00 && body[2] === 0x01 && body[3] === 0x00) {
    return 'image/x-icon';
  }
  return null;
}

function prefixEquals(body: Uint8Array, magic: Uint8Array): boolean {
  for (let index = 0; index < magic.byteLength; index += 1) {
    if (body[index] !== magic[index]) return false;
  }
  return true;
}

function asciiAt(body: Uint8Array, start: number, expected: string): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (body[start + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}
