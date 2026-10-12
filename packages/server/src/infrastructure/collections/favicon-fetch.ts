/**
 * FO-02 favicon single-fetch transport: hardened egress + favicon constraints.
 *
 * Produces a fully decoded canonical raster from one fetch (no cookies, no
 * Authorization, only the favicon User-Agent):
 *
 * - every hop (initial + each redirect) is re-validated and pinned by hardened
 *   egress, so DNS rebinding and redirect escapes fail closed;
 * - the body is stream-capped at the caller's object-byte limit;
 * - HTTP content-encoding has a fixed layer budget and every layer's output
 *   must fit the object-byte limit, NOT the larger decompressed-pixel budget;
 * - the raster is structurally decoded under the separate pixel budget;
 * - a timeout aborts the whole exchange.
 */
import { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { boundedContentEncodingLayers } from './content-encoding-budget.js';
import {
  FaviconFetchError,
  FaviconProviderThrottled,
  type FaviconFetchedImage,
} from '../../modules/collections/index.js';
import {
  createHardenedEgressFetch,
  HardenedEgressError,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../egress/index.js';
import {
  FAVICON_FETCH_USER_AGENT,
  FAVICON_MAX_DECOMPRESSED_RATIO,
  classifyFaviconFetchFailure,
  decodeFaviconImage,
  sniffBookmarkFaviconCanonicalMime,
  isFaviconFetchSuccessStatus,
  readFaviconBodyCapped,
} from '../../modules/collections/index.js';

export interface FaviconFetchInput {
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxRedirects: number;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  readonly signal?: AbortSignal;
  /** Defaults to FAVICON_FETCH_USER_AGENT; link previews identify themselves. */
  readonly userAgent?: string;
  /** Preview callers reject ICO before any embedded image is decoded. Defaults to true. */
  readonly allowIco?: boolean;
}

export type FaviconFetch = (input: FaviconFetchInput) => Promise<FaviconFetchedImage>;

function nodeReadableFromBody(body: ReadableStream<Uint8Array> | null): Readable | null {
  if (body === null) return null;
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
}

function isTooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';
}

function isBookmarkImageError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'BookmarkFaviconImageError';
}

/**
 * Inflate HTTP content-encoding under the supplied transfer-byte budget.
 * The caller must not pass its raster/pixel budget here.
 */
export function inflateFaviconEncoding(
  body: Buffer,
  contentEncoding: string | null,
  maxDecompressedBytes: number,
): Buffer {
  let codings: string[];
  try { codings = boundedContentEncodingLayers(contentEncoding); }
  catch {
    throw new FaviconFetchError('invalid_image', 'favicon content-encoding is not supported or exceeds the decoding budget');
  }
  if (codings.length === 0) return body;
  let current = body;
  for (const coding of codings.reverse()) {
    try {
      switch (coding) {
        case 'gzip':
        case 'x-gzip':
          current = gunzipSync(current, { maxOutputLength: maxDecompressedBytes });
          break;
        case 'deflate':
          try {
            current = inflateSync(current, { maxOutputLength: maxDecompressedBytes });
          } catch (error) {
            if (isTooLarge(error)) throw error;
            current = inflateRawSync(current, { maxOutputLength: maxDecompressedBytes });
          }
          break;
        case 'br':
          current = brotliDecompressSync(current, { maxOutputLength: maxDecompressedBytes });
          break;
        default:
          throw new FaviconFetchError(
            'invalid_image',
            `favicon content-encoding ${coding} is not supported`,
          );
      }
    } catch (error) {
      if (error instanceof FaviconFetchError || error instanceof FaviconProviderThrottled) throw error;
      if (isTooLarge(error)) {
        throw new FaviconFetchError(
          'invalid_image',
          'favicon decompressed body exceeds the size limit',
        );
      }
      throw new FaviconFetchError(
        'invalid_image',
        'favicon content-encoding body could not be inflated',
      );
    }
  }
  if (current.byteLength > maxDecompressedBytes) {
    throw new FaviconFetchError('invalid_image', 'favicon decompressed body exceeds the size limit');
  }
  return current;
}

/** Default raster/pixel budget: 64× the object-byte cap. Not an HTTP decoding budget. */
export function defaultFaviconDecompressedBudget(maxBytes: number): number {
  return maxBytes * FAVICON_MAX_DECOMPRESSED_RATIO;
}

/**
 * Fetch + decode one favicon through hardened egress. Throws:
 * - `FaviconFetchError('unsafe_source')` for egress denials (URL policy, DNS,
 *   address, redirect target);
 * - `FaviconFetchError('fetch_failed')` for timeouts / transport / non-2xx;
 * - `FaviconFetchError('invalid_image')` for size, encoding or decode failure.
 */
export async function fetchFaviconImage(
  input: FaviconFetchInput,
): Promise<FaviconFetchedImage> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The favicon fetch timed out.', 'AbortError')),
    input.timeoutMs,
  );
  timer.unref?.();
  const abortFromCaller = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromCaller();
  input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const fetch = createHardenedEgressFetch({
      resolve: input.resolve,
      connect: input.connect,
      maxRedirects: input.maxRedirects,
      label: 'favicon fetch',
    });
    const response = await fetch(input.url, {
      headers: { 'user-agent': input.userAgent ?? FAVICON_FETCH_USER_AGENT },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status === 429) {
      await response.body?.cancel();
      throw new FaviconProviderThrottled(response.headers.get('retry-after'));
    }
    if (!isFaviconFetchSuccessStatus(response.status)) {
      await response.body?.cancel();
      throw new FaviconFetchError(
        'fetch_failed',
        `favicon provider answered with HTTP ${response.status}`,
      );
    }
    const stream = nodeReadableFromBody(response.body);
    if (stream === null) {
      throw new FaviconFetchError('invalid_image', 'favicon provider returned an empty body');
    }
    const capped = await readFaviconBodyCapped(stream, input.maxBytes);
    if (capped === null) {
      throw new FaviconFetchError(
        'invalid_image',
        `favicon body exceeds the ${input.maxBytes} byte limit or is empty`,
      );
    }
    const body = inflateFaviconEncoding(
      capped,
      response.headers.get('content-encoding'),
      input.maxBytes,
    );
    if (input.allowIco === false && sniffBookmarkFaviconCanonicalMime(body) === 'image/x-icon') {
      throw new FaviconFetchError('invalid_image', 'ICO images are not allowed for this caller');
    }
    const decoded = decodeFaviconImage(body, input.maxBytes, input.maxDecompressedBytes);
    return { body, mime: decoded.mime, width: decoded.width, height: decoded.height };
  } catch (error) {
    if (error instanceof FaviconFetchError || error instanceof FaviconProviderThrottled) throw error;
    if (error instanceof HardenedEgressError) {
      throw new FaviconFetchError(
        classifyFaviconFetchFailure(error),
        'favicon egress target was refused',
      );
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FaviconFetchError('fetch_failed', 'favicon fetch timed out');
    }
    if (isBookmarkImageError(error)) {
      throw new FaviconFetchError('invalid_image', 'favicon body is not a decodable image');
    }
    throw new FaviconFetchError(
      classifyFaviconFetchFailure(error),
      'favicon fetch failed',
    );
  } finally {
    input.signal?.removeEventListener('abort', abortFromCaller);
    clearTimeout(timer);
  }
}
