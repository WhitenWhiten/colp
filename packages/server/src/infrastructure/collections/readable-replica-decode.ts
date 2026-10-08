/**
 * Readable-replica body decoding: bounded content-encoding inflation
 * (gzip / deflate / br) followed by charset detection (Content-Type first,
 * then BOM, then <meta charset> sniffed from the first 2 KiB, else UTF-8).
 * The production egress connector is node:https, which never decompresses,
 * so compressed bodies must be inflated here under the same byte cap.
 */
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { boundedContentEncodingLayers } from './content-encoding-budget.js';

export class ReadableReplicaBodyTooLargeError extends Error {
  constructor() {
    super('readable replica body exceeds the configured limit');
    this.name = 'ReadableReplicaBodyTooLargeError';
  }
}

export class ReadableReplicaBodyEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadableReplicaBodyEncodingError';
  }
}

export interface DecodeReadableReplicaBodyInput {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly maxBytes: number;
}

const META_SNIFF_BYTES = 2048;
const CHARSET_PARAM = /;\s*charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/iu;
const META_CHARSET = /<meta[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/iu;

export function decodeReadableReplicaBody(input: DecodeReadableReplicaBodyInput): string {
  if (input.bytes.byteLength > input.maxBytes) throw new ReadableReplicaBodyTooLargeError();
  const inflated = inflateBody(input.bytes, input.contentEncoding, input.maxBytes);
  if (inflated.byteLength > input.maxBytes) throw new ReadableReplicaBodyTooLargeError();
  const label = charsetFromContentType(input.contentType)
    ?? charsetFromBom(inflated)
    ?? charsetFromMeta(inflated);
  return createDecoder(label).decode(inflated);
}

function inflateBody(bytes: Uint8Array, contentEncoding: string | null, maxBytes: number): Uint8Array {
  let codings: string[];
  try { codings = boundedContentEncodingLayers(contentEncoding); }
  catch {
    throw new ReadableReplicaBodyEncodingError('content-encoding is unsupported or exceeds the decoding budget');
  }
  let current: Uint8Array = bytes;
  // At most two layers, each output capped at maxBytes. Raw-deflate fallback
  // is also bounded, so no header can request unbounded cumulative work.
  for (const coding of codings.reverse()) {
    current = inflateOnce(current, coding, maxBytes);
  }
  return current;
}

function inflateOnce(bytes: Uint8Array, coding: string, maxBytes: number): Uint8Array {
  const options = { maxOutputLength: maxBytes };
  try {
    switch (coding) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(bytes, options);
      case 'deflate':
        try {
          return inflateSync(bytes, options);
        } catch (error: unknown) {
          if (isTooLarge(error)) throw error;
          return inflateRawSync(bytes, options); // some origins send raw deflate
        }
      case 'br':
        return brotliDecompressSync(bytes, options);
      default:
        throw new ReadableReplicaBodyEncodingError(`unsupported content-encoding ${coding}`);
    }
  } catch (error: unknown) {
    if (isTooLarge(error)) throw new ReadableReplicaBodyTooLargeError();
    if (error instanceof ReadableReplicaBodyEncodingError) throw error;
    throw new ReadableReplicaBodyEncodingError(`content-encoding ${coding} body could not be inflated`);
  }
}

function isTooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

export function charsetFromContentType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const match = CHARSET_PARAM.exec(contentType);
  return match?.[1] ?? null;
}

export function charsetFromBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

export function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, META_SNIFF_BYTES));
  const label = META_CHARSET.exec(head)?.[1] ?? null;
  // An ASCII-readable <meta> claiming UTF-16 is wrong by construction (HTML spec: treat as UTF-8).
  if (label !== null && /^utf-?16/iu.test(label)) return 'utf-8';
  return label;
}

/** Unknown or replacement-only labels fall back to UTF-8 instead of throwing. */
export function createDecoder(label: string | null): TextDecoder {
  if (label === null) return new TextDecoder();
  try {
    const decoder = new TextDecoder(label);
    if (decoder.encoding === 'replacement') return new TextDecoder();
    return decoder;
  } catch {
    return new TextDecoder();
  }
}
