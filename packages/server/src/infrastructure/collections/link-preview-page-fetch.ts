/**
 * LP-03 page fetch for link previews: one HTTPS GET through hardened egress
 * (every redirect hop re-validated), only as much of the document as the
 * head needs. An unencoded body is cut at `maxBodyBytes`; an encoded body
 * cannot be cut safely, so it must inflate within the same budget.
 */
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import {
  createHardenedEgressFetch,
  HardenedEgressError,
  type HardenedEgressConnector,
  type HardenedEgressResolver,
} from '../egress/index.js';
import { settleBestEffort } from '../async/best-effort.js';
import { boundedContentEncodingLayers } from './content-encoding-budget.js';
import { wrapConnectRecordingHops } from './link-health-probe.js';

export const LINK_PREVIEW_PAGE_MAX_REDIRECTS = 5;
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9';
const ACCEPT_LANGUAGE = 'en,zh;q=0.8,*;q=0.5';

/** `not_html`, `too_large`, `denied` and `invalid_url` cannot improve on a retry. */
export type LinkPreviewPageFailure = 'not_html' | 'too_large' | 'denied' | 'invalid_url' | 'http' | 'dns' | 'timeout';

export type LinkPreviewPageResult =
  | { readonly kind: 'html'; readonly html: string; readonly hopUrls: readonly string[] }
  | { readonly kind: 'failure'; readonly failureCode: LinkPreviewPageFailure };

export interface FetchLinkPreviewPageOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly userAgent: string;
  readonly resolve?: HardenedEgressResolver;
  readonly connect?: HardenedEgressConnector;
  readonly signal?: AbortSignal;
}

class PageTooLargeError extends Error {}

export async function fetchLinkPreviewPage(options: FetchLinkPreviewPageOptions): Promise<LinkPreviewPageResult> {
  const hopUrls: string[] = [];
  const outer = new AbortController();
  const timer = setTimeout(() => outer.abort(), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([outer.signal, options.signal]) : outer.signal;
  try {
    const fetchImpl = createHardenedEgressFetch({
      ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      connect: wrapConnectRecordingHops(options.connect, hopUrls, options.connectTimeoutMs, signal),
      maxRedirects: LINK_PREVIEW_PAGE_MAX_REDIRECTS,
      label: 'link preview page',
    });
    const response = await fetchImpl(options.url, {
      method: 'GET',
      headers: {
        'user-agent': options.userAgent,
        accept: ACCEPT,
        'accept-language': ACCEPT_LANGUAGE,
        'accept-encoding': 'identity',
      },
      signal,
      redirect: 'manual',
    });
    const contentType = response.headers.get('content-type');
    if (response.status < 200 || response.status >= 300 || !isHtml(contentType)) {
      if (response.body) {
        await settleBestEffort(response.body.cancel(),
          'the status or media type decides the result and body teardown is secondary');
      }
      return { kind: 'failure', failureCode: response.status >= 200 && response.status < 300 ? 'not_html' : 'http' };
    }
    const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
    const encoded = encoding !== '' && encoding !== 'identity';
    const raw = await readBounded(response, options.maxBodyBytes, !encoded);
    const bytes = encoded ? inflate(raw, encoding, options.maxBodyBytes) : raw;
    return { kind: 'html', html: decode(bytes, contentType), hopUrls: Object.freeze([...hopUrls]) };
  } catch (error: unknown) {
    return { kind: 'failure', failureCode: failureOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

function isHtml(value: string | null): boolean {
  const media = (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return media === 'text/html' || media === 'application/xhtml+xml';
}

function failureOf(error: unknown): LinkPreviewPageFailure {
  if (error instanceof PageTooLargeError) return 'too_large';
  if (error instanceof HardenedEgressError) {
    if (error.reason === 'denied' || error.reason === 'denied_address') return 'denied';
    if (error.reason === 'dns_failure') return 'dns';
    if (error.reason === 'invalid_url') return 'invalid_url';
    return 'http';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  return 'http';
}

async function readBounded(response: Response, maxBytes: number, truncate: boolean): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (total + next.value.byteLength > maxBytes) {
        await settleBestEffort(reader.cancel(), 'the byte cap decides the result and body teardown is secondary');
        if (!truncate) throw new PageTooLargeError();
        chunks.push(next.value.subarray(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function inflate(body: Buffer, contentEncoding: string, maxBytes: number): Buffer {
  let layers: string[];
  try {
    layers = boundedContentEncodingLayers(contentEncoding);
  } catch {
    throw new PageTooLargeError();
  }
  let current = body;
  for (const coding of layers.reverse()) {
    try {
      if (coding === 'gzip' || coding === 'x-gzip') current = gunzipSync(current, { maxOutputLength: maxBytes });
      else if (coding === 'br') current = brotliDecompressSync(current, { maxOutputLength: maxBytes });
      else if (coding === 'deflate') {
        try {
          current = inflateSync(current, { maxOutputLength: maxBytes });
        } catch {
          current = inflateRawSync(current, { maxOutputLength: maxBytes });
        }
      } else throw new PageTooLargeError();
    } catch {
      throw new PageTooLargeError();
    }
  }
  return current;
}

/** Header charset, else a `<meta charset>` near the top, else UTF-8. */
function decode(bytes: Buffer, contentType: string | null): string {
  const declared = /charset\s*=\s*"?([\w.:-]+)/iu.exec(contentType ?? '')?.[1]
    ?? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/iu.exec(bytes.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
