/**
 * FO-02 favicon image structural decoding (pure; no I/O).
 *
 * Upload already sniffs canonical raster magic; the online chain additionally
 * DECODES the fetched bytes before fixing them to an immutable object:
 *
 * - PNG: signature + IHDR validation, full chunk walk with CRC-32 checks,
 *   bounded IDAT inflation and exact scanline-size verification (this is the
 *   "decompressed size" enforcement);
 * - JPEG: marker walk from SOI to EOI with a required SOF frame and sane
 *   dimensions;
 * - WebP: RIFF/WEBP structure with a VP8/VP8L/VP8X dimension decode;
 * - ICO: directory entries and an embedded PNG/BMP payload within bounds.
 *
 * Anything that does not fully parse throws `BookmarkFaviconImageError`;
 * callers treat it as `invalid_image`. No magic-byte-only acceptance, no
 * polyglot tolerance, no unbounded allocation.
 */
import { inflateSync } from 'node:zlib';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  BookmarkFaviconImageError,
  sniffBookmarkFaviconCanonicalMime,
  type BookmarkFaviconCanonicalMime,
} from './favicon-store.js';

export interface DecodedFaviconImage {
  readonly mime: BookmarkFaviconCanonicalMime;
  readonly width: number;
  readonly height: number;
}

export const FAVICON_MAX_IMAGE_DIMENSION = 4096;
/** Default decompressed PNG budget: 64x the wire cap (a generous real-icon bound). */
export const FAVICON_DEFAULT_MAX_DECOMPRESSED_BYTES = BOOKMARK_FAVICON_MAX_BYTES * 64;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE: readonly number[] = createCrc32Table();

function createCrc32Table(): readonly number[] {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return Object.freeze(table);
}

export function faviconCrc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function invalid(message: string): never {
  throw new BookmarkFaviconImageError(message);
}

function readBe16(bytes: Buffer, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readBe32(bytes: Buffer, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readLe16(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readLe24(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readLe32(bytes: Buffer, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function assertDimension(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1
    || width > FAVICON_MAX_IMAGE_DIMENSION || height > FAVICON_MAX_IMAGE_DIMENSION) {
    invalid('favicon image dimensions are outside the accepted range');
  }
}

function decodePng(body: Buffer, maxDecompressedBytes: number): DecodedFaviconImage {
  if (body.byteLength < 8 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) invalid('PNG signature missing');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawIhdr = false;
  let sawIend = false;
  const idatChunks: Buffer[] = [];
  let idatTotal = 0;
  while (offset + 8 <= body.byteLength) {
    const length = readBe32(body, offset);
    const type = body.subarray(offset + 4, offset + 8).toString('latin1');
    const dataOffset = offset + 8;
    const endOffset = dataOffset + length;
    if (endOffset > body.byteLength) invalid('PNG chunk exceeds the file bounds');
    const computedCrc = faviconCrc32(Buffer.concat([body.subarray(offset + 4, offset + 8), body.subarray(dataOffset, endOffset)]));
    const declaredCrc = readBe32(body, endOffset);
    if (computedCrc !== declaredCrc) invalid('PNG chunk CRC mismatch');
    if (type === 'IHDR') {
      if (sawIhdr || length !== 13) invalid('PNG IHDR malformed');
      sawIhdr = true;
      width = readBe32(body, dataOffset);
      height = readBe32(body, dataOffset + 4);
      bitDepth = body[dataOffset + 8]!;
      colorType = body[dataOffset + 9]!;
      const compression = body[dataOffset + 10]!;
      const filter = body[dataOffset + 11]!;
      const interlace = body[dataOffset + 12]!;
      if (compression !== 0 || filter !== 0 || interlace !== 0) invalid('PNG uses unsupported encoding');
      if (![1, 2, 4, 8, 16].includes(bitDepth)) invalid('PNG bit depth unsupported');
      if (![0, 2, 3, 4, 6].includes(colorType)) invalid('PNG color type unsupported');
      assertDimension(width, height);
    } else if (type === 'IDAT') {
      if (!sawIhdr || sawIend) invalid('PNG IDAT outside the data stream');
      if (length > 0) {
        idatChunks.push(body.subarray(dataOffset, endOffset));
        idatTotal += length;
        if (idatTotal > BOOKMARK_FAVICON_MAX_BYTES * 4) invalid('PNG compressed data too large');
      }
    } else if (type === 'IEND') {
      sawIend = true;
    }
    offset = endOffset + 4;
  }
  if (!sawIhdr || !sawIend || idatChunks.length === 0) invalid('PNG requires IHDR, IDAT and IEND');
  const bitsPerPixel = colorType === 0 ? bitDepth
    : colorType === 2 ? bitDepth * 3
      : colorType === 4 ? bitDepth * 2
        : colorType === 6 ? bitDepth * 4
          : bitDepth; // palette 3
  const bytesPerRow = 1 + Math.ceil((width * bitsPerPixel) / 8);
  const expectedRaw = bytesPerRow * height;
  if (expectedRaw < 1 || expectedRaw > maxDecompressedBytes) invalid('PNG decompressed size exceeds the limit');
  const compressed = Buffer.concat(idatChunks, idatTotal);
  let raw: Buffer;
  try {
    raw = inflateSync(compressed, { maxOutputLength: expectedRaw });
  } catch (error) {
    if (isBufferTooLarge(error)) invalid('PNG decompressed size exceeds the limit');
    invalid('PNG pixel data cannot be inflated');
  }
  if (raw.byteLength !== expectedRaw) invalid('PNG pixel data length mismatch');
  return { mime: 'image/png', width, height };
}

function isBufferTooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

function decodeJpeg(body: Buffer): DecodedFaviconImage {
  if (body.byteLength < 4 || body[0] !== 0xff || body[1] !== 0xd8) invalid('JPEG SOI missing');
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let endedWithEoi = false;
  while (offset + 2 <= body.byteLength) {
    if (body[offset] !== 0xff) invalid('JPEG stray byte between markers');
    const marker = body[offset + 1]!;
    if (marker === 0xff) {
      // Standalone padding 0xFF runs are legal in JPEG streams.
      offset += 1;
      continue;
    }
    if (marker === 0xd9) {
      if (offset + 2 !== body.byteLength) invalid('JPEG EOI not at the end of the file');
      endedWithEoi = true;
      break;
    }
    const length = readBe16(body, offset + 2);
    if (length < 2 || offset + 2 + length > body.byteLength) invalid('JPEG segment length out of bounds');
    if (marker === 0xda) {
      // Entropy-coded scan: skip the SOS header, then jump to the EOI marker
      // while honoring byte stuffing (FF 00), restart markers (FF D0-D7) and
      // padding (FF FF). Anything else inside the scan is corrupt.
      offset += 2 + length;
      let foundEoi = false;
      while (offset + 1 < body.byteLength) {
        if (body[offset] === 0xff) {
          const next = body[offset + 1]!;
          if (next === 0x00) { offset += 2; continue; }
          if (next === 0xd9) { foundEoi = true; break; }
          if (next === 0xff) { offset += 1; continue; }
          if (next >= 0xd0 && next <= 0xd7) { offset += 2; continue; }
          invalid('JPEG unexpected marker inside the scan data');
        }
        offset += 1;
      }
      if (!foundEoi || body[offset] !== 0xff || body[offset + 1] !== 0xd9) {
        invalid('JPEG scan data missing EOI');
      }
      if (offset + 2 !== body.byteLength) invalid('JPEG EOI not at the end of the file');
      endedWithEoi = true;
      break;
    }
    if (isJpegSofMarker(marker)) {
      if (length < 7) invalid('JPEG SOF segment too short');
      const samplePrecision = body[offset + 4]!;
      const h = readBe16(body, offset + 5);
      const w = readBe16(body, offset + 7);
      if (samplePrecision !== 8) invalid('JPEG sample precision unsupported');
      sawSof = true;
      width = w;
      height = h;
      assertDimension(width, height);
    }
    offset += 2 + length;
  }
  if (!sawSof) invalid('JPEG has no image frame');
  if (!endedWithEoi) invalid('JPEG missing EOI');
  return { mime: 'image/jpeg', width, height };
}

function isJpegSofMarker(marker: number): boolean {
  if (marker >= 0xc0 && marker <= 0xc3) return true;
  if (marker >= 0xc5 && marker <= 0xc7) return true;
  if (marker >= 0xc9 && marker <= 0xcb) return true;
  return marker >= 0xcd && marker <= 0xcf;
}

function decodeWebp(body: Buffer): DecodedFaviconImage {
  if (body.byteLength < 12) invalid('WebP header truncated');
  if (body.subarray(0, 4).toString('latin1') !== 'RIFF') invalid('WebP RIFF header missing');
  if (body.subarray(8, 12).toString('latin1') !== 'WEBP') invalid('WebP signature missing');
  const riffSize = readLe32(body, 4);
  if (riffSize < 4 || 8 + riffSize > body.byteLength) invalid('WebP RIFF size out of bounds');
  let offset = 12;
  let width = 0;
  let height = 0;
  let sawImage = false;
  while (offset + 8 <= Math.min(body.byteLength, 8 + riffSize)) {
    const tag = body.subarray(offset, offset + 4).toString('latin1');
    const size = readLe32(body, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > Math.min(body.byteLength, 8 + riffSize)) invalid('WebP chunk out of bounds');
    if (tag === 'VP8 ') {
      const data = body.subarray(dataOffset, dataOffset + size);
      // Standard lossy WebP (RFC 6386 §9.1/§9.5): the VP8 chunk payload
      // starts with the 3-byte frame tag, then the 0x9d 0x01 0x2a start
      // code, then 14-bit little-endian width/height. Files written by the
      // reference libwebp encoder always carry the frame tag, so the start
      // code is checked at offset 3, never at offset 0.
      if (size < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
        invalid('WebP VP8 frame header invalid');
      }
      width = readLe16(data, 6) & 0x3fff;
      height = readLe16(data, 8) & 0x3fff;
      assertDimension(width, height);
      sawImage = true;
    } else if (tag === 'VP8L') {
      const data = body.subarray(dataOffset, dataOffset + size);
      if (size < 5 || data[0] !== 0x2f) invalid('WebP VP8L header invalid');
      const bits = readLe32(data, 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      assertDimension(width, height);
      sawImage = true;
    } else if (tag === 'VP8X') {
      const data = body.subarray(dataOffset, dataOffset + size);
      if (size < 10) invalid('WebP VP8X header truncated');
      width = readLe24(data, 4) + 1;
      height = readLe24(data, 7) + 1;
      assertDimension(width, height);
    }
    offset = dataOffset + size + (size % 2);
  }
  if (!sawImage) invalid('WebP has no image chunk');
  return { mime: 'image/webp', width, height };
}

/** ICO is a small set of icon sizes, never an unbounded collection of images. */
const ICO_MAX_ENTRIES = 16;

function decodeIco(body: Buffer, maxDecompressedBytes: number): DecodedFaviconImage {
  if (body.byteLength < 6 || body[0] !== 0x00 || body[1] !== 0x00
      || body[2] !== 0x01 || body[3] !== 0x00) {
    invalid('ICO header invalid');
  }
  const count = readLe16(body, 4);
  const directoryEnd = 6 + count * 16;
  if (count < 1 || count > ICO_MAX_ENTRIES || directoryEnd > body.byteLength) invalid('ICO entry count out of bounds');
  const entries: Array<{ width: number; height: number; start: number; end: number; budget: number }> = [];
  let remaining = Math.min(maxDecompressedBytes, FAVICON_DEFAULT_MAX_DECOMPRESSED_BYTES);
  // Validate all ranges and charge a conservative 16-bit RGBA pixel budget
  // before decoding anything. Aliases and overlaps must not multiply work.
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = body[offset]! || 256;
    const height = body[offset + 1]! || 256;
    const size = readLe32(body, offset + 8);
    const start = readLe32(body, offset + 12);
    const end = start + size;
    if (size === 0 || start < directoryEnd || end > body.byteLength) invalid('ICO payload out of bounds');
    if (entries.some((entry) => start < entry.end && end > entry.start)) invalid('ICO payloads overlap');
    const budget = (1 + width * 8) * height;
    remaining -= budget;
    if (remaining < 0) invalid('ICO cumulative decoded size exceeds the limit');
    entries.push({ width, height, start, end, budget });
  }
  for (const entry of entries) {
    decodeEmbeddedIcoPayload(body.subarray(entry.start, entry.end), entry.width, entry.height, entry.budget);
  }
  return { mime: 'image/x-icon', width: Math.max(...entries.map((entry) => entry.width)),
    height: Math.max(...entries.map((entry) => entry.height)) };
}

function decodeEmbeddedIcoPayload(payload: Buffer, width: number, height: number, budget: number): void {
  if (payload.byteLength >= 8 && payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // Check the embedded dimensions before inflation; directory bytes alone
    // cannot bound a PNG that claims a much larger pixel stream.
    if (payload.byteLength < 24 || payload.subarray(12, 16).toString('ascii') !== 'IHDR'
      || readBe32(payload, 16) !== width || readBe32(payload, 20) !== height) {
      invalid('ICO embedded PNG dimensions do not match the directory');
    }
    decodePng(payload, budget);
    return;
  }
  if (payload.byteLength < 26 || payload.subarray(0, 2).toString('latin1') !== 'BM') invalid('ICO payload is not a decodable image');
  const headerSize = readLe32(payload, 14);
  if (headerSize < 40 || payload.byteLength < 14 + headerSize) invalid('ICO BMP header invalid');
  const bmpWidth = readLe32(payload, 18);
  const bmpHeight = readLe32(payload, 22);
  if (bmpWidth !== width || (bmpHeight !== height && bmpHeight !== height * 2)) {
    invalid('ICO embedded BMP dimensions do not match the directory');
  }
}

/**
 * Sniff + structurally decode a fetched favicon body. `maxBytes` is the
 * wire/object cap and `maxDecompressedBytes` bounds the PNG pixel stream.
 * Throws `BookmarkFaviconImageError` for anything that is not a fully
 * decodable canonical raster.
 */
export function decodeFaviconImage(
  body: Buffer,
  maxBytes = BOOKMARK_FAVICON_MAX_BYTES,
  maxDecompressedBytes = FAVICON_DEFAULT_MAX_DECOMPRESSED_BYTES,
): DecodedFaviconImage {
  if (!Buffer.isBuffer(body) || body.byteLength === 0) invalid('favicon body is empty');
  if (body.byteLength > maxBytes) invalid(`favicon image must be at most ${maxBytes} bytes`);
  const mime = sniffBookmarkFaviconCanonicalMime(body);
  if (mime === null) invalid('favicon body is not a supported raster type');
  switch (mime) {
    case 'image/png':
      return decodePng(body, maxDecompressedBytes);
    case 'image/jpeg':
      return decodeJpeg(body);
    case 'image/webp':
      return decodeWebp(body);
    case 'image/x-icon':
      return decodeIco(body, maxDecompressedBytes);
  }
}