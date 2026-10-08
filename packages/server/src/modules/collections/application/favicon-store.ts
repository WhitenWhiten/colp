import { Readable } from 'node:stream';

export const BOOKMARK_FAVICON_MAX_BYTES = 65_536;
export const BOOKMARK_FAVICON_CANONICAL_CONTENT_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
] as const);

export type BookmarkFaviconCanonicalMime =
  (typeof BOOKMARK_FAVICON_CANONICAL_CONTENT_TYPES)[number];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Application-layer sniff failure. Transport maps GET failures to 404
 * `resource_not_found` (no existence oracle). Do not use IdentityError.
 */
export class BookmarkFaviconImageError extends Error {
  constructor(message = 'favicon image is not a supported raster type') {
    super(message);
    this.name = 'BookmarkFaviconImageError';
  }
}

export interface StoredBookmarkFavicon {
  readonly contentType: string;
  readonly body: Buffer;
}

export interface BookmarkFaviconObjectStore {
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(objectId: string, options?: { readonly signal?: AbortSignal }): Promise<StoredBookmarkFavicon | null>;
  /** Best-effort removal of a stored favicon object. */
  delete(objectId: string): Promise<void>;
  /** Optional owned-client shutdown; in-memory/test stores own no client. */
  close?(): Promise<void>;
}

/**
 * Identify a bookmark favicon by magic bytes only. Declared MIME (R2
 * Content-Type, upload Content-Type) is ignored. CUR (`00 00 02 00`), SVG,
 * GIF, HTML, empty, and unknown payloads return null.
 */
export function sniffBookmarkFaviconCanonicalMime(
  body: Buffer,
): BookmarkFaviconCanonicalMime | null {
  if (body.byteLength === 0) return null;
  if (body.byteLength >= 8 && body.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (body.byteLength >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    body.byteLength >= 12
    && body.subarray(0, 4).toString('ascii') === 'RIFF'
    && body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (body.byteLength >= 4 && body[0] === 0x00 && body[1] === 0x00 && body[2] === 0x01 && body[3] === 0x00) {
    return 'image/x-icon';
  }
  return null;
}

/** Magic-only favicon assertion. Returns the canonical MIME to send on GET. */
export function assertBookmarkFaviconImage(body: Buffer): BookmarkFaviconCanonicalMime {
  if (body.byteLength > BOOKMARK_FAVICON_MAX_BYTES) {
    throw new BookmarkFaviconImageError(
      `favicon image must be at most ${BOOKMARK_FAVICON_MAX_BYTES} bytes`,
    );
  }
  const mime = sniffBookmarkFaviconCanonicalMime(body);
  if (!mime) throw new BookmarkFaviconImageError();
  return mime;
}

function destroyFaviconReadStream(stream: Readable): void {
  try {
    if (!stream.destroyed) stream.destroy();
  } catch {
    // Socket teardown is best-effort; the caller still treats the object as missing.
  }
}

/**
 * Consume a Node Readable into a Buffer, aborting as soon as `maxBytes + 1`
 * arrives. Peak retained bytes stay O(maxBytes + one chunk); the overflowing
 * chunk is not concatenated. Destroy the source on overflow so HTTP sockets
 * are not held open. Empty bodies return null.
 */
export async function readFaviconBodyCapped(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | null> {
  const collected: Buffer[] = [];
  let total = 0;
  let oversized = false;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + buf.byteLength > maxBytes) {
        oversized = true;
        destroyFaviconReadStream(stream);
        break;
      }
      collected.push(buf);
      total += buf.byteLength;
    }
  } catch (error) {
    if (oversized) return null;
    destroyFaviconReadStream(stream);
    throw error;
  }
  if (oversized) return null;
  if (total === 0) return null;
  return Buffer.concat(collected, total);
}
